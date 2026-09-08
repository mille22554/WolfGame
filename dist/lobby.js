/**
 * lobby.ts — 等候大廳純記憶體狀態（server 側唯一資料源，獨立於 GameEngine）。
 *
 * 大廳先於引擎存在：點開始遊戲即進大廳，llama-server/model 在背景啟動，
 * engine 本體延到 START_GAME 才建立。GameState 的 SETUP 轉移原樣重用。
 */
import { randomUUID } from 'node:crypto';
export const MIN_PLAYERS = 6;
export const MAX_PLAYERS = 15;
export const CHAT_LIMIT = 50;
export const CHAT_MAXLEN = 500;
function assertCount(n) {
    if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_PLAYERS) {
        throw new Error(`參與人數必須是 ${MIN_PLAYERS}-${MAX_PLAYERS}，輸入為：${n}`);
    }
}
export class LobbyManager {
    _playerCount;
    seats = [];
    tokens = new Map(); // token → playerId（離座/斷線保留，重連拿回）
    limbo = new Map(); // 離座暫存（座位已空）
    spectators = new Map();
    specSeq = 0;
    chat = [];
    engineStatus = { state: 'idle' };
    _randomCount = false;
    _hostClientId;
    constructor(_playerCount) {
        this._playerCount = _playerCount;
        assertCount(_playerCount);
        this.resetSeats(_playerCount);
    }
    get playerCount() {
        return this._playerCount;
    }
    get randomCount() {
        return this._randomCount;
    }
    get hostClientId() {
        return this._hostClientId;
    }
    setHost(clientId) {
        this._hostClientId = clientId;
    }
    clearHostIf(clientId) {
        if (this._hostClientId === clientId) {
            this._hostClientId = undefined;
            return true;
        }
        return false;
    }
    resetSeats(n) {
        this.seats = [];
        for (let id = 1; id <= n; id++) {
            this.seats.push({ playerId: id, name: '', controlledBy: 'empty' });
        }
    }
    humanCount() {
        return this.seats.filter((s) => s.controlledBy === 'human').length;
    }
    /** 改人數：只增減尾部；縮減時被截的 human 座位→ token 失效（自動變觀戰者）；AI 直接丟棄 */
    setPlayerCount(n) {
        assertCount(n);
        const humans = this.humanCount();
        if (n < humans) {
            throw new Error(`人數不可少於真人座位數（${humans}），輸入為：${n}`);
        }
        const droppedTokens = [];
        if (n < this._playerCount) {
            for (const s of this.seats.splice(n)) {
                if (s.token !== undefined) {
                    this.tokens.delete(s.token);
                    droppedTokens.push(s.token);
                }
            }
        }
        else {
            for (let id = this._playerCount + 1; id <= n; id++) {
                this.seats.push({ playerId: id, name: '', controlledBy: 'empty' });
            }
        }
        this._playerCount = n;
        return { droppedTokens };
    }
    setRandomCount(enabled) {
        this._randomCount = enabled;
    }
    /** 開局人數解析：隨機開啟時在 [max(6, 真人最大座位號), 座位格數] 均勻擲出，否則為座位格數
     *（下限用最大座位號而非真人數：真人坐 14/15 號時擲出 6 會超出新 engine 人數而被排除） */
    resolveCount() {
        if (!this._randomCount)
            return this._playerCount;
        let maxSeat = 0;
        for (const s of this.seats) {
            if (s.controlledBy === 'human' && s.playerId > maxSeat)
                maxSeat = s.playerId;
        }
        const lo = Math.max(MIN_PLAYERS, maxSeat);
        return lo + Math.floor(Math.random() * (this._playerCount - lo + 1));
    }
    /** 入座（空位限定）：佔座＋發 token */
    join(playerId, name) {
        if (!Number.isInteger(playerId) || playerId < 1 || playerId > this._playerCount) {
            throw new Error(`座位必須是 1-${this._playerCount}，輸入為：${playerId}`);
        }
        const seat = this.seats[playerId - 1];
        if (seat.controlledBy !== 'empty') {
            throw new Error(seat.controlledBy === 'ai' ? `座位 P${playerId} 已由 AI 佔用` : `座位 P${playerId} 已有人`);
        }
        const clean = (name ?? '').trim().slice(0, 12);
        seat.controlledBy = 'human';
        seat.name = clean;
        seat.disconnected = false;
        const token = randomUUID();
        seat.token = token;
        this.tokens.set(token, playerId);
        return { token };
    }
    /** 離座→觀戰：座位清空，token＋名字進 limbo（重連可拿回）；tokens 映射同步刪除 */
    leave(playerId) {
        const seat = this.seats[playerId - 1];
        if (!seat || seat.controlledBy !== 'human')
            return;
        if (seat.token !== undefined) {
            this.limbo.set(seat.token, { playerId, name: seat.name });
            this.tokens.delete(seat.token);
        }
        seat.controlledBy = 'empty';
        seat.name = '';
        seat.token = undefined;
        seat.disconnected = false;
    }
    /** 大廳內同 token 重連：斷線座位（human+disconnected）直接拿回；limbo（已離座）座位空才恢復 */
    reclaim(token) {
        const pid = this.tokens.get(token);
        if (pid !== undefined) {
            const seat = this.seats[pid - 1];
            // 歸屬檢查：映射存在但座位 token 不符（陳舊映射）→ 不算拿回
            if (seat && seat.controlledBy === 'human' && seat.token === token) {
                seat.disconnected = false;
                return { playerId: pid };
            }
            return undefined;
        }
        const saved = this.limbo.get(token);
        if (!saved)
            return undefined;
        const seat = this.seats[saved.playerId - 1];
        if (!seat || seat.controlledBy !== 'empty')
            return undefined;
        seat.controlledBy = 'human';
        seat.name = saved.name;
        seat.token = token;
        this.tokens.set(token, saved.playerId);
        this.limbo.delete(token);
        return { playerId: saved.playerId };
    }
    /** 斷線標記（座位保留＋AI 託管；不計入 hasHumanSeats） */
    markDisconnected(playerId) {
        const seat = this.seats[playerId - 1];
        if (seat && seat.controlledBy === 'human')
            seat.disconnected = true;
    }
    lookupToken(token) {
        return this.tokens.get(token);
    }
    /** 座位名（chat 發送者用；空座/AI/不存在回 undefined） */
    seatName(playerId) {
        const seat = this.seats[playerId - 1];
        if (!seat || seat.controlledBy !== 'human' || seat.name === '')
            return undefined;
        return seat.name;
    }
    addSpectator(clientId) {
        const found = this.spectators.get(clientId);
        if (found)
            return found;
        this.specSeq += 1;
        const sp = { clientId, name: `觀眾${this.specSeq}` };
        this.spectators.set(clientId, sp);
        return sp;
    }
    removeSpectator(clientId) {
        this.spectators.delete(clientId);
    }
    addChat(from, text) {
        const clean = text.trim();
        if (clean.length === 0)
            throw new Error('訊息不可為空');
        if (clean.length > CHAT_MAXLEN)
            throw new Error(`訊息過長（上限 ${CHAT_MAXLEN} 字）`);
        const entry = { from, text: clean, ts: Date.now() };
        this.chat.push(entry);
        if (this.chat.length > CHAT_LIMIT)
            this.chat.splice(0, this.chat.length - CHAT_LIMIT);
        return entry;
    }
    setEngineStatus(s) {
        this.engineStatus = s;
    }
    hasHumanSeats() {
        return this.seats.some((s) => s.controlledBy === 'human' && !s.disconnected);
    }
    /** 開局前：空位補 AI（斷線未歸的 human 座位由呼叫端先轉 AI，見 fillDisconnectedAsAi） */
    fillAiSeats() {
        for (const s of this.seats) {
            if (s.controlledBy === 'empty')
                s.controlledBy = 'ai';
        }
    }
    /** 開局時：仍斷線的 human 座位轉 AI（token 失效，重連者進觀戰） */
    fillDisconnectedAsAi() {
        const dead = [];
        for (const s of this.seats) {
            if (s.controlledBy === 'human' && s.disconnected) {
                s.controlledBy = 'ai';
                s.disconnected = false;
                if (s.token !== undefined) {
                    this.tokens.delete(s.token);
                    dead.push(s.token);
                    s.token = undefined;
                }
            }
        }
        return dead;
    }
    /** 開局灌 engine 用（playerId/name/controlledBy 快照） */
    seatsForStart() {
        return this.seats.map((s) => ({
            playerId: s.playerId,
            name: s.name,
            controlledBy: s.controlledBy === 'human' ? 'human' : 'ai',
        }));
    }
    snapshot() {
        return {
            phase: 'SETUP_WAITING_JOIN',
            expectedPlayerCount: this._playerCount,
            seats: this.seats.map((s) => ({ playerId: s.playerId, name: s.name, controlledBy: s.controlledBy, disconnected: s.disconnected })),
            started: false,
            playerCount: this._playerCount,
            randomCount: this._randomCount,
            spectators: [...this.spectators.values()],
            engineStatus: this.engineStatus,
            hostClientId: this._hostClientId,
        };
    }
}
//# sourceMappingURL=lobby.js.map