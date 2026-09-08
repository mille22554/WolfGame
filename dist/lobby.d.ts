import type { EngineStatus, LobbySnapshot } from './types.js';
export declare const MIN_PLAYERS = 6;
export declare const MAX_PLAYERS = 15;
export declare const CHAT_LIMIT = 50;
export declare const CHAT_MAXLEN = 500;
export interface LobbySeat {
    playerId: number;
    name: string;
    controlledBy: 'empty' | 'ai' | 'human';
    token?: string;
    disconnected?: boolean;
}
export interface LobbySpectator {
    clientId: string;
    name: string;
}
export interface LobbyChatEntry {
    from: string;
    text: string;
    ts: number;
}
export declare class LobbyManager {
    private _playerCount;
    private seats;
    private tokens;
    private limbo;
    private spectators;
    private specSeq;
    private specNumByKey;
    private clientToken;
    private customNameByToken;
    private chat;
    private engineStatus;
    private _randomCount;
    private _hostClientId?;
    constructor(_playerCount: number);
    get playerCount(): number;
    get randomCount(): boolean;
    get hostClientId(): string | undefined;
    setHost(clientId: string): void;
    clearHostIf(clientId: string): boolean;
    private resetSeats;
    private humanCount;
    /** 改人數：只增減尾部；縮減時被截的 human 座位→ token 失效（自動變觀戰者）；AI 直接丟棄 */
    setPlayerCount(n: number): {
        droppedTokens: string[];
    };
    setRandomCount(enabled: boolean): void;
    /** 開局人數解析：隨機開啟時在 [max(6, 真人最大座位號), 座位格數] 均勻擲出，否則為座位格數
     *（下限用最大座位號而非真人數：真人坐 14/15 號時擲出 6 會超出新 engine 人數而被排除） */
    resolveCount(): number;
    /** 入座（空位限定）：佔座＋發 token */
    join(playerId: number, name?: string): {
        token: string;
    };
    /** 離座→觀戰：座位清空，token＋名字進 limbo（重連可拿回）；tokens 映射同步刪除 */
    leave(playerId: number): void;
    /** 大廳內同 token 重連：斷線座位（human+disconnected）直接拿回；limbo（已離座）座位空才恢復 */
    reclaim(token: string): {
        playerId: number;
    } | undefined;
    /** 斷線標記（座位保留＋AI 託管；不計入 hasHumanSeats） */
    markDisconnected(playerId: number): void;
    lookupToken(token: string): number | undefined;
    /** 座位名（chat 發送者用；空座/AI/不存在回 undefined） */
    seatName(playerId: number): string | undefined;
    /** 觀眾進場：同穩定鍵沿用固定編號（token 優先）；無名→觀眾N，具名→自定暱稱 */
    addSpectator(clientId: string, token?: string): LobbySpectator;
    removeSpectator(clientId: string): void;
    /** 參戰時把觀眾身分（編號＋具名）帶到新座位 token，離席回原編號 */
    adoptSpectatorIdentity(clientId: string, prevToken: string | undefined, newToken: string): void;
    /**
     * 取名／改名（SET_NAME 後端）：
     * 空名拒收、超過 12 字截斷、與名單可見他人重名拒收。
     * 參戰者改座位名（同步 token 具名，離席沿用）；觀眾記 token→名並即時上架名單。
     * 舊聊天紀錄只存字串，不回寫（保留原名）。
     */
    setName(clientId: string, opts: {
        playerId?: number;
        token?: string;
        name: string;
    }): {
        name: string;
        token: string;
    };
    /** 觀眾斷線重連：同 token 拿回原編號＋原名；未知 token 回 undefined */
    restoreSpectator(clientId: string, token: string): LobbySpectator | undefined;
    addChat(from: string, text: string): LobbyChatEntry;
    setEngineStatus(s: EngineStatus): void;
    hasHumanSeats(): boolean;
    /** 開局前：空位補 AI（斷線未歸的 human 座位由呼叫端先轉 AI，見 fillDisconnectedAsAi） */
    fillAiSeats(): void;
    /** 開局時：仍斷線的 human 座位轉 AI（token 失效，重連者進觀戰） */
    fillDisconnectedAsAi(): string[];
    /** 開局灌 engine 用（playerId/name/controlledBy 快照） */
    seatsForStart(): {
        playerId: number;
        name: string;
        controlledBy: 'ai' | 'human';
    }[];
    snapshot(): LobbySnapshot;
}
//# sourceMappingURL=lobby.d.ts.map