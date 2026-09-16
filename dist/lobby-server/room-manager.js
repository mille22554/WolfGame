/**
 * room-manager.ts — 多房大廳的房間集合管理（純記憶體，無 I/O）
 *
 * - createRoom：每 IP 每分鐘限 RATE_LIMIT_PER_MIN 次；4 位數字代碼（首位 1-9）
 * - joinRoom：玩家席滿 → ROOM_FULL；總人數滿 → FULL_CAP；已開始 → 轉觀戰
 * - leaveRoom：離開前捕捉 wasHost，空房回收
 * - kickPlayer / setSetting / startGame：僅房主可為
 * - reclaimSwept：回收無活動超時的房間（由 sweep timer 或手動呼叫）
 */
import { Room } from './room.js';
import { MIN_PLAYERS, MAX_PLAYERS, MAX_MEMBERS_PER_ROOM, MAX_MESSAGE_LEN, RATE_LIMIT_PER_MIN } from './types.js';
export class RoomManager {
    rooms = new Map();
    createLog = new Map();
    sweepTimer;
    inactivityTimeoutMs;
    sweepIntervalMs;
    now;
    constructor(opts = {}) {
        this.inactivityTimeoutMs = opts.inactivityTimeoutMs ?? 30 * 60 * 1000;
        this.sweepIntervalMs = opts.sweepIntervalMs ?? 60 * 1000;
        this.now = opts.now ?? Date.now;
    }
    /** 4 位數字代碼：首位 1-9，其餘 0-9；與既有房間不重複（最多試 100 次）。 */
    generateCode() {
        for (let i = 0; i < 100; i++) {
            const code = String(1 + Math.floor(Math.random() * 9)) +
                Math.floor(Math.random() * 10) +
                Math.floor(Math.random() * 10) +
                Math.floor(Math.random() * 10);
            if (!this.rooms.has(code))
                return code;
        }
        throw new Error('無法分配房間代碼（100 次皆碰撞）');
    }
    createRoom(nickname, clientId, ip) {
        const t = this.now();
        const arr = (this.createLog.get(ip) ?? []).filter((x) => t - x < 60000);
        if (arr.length >= RATE_LIMIT_PER_MIN)
            return { ok: false, error: 'RATE_LIMITED' };
        arr.push(t);
        this.createLog.set(ip, arr);
        const code = this.generateCode();
        const room = new Room(code);
        room.addMember(clientId, nickname, false);
        this.rooms.set(code, room);
        return { ok: true, code, room };
    }
    getRoom(code) {
        return this.rooms.get(code);
    }
    joinRoom(code, nickname, clientId, ip, asSpectator = false) {
        void ip; // 保留參數以符合協定簽章（目前 join 不做 rate limit）
        const room = this.rooms.get(code);
        if (!room)
            return { ok: false, error: 'NOT_FOUND' };
        if (room.totalMembers >= MAX_MEMBERS_PER_ROOM)
            return { ok: false, error: 'FULL_CAP' };
        let isSpectator;
        if (asSpectator)
            isSpectator = true;
        else if (room.started)
            isSpectator = true;
        else if (room.playerCount >= room.maxPlayers)
            return { ok: false, error: 'ROOM_FULL' };
        else
            isSpectator = false;
        room.addMember(clientId, nickname, isSpectator);
        return { ok: true, code, room, isSpectator };
    }
    /**
     * 離開房間。wasHost 在移除「前」判斷（移除前該 client 是否為 host），
     * newHost 在移除「後」取得；空房直接回收。
     */
    leaveRoom(clientId) {
        const room = this.findRoomOf(clientId);
        if (!room)
            return { room: undefined, left: undefined, wasHost: false, newHost: undefined };
        const hostBefore = room.host;
        const wasHost = hostBefore !== undefined && hostBefore.clientId === clientId;
        const left = room.removeMember(clientId);
        if (room.totalMembers === 0) {
            this.rooms.delete(room.code);
            return { room: undefined, left, wasHost, newHost: undefined };
        }
        return { room, left, wasHost, newHost: room.host };
    }
    kickPlayer(hostClientId, targetNickname) {
        const room = this.findRoomOf(hostClientId);
        if (!room)
            return { ok: false, error: 'NOT_HOST' };
        if (room.host?.clientId !== hostClientId)
            return { ok: false, error: 'NOT_HOST' };
        const target = room.getMemberByNickname(targetNickname);
        if (!target || target.clientId === hostClientId)
            return { ok: false, error: 'NOT_FOUND' }; // 不可踢自己
        room.removeMember(target.clientId);
        if (room.totalMembers === 0)
            this.rooms.delete(room.code);
        return { ok: true, room, kicked: target };
    }
    setSetting(hostClientId, patch) {
        const room = this.findRoomOf(hostClientId);
        if (!room || room.host?.clientId !== hostClientId)
            return { ok: false, error: 'NOT_HOST' };
        if (patch.maxPlayers !== undefined) {
            if (!Number.isInteger(patch.maxPlayers) ||
                patch.maxPlayers < MIN_PLAYERS ||
                patch.maxPlayers > MAX_PLAYERS ||
                patch.maxPlayers < room.playerCount // 不可縮小到目前玩家數以下
            ) {
                return { ok: false, error: 'INVALID' };
            }
            room.maxPlayers = patch.maxPlayers;
        }
        if (patch.randomCount !== undefined)
            room.randomCount = patch.randomCount;
        room.touch();
        return { ok: true, room };
    }
    setMode(clientId, mode) {
        const room = this.findRoomOf(clientId);
        const member = room?.getMember(clientId);
        if (!room || !member)
            return { ok: false, error: 'NOT_IN_ROOM' };
        if (mode === 'spectate') {
            member.isSpectator = true;
        }
        else {
            if (room.playerCount >= room.maxPlayers)
                return { ok: false, error: 'NO_SLOT' };
            member.isSpectator = false;
        }
        room.touch();
        return { ok: true, room };
    }
    sendMessage(clientId, text) {
        const room = this.findRoomOf(clientId);
        const member = room?.getMember(clientId);
        if (!room || !member)
            return { ok: false, error: 'NOT_IN_ROOM' };
        const clean = text.trim();
        if (clean.length === 0)
            return { ok: false, error: 'EMPTY' };
        if (clean.length > MAX_MESSAGE_LEN)
            return { ok: false, error: 'TOO_LONG' };
        const entry = { from: member.nickname, text: clean, ts: this.now() };
        room.addChat(entry);
        room.touch();
        return { ok: true, room, entry };
    }
    startGame(hostClientId, maxPlayers, randomCount) {
        const room = this.findRoomOf(hostClientId);
        if (!room || room.host?.clientId !== hostClientId)
            return { ok: false, error: 'NOT_HOST' };
        if (!Number.isInteger(maxPlayers) || maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) {
            return { ok: false, error: 'INVALID' };
        }
        room.maxPlayers = maxPlayers;
        room.randomCount = randomCount;
        room.started = true;
        room.touch();
        const actualCount = randomCount
            ? (MIN_PLAYERS + Math.floor(Math.random() * (maxPlayers - MIN_PLAYERS + 1)))
            : maxPlayers;
        return { ok: true, room, actualCount };
    }
    /** 回收無活動超時的房間；回傳被回收的代碼列表。 */
    reclaimSwept() {
        const t = this.now();
        const reclaimed = [];
        for (const [code, room] of this.rooms) {
            if (t - room.lastActivity > this.inactivityTimeoutMs) {
                this.rooms.delete(code);
                reclaimed.push(code);
            }
        }
        return reclaimed;
    }
    startSweep() {
        this.sweepTimer = setInterval(() => this.reclaimSwept(), this.sweepIntervalMs);
        this.sweepTimer.unref?.();
    }
    stopSweep() {
        if (this.sweepTimer)
            clearInterval(this.sweepTimer);
    }
    roomCount() {
        return this.rooms.size;
    }
    /** 找出 clientId 所在的房間（一個 clientId 至多在一間房）。 */
    findRoomOf(clientId) {
        for (const room of this.rooms.values()) {
            if (room.getMember(clientId))
                return room;
        }
        return undefined;
    }
}
//# sourceMappingURL=room-manager.js.map