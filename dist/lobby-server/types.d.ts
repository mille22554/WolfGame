/**
 * types.ts — lobby-server 共用型別與常數
 *
 * 多房大廳 WebSocket 協定（ubuntu 分支）：
 * - ClientToServerMessage：client → server
 * - ServerToClientMessage：server → client
 */
export interface MemberInfo {
    nickname: string;
    isHost: boolean;
    isSpectator: boolean;
}
export interface ChatEntry {
    from: string;
    text: string;
    ts: number;
}
export type ClientToServerMessage = {
    type: 'CREATE_ROOM';
    nickname: string;
} | {
    type: 'JOIN_ROOM';
    code: string;
    nickname: string;
    asSpectator?: boolean;
} | {
    type: 'SEND_MESSAGE';
    text: string;
} | {
    type: 'SET_SETTING';
    maxPlayers?: number;
    randomCount?: boolean;
} | {
    type: 'SET_MODE';
    mode: 'play' | 'spectate';
} | {
    type: 'START_GAME';
    maxPlayers: number;
    randomCount: boolean;
} | {
    type: 'KICK_PLAYER';
    target: string;
};
export type ServerToClientMessage = {
    type: 'ROOM_JOINED';
    code: string;
    isHost: boolean;
    players: MemberInfo[];
    started: boolean;
    maxPlayers: number;
    randomCount: boolean;
} | {
    type: 'SPECTATOR_JOINED';
    code: string;
    isHost: boolean;
    players: MemberInfo[];
    started: boolean;
    maxPlayers: number;
    randomCount: boolean;
} | {
    type: 'ROOM_FULL';
} | {
    type: 'MESSAGE';
    from: string;
    text: string;
    ts: number;
} | {
    type: 'PLAYER_JOINED';
    nickname: string;
} | {
    type: 'PLAYER_LEFT';
    nickname: string;
} | {
    type: 'HOST_CHANGED';
    newHost: string;
} | {
    type: 'SETTING_CHANGED';
    maxPlayers: number;
    randomCount: boolean;
} | {
    type: 'GAME_STARTED';
    started: boolean;
    actualCount: number;
} | {
    type: 'MEMBERS_CHANGED';
    players: MemberInfo[];
} | {
    type: 'KICKED';
    reason: string;
} | {
    type: 'ERROR';
    message: string;
};
export declare const MIN_PLAYERS = 6;
export declare const MAX_PLAYERS = 15;
export declare const MAX_MEMBERS_PER_ROOM = 20;
export declare const MAX_MESSAGE_LEN = 200;
export declare const CHAT_LIMIT = 50;
export declare const RATE_LIMIT_PER_MIN = 10;
//# sourceMappingURL=types.d.ts.map