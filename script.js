/* 邏輯結構：
    1. AudioEngine: 處理錄音、Blob轉換、ArrayBuffer解碼、反轉處理。
    2. GameState: 管理回合、分數、當前狀態。
    3. UIController: DOM操作、事件監聽、頁面切換。
*/

class AudioEngine {
    constructor() {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        this.mediaRecorder = null;
        this.chunks = [];
    }

    async requestPermission() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.mediaRecorder = new MediaRecorder(stream);
            
            this.mediaRecorder.ondataavailable = (e) => this.chunks.push(e.data);
            return true;
        } catch (err) {
            console.error("Microphone access denied:", err);
            alert("遊戲需要麥克風權限才能進行錄音！");
            return false;
        }
    }

    startRecording() {
        if (!this.mediaRecorder) return;
        this.chunks = [];
        this.mediaRecorder.start();
    }

    stopRecording() {
        return new Promise((resolve) => {
            if (!this.mediaRecorder) return resolve(null);
            this.mediaRecorder.onstop = () => {
                const blob = new Blob(this.chunks, { type: 'audio/ogg; codecs=opus' });
                resolve(blob);
            };
            this.mediaRecorder.stop();
        });
    }

    async playReversed(blob) {
        if (!blob) return;
        
        // 1. 將 Blob 轉為 ArrayBuffer
        const arrayBuffer = await blob.arrayBuffer();
        
        // 2. 解碼音頻數據
        const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
        
        // 3. 創建反轉的 Buffer
        const reversedBuffer = this.audioCtx.createBuffer(
            audioBuffer.numberOfChannels,
            audioBuffer.length,
            audioBuffer.sampleRate
        );

        for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
            const originalData = audioBuffer.getChannelData(i);
            const reversedData = reversedBuffer.getChannelData(i);
            // 複製並反轉
            for (let j = 0; j < audioBuffer.length; j++) {
                reversedData[j] = originalData[audioBuffer.length - 1 - j];
            }
        }

        // 4. 播放
        const source = this.audioCtx.createBufferSource();
        source.buffer = reversedBuffer;
        source.connect(this.audioCtx.destination);
        source.start();
        return source; // 返回 source 以便能在 UI 上做播放狀態控制
    }
}

class Game {
    constructor() {
        this.audioEngine = new AudioEngine();
        
        this.config = {
            totalRounds: 5,
            maxAttempts: 5
        };

        this.state = {
            round: 1,
            attempts: 0,
            turnPlayer: 'A', // 'A' or 'B'
            phase: 'SETUP', // SETUP, RECORD_CHALLENGE, CONFIRM_CHALLENGE, GUESSING, END
            history: [],
            currentChallengeAudio: null,
            currentMimicAudio: null,
            players: {
                A: { name: 'Player A', color: 'var(--p1-primary)', score: 0 },
                B: { name: 'Player B', color: 'var(--p2-primary)', score: 0 }
            }
        };

        this.ui = {
            setupView: document.getElementById('setup-view'),
            gameView: document.getElementById('game-view'),
            startBtn: document.getElementById('start-game-btn'),
            recordBtn: document.getElementById('record-btn'),
            statusText: document.getElementById('status-text'),
            confirmBtn: document.getElementById('confirm-challenge-btn'),
            playChallengeBtn: document.getElementById('play-challenge-btn'),
            playMimicBtn: document.getElementById('play-mimic-btn'),
            playbackControl: document.getElementById('playback-control'),
            mimicZone: document.getElementById('mimic-zone'),
            judgeControls: document.getElementById('judge-controls'),
            failBtn: document.getElementById('fail-btn'),
            successBtn: document.getElementById('success-btn'),
            historyModal: document.getElementById('history-modal'),
            historyList: document.getElementById('history-list'),
            overlay: document.getElementById('overlay-msg')
        };

        this.initEvents();
    }

