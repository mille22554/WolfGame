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
} | {
    type: 'NIGHT_ACTION';
    action: 'WOLF_KILL' | 'SEER_CHECK' | 'GUARD_PROTECT';
    targetClientId: string;
} | {
    type: 'TOGGLE_MASON_END_TURN';
} | {
    type: 'TOGGLE_WOLF_READY';
} | {
    type: 'CAST_VOTE';
    targetClientId: string | null;
} | {
    type: 'END_DISCUSSION';
} | {
    type: 'WOLF_CHAT';
    text: string;
} | {
    type: 'MASON_CHAT';
    text: string;
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
} | {
    type: 'PHASE_CHANGED';
    phase: string;
    day: number;
} | {
    type: 'ROLE_REVEALED';
    role: string;
    displayName: string;
    description: string;
    partners: string[];
    madman?: string;
} | {
    type: 'MASON_READY';
    clientId: string;
    ready: boolean;
} | {
    type: 'WOLF_READY';
    clientId: string;
    ready: boolean;
} | {
    type: 'WOLF_VOTE_SPLIT';
    votes: Record<string, number>;
} | {
    type: 'WOLF_SPEECH_SELECTED';
    round: number;
    from: string;
    text: string;
} | {
    type: 'WOLF_MEETING_ABORTED';
    count: number;
    reason: string;
} | {
    type: 'NIGHT_RESULT';
    peacefulNight: boolean;
    deaths: {
        clientId: string;
        nickname: string;
    }[];
} | {
    type: 'SEER_RESULT';
    targetClientId: string;
    nickname: string;
    result: 'villager' | 'werewolf';
} | {
    type: 'GUARD_RESULT';
    targetClientId: string;
    nickname: string;
    blocked: boolean;
} | {
    type: 'MEDIUM_RESULT';
    targetClientId: string;
    nickname: string;
    result: 'villager' | 'werewolf';
} | {
    type: 'VOTE_RESULT';
    votes: Record<string, number>;
    eliminatedClientId: string | null;
    tie: boolean;
} | {
    type: 'PLAYER_ELIMINATED';
    clientId: string;
    nickname: string;
    cause: 'wolf_kill' | 'vote';
} | {
    type: 'GAME_OVER';
    winner: 'village' | 'werewolf';
    players: {
        clientId: string;
        nickname: string;
        role: string;
        alive: boolean;
    }[];
} | {
    type: 'WOLF_MESSAGE';
    from: string;
    text: string;
    ts: number;
} | {
    type: 'MASON_MESSAGE';
    from: string;
    text: string;
    ts: number;
} | {
    type: 'PHASE_COUNTDOWN';
    phase: string;
    secondsLeft: number;
};
export declare const MIN_PLAYERS = 6;
export declare const MAX_PLAYERS = 15;
export declare const MAX_MEMBERS_PER_ROOM = 20;
export declare const MAX_MESSAGE_LEN = 200;
/** 狼會議安全上限（測試用）：白板累計 N 則 WOLF_MESSAGE 未收斂 → 停止並報告 */
export declare const WOLF_MESSAGE_CAP = 100;
export declare const CHAT_LIMIT = 50;
export declare const RATE_LIMIT_PER_MIN = 10;
//# sourceMappingURL=types.d.ts.map