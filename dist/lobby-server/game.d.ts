/**
 * game.ts — 單一房間的遊戲引擎（ubuntu 分支 M5）
 *
 * 簡化 phase 狀態機：phase timer + 直接 state mutation（不用 event queue，見規格 §12.10）。
 *
 * 流程：ROLE_REVEAL(10s) → NIGHT(60s) → NIGHT_RESULT(10s) → DAY_DISCUSSION(120s)
 *       → DAY_VOTING(60s) → DAY_RESULT(10s) →（勝利判定）→ 下一夜... → GAME_OVER
 *
 * 規則（規格 §12）：
 * - 人狼不可殺狂人；狼刀目標取多數決（平票 → 先提交者）
 * - 守衛 Day1 不可行動；不可自護（自護 → 隨機改護他人）
 * - 占い師不可查自己
 * - 霊能者只在黎明得知「昨日」被票死者身分（夜殺不可知）
 * - 夜殺／票死：身分不公開
 * - 村勝：人狼全滅；狼勝：存活人狼數 ≥ 存活村人陣營數
 * - 所有活躍玩家皆已提交（夜間行動／投票）→ 提前結算，不等 timeout
 */
import { Role, Team, SeerResult } from '../types.js';
export type GamePhase = 'ROLE_REVEAL' | 'NIGHT' | 'NIGHT_RESULT' | 'DAY_DISCUSSION' | 'DAY_VOTING' | 'DAY_RESULT' | 'GAME_OVER';
export interface GamePlayer {
    clientId: string;
    nickname: string;
    role: Role;
    team: Team;
    alive: boolean;
    isMasonPartner: boolean;
    masonPartnerId?: string;
    wolfPartnerIds: string[];
    seerChecks: {
        targetId: string;
        result: SeerResult;
        day: number;
    }[];
    guardProtects: {
        targetId: string;
        day: number;
        success: boolean;
    }[];
}
export interface NightAction {
    actorClientId: string;
    type: 'WOLF_KILL' | 'SEER_CHECK' | 'GUARD_PROTECT';
    targetClientId: string;
}
export interface Vote {
    voterClientId: string;
    targetClientId: string | null;
}
export interface DeathRecord {
    clientId: string;
    nickname: string;
    day: number;
    cause: 'wolf_kill' | 'vote';
}
export interface GameState {
    phase: GamePhase;
    day: number;
    players: GamePlayer[];
    nightActions: NightAction[];
    votes: Vote[];
    deathHistory: DeathRecord[];
    winner: Team | null;
    /** 昨日被票出局者 clientId（霊能者黎明資訊用；每日投票開始時清除，避免隔天重送舊資訊） */
    lastVoteDeathClientId: string | null;
}
export interface GameCallbacks {
    /** 發送訊息給特定 client */
    sendTo(clientId: string, msg: object): void;
    /** 廣播：targetClientIds 未指定 → 全房成員；指定 → 只發給那些 clientIds（人狼私頻／共有者私頻） */
    broadcast(msg: object, targetClientIds?: string[]): void;
    /** 房間內所有 clientId（含觀戰者） */
    getAllClientIds?(): string[];
    /** 目前房主 clientId（END_DISCUSSION 驗證用；房間已不存在時回傳 undefined） */
    getHostClientId?(): string | undefined;
}
export declare class GameEngine {
    private roomCode;
    private players;
    private callbacks;
    private state;
    private timers;
    private countdownInterval?;
    constructor(roomCode: string, players: {
        clientId: string;
        nickname: string;
    }[], callbacks: GameCallbacks);
    /** 開始遊戲：分配角色、私發 ROLE_REVEALED、進入 phase 循環 */
    start(): void;
    /** 處理夜間行動提交 */
    handleNightAction(clientId: string, action: {
        type: 'WOLF_KILL' | 'SEER_CHECK' | 'GUARD_PROTECT';
        targetClientId: string;
    }): void;
    /** 處理投票（targetClientId = null → 棄票） */
    handleVote(clientId: string, targetClientId: string | null): void;
    /** 房主提前結束討論 */
    handleEndDiscussion(clientId: string): void;
    /** 人狼私頻（僅存活人狼可見） */
    handleWolfChat(clientId: string, text: string): void;
    /** 共有者私頻（僅雙方可見） */
    handleMasonChat(clientId: string, text: string): void;
    /** 清除所有 timer（房間回收時呼叫，避免孤兒 timer 讓 process 無法結束） */
    destroy(): void;
    private assignRoles;
    private transitionTo;
    /** 排定一次性 timer（fire 後自動從清單移除） */
    private schedule;
    /** 倒數提醒：剩餘 <30s 時每 10s 發一次 PHASE_COUNTDOWN（60s phase → 20s、10s） */
    private startCountdown;
    private stopCountdown;
    /** 角色對應的夜間行動類型（null = 該玩家本夜無主動行動） */
    private actionTypeFor;
    /** 活躍夜間玩家 = 存活人狼 + 存活占い師 + 存活守衛（Day2 起） */
    private getNightActivePlayers;
    private allNightActionsSubmitted;
    /** 夜間結算：守衛 → 人狼 → 占い師 → 霊能者（黎明）；broadcast 結果後進 NIGHT_RESULT 或 GAME_OVER */
    private resolveNight;
    /** 投票結算：票最高者出局（平票 → 隨機）；broadcast 結果後進 DAY_RESULT 或 GAME_OVER */
    private resolveVotes;
    /** 村勝：存活人狼 == 0；狼勝：存活人狼 ≥ 存活村人陣營（含狂人） */
    private checkWin;
    private getAlivePlayers;
    private getAliveWolves;
    private getAliveVillagers;
    private getPlayerByClientId;
}
//# sourceMappingURL=game.d.ts.map