    initEvents() {
        // 開始遊戲
        this.ui.startBtn.addEventListener('click', async () => {
            const allowed = await this.audioEngine.requestPermission();
            if (allowed) {
                this.state.players.A.name = document.getElementById('p1-name').value || 'Player A';
                this.state.players.B.name = document.getElementById('p2-name').value || 'Player B';
                this.startGame();
            }
        });

        // 錄音邏輯 (手機與鼠標兼容)
        const startRec = (e) => {
            e.preventDefault();
            
            const allowedPhases = ['RECORD_CHALLENGE', 'CONFIRM_CHALLENGE', 'GUESSING'];
            if (!allowedPhases.includes(this.state.phase)) return;

            this.ui.recordBtn.classList.add('recording');
            this.audioEngine.startRecording();
        };

        const stopRec = async (e) => {
            e.preventDefault();
            if (!this.ui.recordBtn.classList.contains('recording')) return;
            
            this.ui.recordBtn.classList.remove('recording');
            const blob = await this.audioEngine.stopRecording();
            
            if (this.state.phase === 'RECORD_CHALLENGE' || this.state.phase === 'CONFIRM_CHALLENGE') {
                this.state.currentChallengeAudio = blob;
                
                this.ui.statusText.textContent = "已更新錄音！點擊播放試聽，或再次錄音覆蓋";
                
                if (this.state.phase === 'RECORD_CHALLENGE') {
                    this.setPhase('CONFIRM_CHALLENGE');
                }
            } 
            else if (this.state.phase === 'GUESSING') {
                this.state.currentMimicAudio = blob;
                this.ui.playMimicBtn.disabled = false;
                this.ui.playMimicBtn.textContent = "▶ 播放我的倒放";
                this.ui.statusText.textContent = "模仿錄製完成，點擊播放檢查";
            }
        };

        ['mousedown', 'touchstart'].forEach(evt => this.ui.recordBtn.addEventListener(evt, startRec));
        ['mouseup', 'mouseleave', 'touchend'].forEach(evt => this.ui.recordBtn.addEventListener(evt, stopRec));

        // 確認題目
        this.ui.confirmBtn.addEventListener('click', () => {
            this.setPhase('GUESSING');
        });

        // 播放控制
        this.ui.playChallengeBtn.addEventListener('click', () => this.playAudio(this.state.currentChallengeAudio, this.ui.playChallengeBtn));
        this.ui.playMimicBtn.addEventListener('click', () => this.playAudio(this.state.currentMimicAudio, this.ui.playMimicBtn));

        // 判定
        this.ui.failBtn.addEventListener('click', () => this.handleJudge(false));
        this.ui.successBtn.addEventListener('click', () => this.handleJudge(true));

        // 歷史記錄
        document.getElementById('history-btn').addEventListener('click', () => this.ui.historyModal.classList.add('open'));
        document.getElementById('close-history').addEventListener('click', () => this.ui.historyModal.classList.remove('open'));
    }

    async playAudio(blob, btnElement) {
        if (!blob) return;
        btnElement.classList.add('playing');
        btnElement.disabled = true;
        
        try {
            const source = await this.audioEngine.playReversed(blob);
            source.onended = () => {
                btnElement.classList.remove('playing');
                btnElement.disabled = false;
            };
        } catch (e) {
            console.error(e);
            btnElement.classList.remove('playing');
            btnElement.disabled = false;
        }
    }

    startGame() {
        this.ui.setupView.classList.remove('active');
        this.ui.gameView.classList.add('active');
        this.startRound();
    }

    startRound() {
        // 重置回合數據
        this.state.attempts = 0;
        this.state.currentChallengeAudio = null;
        this.state.currentMimicAudio = null;
        
        // 判斷出題者
        // 奇數回合: Player A 出題, B 猜
        // 偶數回合: Player B 出題, A 猜
        this.state.turnPlayer = (this.state.round % 2 !== 0) ? 'A' : 'B';
        
        this.updateTheme();
        this.setPhase('RECORD_CHALLENGE');
        this.updateHeader();
    }

    setPhase(phase) {
        this.state.phase = phase;
        
        // 隱藏所有動態區域
        this.ui.playbackControl.classList.add('hidden');
        this.ui.confirmBtn.classList.add('hidden');
        this.ui.mimicZone.classList.add('hidden');
        this.ui.judgeControls.classList.add('hidden');
        this.ui.playMimicBtn.disabled = true;
        this.ui.playMimicBtn.textContent = "無錄音";

        const challenger = this.state.players[this.state.turnPlayer].name;
        const guesser = this.state.players[this.state.turnPlayer === 'A' ? 'B' : 'A'].name;

        switch(phase) {
            case 'RECORD_CHALLENGE':
                this.ui.statusText.textContent = `🎤 ${challenger} 請錄製題目 (按住按鈕)`;
                this.ui.recordBtn.style.display = 'block';
                break;
            
            case 'CONFIRM_CHALLENGE':
                this.ui.statusText.textContent = `確認題目嗎？可點播放試聽倒放效果`;
                this.ui.playbackControl.classList.remove('hidden');
                this.ui.confirmBtn.classList.remove('hidden');
                this.ui.recordBtn.style.display = 'block'; // 允許重錄
                break;

            case 'GUESSING':
                // 切換主題色給答題者
                this.updateTheme(true); 
                this.ui.statusText.textContent = `🎧 ${guesser} 請聽題目並模仿錄音`;
                
                this.ui.playbackControl.classList.remove('hidden');
                this.ui.mimicZone.classList.remove('hidden');
                this.ui.judgeControls.classList.remove('hidden');
                
                this.ui.recordBtn.style.display = 'block';
                document.getElementById('attempts-left').textContent = this.config.maxAttempts - this.state.attempts;
                break;
        }
    }

