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
    // token 綁定：穩定鍵（token 優先，否則 clientId）→ 固定編號，remove 後保留，參戰／離席／重連沿用不遞增
    specNumByKey = new Map();
    clientToken = new Map(); // clientId → token（具名觀眾／座位 token）
    customNameByToken = new Map(); // token → 自定暱稱（SET_NAME；server 端唯一來源）
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
    /** 入座（空位限定）：佔座＋發 token；與 SET_NAME 同邏輯查重名（trim、排除自己），重名拒收 */
    join(playerId, name, clientId) {
        if (!Number.isInteger(playerId) || playerId < 1 || playerId > this._playerCount) {
            throw new Error(`座位必須是 1-${this._playerCount}，輸入為：${playerId}`);
        }
        const seat = this.seats[playerId - 1];
        if (seat.controlledBy !== 'empty') {
            throw new Error(seat.controlledBy === 'ai' ? `座位 P${playerId} 已由 AI 佔用` : `座位 P${playerId} 已有人`);
        }
        const clean = (name ?? '').trim().slice(0, 12);
        for (const s of this.seats) {
            if (s.controlledBy === 'human' && s.name !== '' && s.name === clean) {
                throw new Error('名稱已被使用');
            }
        }
        for (const [cid, sp] of this.spectators) {
            if ((clientId === undefined || cid !== clientId) && sp.name === clean) {
                throw new Error('名稱已被使用');
            }
        }
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
    /** 乾淨離開大廳（返回主選單用）：沿用 leave() 釋放座位，再清除該座位 token 的 limbo（同 token 重連拿不回，與斷線保留區隔） */
    leaveLobbySeat(playerId, token) {
        const seat = this.seats[playerId - 1];
        const seatToken = seat && seat.controlledBy === 'human' ? seat.token : undefined;
        this.leave(playerId);
        if (seatToken !== undefined)
            this.limbo.delete(seatToken);
        if (token !== undefined)
            this.limbo.delete(token);
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
    /** 觀眾進場：同穩定鍵沿用固定編號（token 優先）；無名→觀眾N，具名→自定暱稱 */
    addSpectator(clientId, token) {
        const tok = token ?? this.clientToken.get(clientId);
        const found = this.spectators.get(clientId);
        if (found) {
            if (tok !== undefined) {
                // 舊 entry 補上 token 綁定（沿用原編號，不遞增）
                const prev = this.specNumByKey.get(clientId);
                if (prev !== undefined && !this.specNumByKey.has(tok))
                    this.specNumByKey.set(tok, prev);
                this.clientToken.set(clientId, tok);
                const custom = this.customNameByToken.get(tok);
                if (custom !== undefined)
                    found.name = custom;
            }
            return found;
        }
        const key = tok ?? clientId;
        let n = this.specNumByKey.get(key);
        if (n === undefined) {
            // 無名 clientId 先取號，具名時把號碼帶到 token（轉移，不遞增）
            const carried = tok !== undefined ? this.specNumByKey.get(clientId) : undefined;
            if (carried !== undefined) {
                n = carried;
                this.specNumByKey.set(tok, n);
            }
            else {
                this.specSeq += 1;
                n = this.specSeq;
                this.specNumByKey.set(key, n);
            }
        }
        if (tok !== undefined)
            this.clientToken.set(clientId, tok);
        const custom = tok !== undefined ? this.customNameByToken.get(tok) : undefined;
        const sp = { clientId, name: custom ?? `觀眾${n}` };
        this.spectators.set(clientId, sp);
        return sp;
    }
    removeSpectator(clientId) {
        // 只下架在線名單；編號＋具名保留（token 綁定，重連／回席沿用）
        this.spectators.delete(clientId);
    }
    /** 參戰時把觀眾身分（編號＋具名）帶到新座位 token，離席回原編號 */
    adoptSpectatorIdentity(clientId, prevToken, newToken) {
        const n = (prevToken !== undefined ? this.specNumByKey.get(prevToken) : undefined)
            ?? this.specNumByKey.get(clientId);
        if (n !== undefined && !this.specNumByKey.has(newToken))
            this.specNumByKey.set(newToken, n);
        if (prevToken !== undefined) {
            const nm = this.customNameByToken.get(prevToken);
            if (nm !== undefined && !this.customNameByToken.has(newToken))
                this.customNameByToken.set(newToken, nm);
        }
        this.clientToken.set(clientId, newToken);
    }
    /**
     * 取名／改名（SET_NAME 後端）：
     * 空名拒收、超過 12 字截斷、與名單可見他人重名拒收。
     * 參戰者改座位名（同步 token 具名，離席沿用）；觀眾記 token→名並即時上架名單。
     * 舊聊天紀錄只存字串，不回寫（保留原名）。
     */
    setName(clientId, opts) {
        const clean = opts.name.trim().slice(0, 12);
        if (clean.length === 0)
            throw new Error('名稱不可為空');
        for (const s of this.seats) {
            if (s.controlledBy === 'human' && s.name !== '' && s.playerId !== opts.playerId && s.name === clean) {
                throw new Error('名稱已被使用');
            }
        }
        for (const [cid, sp] of this.spectators) {
            if (cid !== clientId && sp.name === clean)
                throw new Error('名稱已被使用');
        }
        if (opts.playerId !== undefined) {
            const seat = this.seats[opts.playerId - 1];
            if (!seat || seat.controlledBy !== 'human')
                throw new Error('尚未參戰');
            seat.name = clean;
            const tok = opts.token ?? seat.token ?? this.clientToken.get(clientId) ?? randomUUID();
            this.customNameByToken.set(tok, clean);
            this.clientToken.set(clientId, tok);
            const carried = this.specNumByKey.get(clientId);
            if (carried !== undefined && !this.specNumByKey.has(tok))
                this.specNumByKey.set(tok, carried);
            return { name: clean, token: tok };
        }
        const tok = opts.token ?? this.clientToken.get(clientId) ?? randomUUID();
        this.customNameByToken.set(tok, clean);
        this.clientToken.set(clientId, tok);
        this.addSpectator(clientId, tok);
        const sp = this.spectators.get(clientId);
        if (sp)
            sp.name = clean;
        return { name: clean, token: tok };
    }
    /** 觀眾斷線重連：同 token 拿回原編號＋原名；未知 token 回 undefined */
    restoreSpectator(clientId, token) {
        if (!this.specNumByKey.has(token) && !this.customNameByToken.has(token))
            return undefined;
        this.clientToken.set(clientId, token);
        return this.addSpectator(clientId, token);
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