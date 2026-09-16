/**
 * room.ts — 單一房間的純記憶體狀態（多房大廳）
 *
 * 房主 = joinSeq 最小者（最早加入者）；即時計算，房主離開時自動移轉。
 */
import type { MemberInfo, ChatEntry } from './types.js';
export interface Member {
    clientId: string;
    nickname: string;
    joinSeq: number;
    isSpectator: boolean;
}
export declare class Room {
    readonly code: string;
    private members;
    private seq;
    maxPlayers: number;
    randomCount: boolean;
    started: boolean;
    lastActivity: number;
    private chat;
    constructor(code: string, maxPlayers?: number);
    touch(): void;
    addMember(clientId: string, nickname: string, isSpectator: boolean): Member;
    removeMember(clientId: string): Member | undefined;
    getMember(clientId: string): Member | undefined;
    getMemberByNickname(nickname: string): Member | undefined;
    /** Host = member with the smallest joinSeq (the earliest joiner). Recomputed live, so it auto-transfers when the host leaves. */
    get host(): Member | undefined;
    get playerCount(): number;
    get totalMembers(): number;
    get isFull(): boolean;
    addChat(entry: ChatEntry): void;
    getChat(): ChatEntry[];
    /** Full member list sorted by joinSeq; each flagged with isHost (== current host) and isSpectator. */
    memberList(): MemberInfo[];
}
//# sourceMappingURL=room.d.ts.map