    handleJudge(isSuccess) {
        const guesserKey = this.state.turnPlayer === 'A' ? 'B' : 'A';
        const guesserName = this.state.players[guesserKey].name;

        if (isSuccess) {
            // 成功邏輯
            const score = (this.config.maxAttempts - this.state.attempts) * 10;
            this.state.players[guesserKey].score += score;
            this.endRound(true, score);
        } else {
            // 失敗邏輯
            this.state.attempts++;
            document.getElementById('attempts-left').textContent = this.config.maxAttempts - this.state.attempts;
            
            if (this.state.attempts >= this.config.maxAttempts) {
                this.endRound(false, 0);
            } else {
                this.showOverlay(`❌ 錯誤！還剩 ${this.config.maxAttempts - this.state.attempts} 次機會`, 1000);
            }
        }
    }

    endRound(success, score) {
        const challenger = this.state.players[this.state.turnPlayer].name;
        const guesser = this.state.players[this.state.turnPlayer === 'A' ? 'B' : 'A'].name;
        
        // 記錄歷史
        const log = `R${this.state.round}: ${challenger} ➡ ${guesser} [${success ? '✅' : '❌'}] (${this.state.attempts} fails)`;
        this.state.history.push(log);
        this.updateHistoryUI();

        let msg = success ? `🎉 答對了！ (+${score}分)` : `💀 回合失敗 (答案太難啦)`;
        this.showOverlay(msg, 2000);

        setTimeout(() => {
            if (this.state.round >= this.config.totalRounds) {
                this.endGame();
            } else {
                this.state.round++;
                this.startRound();
            }
        }, 2000);
    }

    endGame() {
        const pA = this.state.players.A;
        const pB = this.state.players.B;
        let winnerText = "";
        if (pA.score > pB.score) winnerText = `${pA.name} 獲勝！`;
        else if (pB.score > pA.score) winnerText = `${pB.name} 獲勝！`;
        else winnerText = "平局！";

        this.showOverlay(`遊戲結束！\n${winnerText}\nA: ${pA.score} | B: ${pB.score}`, 5000);
        
        // 簡單重置 UI 供刷新
        setTimeout(() => location.reload(), 5000);
    }

    updateTheme(isGuesserTurn = false) {
        const root = document.documentElement;
        // 如果現在是出題階段，顏色跟隨出題者
        // 如果是答題階段(GUESSING)，顏色跟隨答題者
        let activePlayerKey = this.state.turnPlayer;
        if (isGuesserTurn) {
            activePlayerKey = this.state.turnPlayer === 'A' ? 'B' : 'A';
        }

        const isA = activePlayerKey === 'A';
        
        root.style.setProperty('--current-primary', isA ? 'var(--p1-primary)' : 'var(--p2-primary)');
        root.style.setProperty('--current-light', isA ? 'var(--p1-light)' : 'var(--p2-light)');
        root.style.setProperty('--current-bg', isA ? 'var(--p1-bg)' : 'var(--p2-bg)');
        
        // 更新圖標
        const icon = isGuesserTurn ? '🎧' : '🎤';
        document.getElementById('role-icon').textContent = icon;
        document.getElementById('player-name-display').textContent = this.state.players[activePlayerKey].name;
    }

    updateHeader() {
        document.getElementById('round-info').textContent = `Round ${this.state.round}/${this.config.totalRounds}`;
    }

    updateHistoryUI() {
        const list = this.ui.historyList;
        list.innerHTML = '';
        this.state.history.forEach(txt => {
            const li = document.createElement('li');
            li.textContent = txt;
            list.appendChild(li);
        });
    }

    showOverlay(text, duration) {
        const overlay = this.ui.overlay;
        const h2 = document.getElementById('overlay-text');
        h2.innerText = text; // 支援換行
        overlay.classList.remove('hidden');
        if (duration) {
            setTimeout(() => overlay.classList.add('hidden'), duration);
        }
    }
}

// 初始化
window.addEventListener('DOMContentLoaded', () => {
    const game = new Game();
});