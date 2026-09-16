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
import type { Member } from './room.js';
import type { ChatEntry } from './types.js';
export type JoinResult = {
    ok: true;
    code: string;
    room: Room;
    isSpectator: boolean;
} | {
    ok: false;
    error: 'NOT_FOUND' | 'ROOM_FULL' | 'FULL_CAP' | 'RATE_LIMITED';
};
export type CreateResult = {
    ok: true;
    code: string;
    room: Room;
} | {
    ok: false;
    error: 'RATE_LIMITED';
};
export interface LeaveResult {
    room: Room | undefined;
    left: Member | undefined;
    wasHost: boolean;
    newHost: Member | undefined;
}
export interface RoomManagerOptions {
    inactivityTimeoutMs?: number;
    sweepIntervalMs?: number;
    now?: () => number;
}
export declare class RoomManager {
    private rooms;
    private createLog;
    private sweepTimer?;
    private readonly inactivityTimeoutMs;
    private readonly sweepIntervalMs;
    private readonly now;
    constructor(opts?: RoomManagerOptions);
    /** 4 位數字代碼：首位 1-9，其餘 0-9；與既有房間不重複（最多試 100 次）。 */
    private generateCode;
    createRoom(nickname: string, clientId: string, ip: string): CreateResult;
    getRoom(code: string): Room | undefined;
    joinRoom(code: string, nickname: string, clientId: string, ip: string, asSpectator?: boolean): JoinResult;
    /**
     * 離開房間。wasHost 在移除「前」判斷（移除前該 client 是否為 host），
     * newHost 在移除「後」取得；空房直接回收。
     */
    leaveRoom(clientId: string): LeaveResult;
    kickPlayer(hostClientId: string, targetNickname: string): {
        ok: true;
        room: Room;
        kicked: Member;
    } | {
        ok: false;
        error: 'NOT_HOST' | 'NOT_FOUND';
    };
    setSetting(hostClientId: string, patch: {
        maxPlayers?: number;
        randomCount?: boolean;
    }): {
        ok: true;
        room: Room;
    } | {
        ok: false;
        error: 'NOT_HOST' | 'INVALID';
    };
    setMode(clientId: string, mode: 'play' | 'spectate'): {
        ok: true;
        room: Room;
    } | {
        ok: false;
        error: 'NOT_IN_ROOM' | 'NO_SLOT';
    };
    sendMessage(clientId: string, text: string): {
        ok: true;
        room: Room;
        entry: ChatEntry;
    } | {
        ok: false;
        error: 'NOT_IN_ROOM' | 'EMPTY' | 'TOO_LONG';
    };
    startGame(hostClientId: string, maxPlayers: number, randomCount: boolean): {
        ok: true;
        room: Room;
        actualCount: number;
    } | {
        ok: false;
        error: 'NOT_HOST' | 'INVALID';
    };
    /** 回收無活動超時的房間；回傳被回收的代碼列表。 */
    reclaimSwept(): string[];
    startSweep(): void;
    stopSweep(): void;
    roomCount(): number;
    /** 找出 clientId 所在的房間（一個 clientId 至多在一間房）。 */
    private findRoomOf;
}
//# sourceMappingURL=room-manager.d.ts.map