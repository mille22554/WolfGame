/**
 * Werewolf Game Types — Phase 0 事件驅動狀態機型別層
 *
 * - Role / Team / SeerResult / MediumResult / NightActionType / ROLE_CONFIG 等沿用現有定義
 * - Phase 改為扁平 string union（10 值）；GameState / Player 改為事件驅動形狀
 * - GameState 另含 night.ts 相容欄位（nightActions / wolfKillTarget / guardProtectedTarget /
 *   seerCheckTarget / seerCheckResult）與 masonChatLog、expectedPlayerCount（規格缺口補位，見 game-state.ts）
 */
import { Personality } from './personalities.js';
export declare const SCHEMA_VERSION = 3;
export type Phase = 'SETUP_WAITING_JOIN' | 'SETUP_READY' | 'NIGHT_COLLECTING' | 'NIGHT_RESOLVING' | 'DAY_DISCUSSION_OPEN' | 'DAY_DISCUSSION_CLOSING' | 'DAY_VOTING_COLLECTING' | 'DAY_VOTING_RESOLVING' | 'DAY_RESULT_ANNOUNCING' | 'GAME_OVER_FINAL';
export type GameEvent = {
    type: 'CLIENT_JOIN';
    name: string;
} | {
    type: 'CLIENT_LEAVE';
} | {
    type: 'START_GAME';
} | {
    type: 'HUMAN_SPEAK';
    playerId: number;
    text: string;
} | {
    type: 'HUMAN_SKIP';
    playerId: number;
} | {
    type: 'HUMAN_READY_VOTE';
    playerId: number;
} | {
    type: 'HUMAN_UNREADY_VOTE';
    playerId: number;
} | {
    type: 'HUMAN_VOTE';
    playerId: number;
    targetId: number;
} | {
    type: 'HUMAN_NIGHT_ACTION';
    playerId: number;
    targetId: number;
} | {
    type: 'AI_SPEECH_DONE';
    playerId: number;
    text: string;
    boardVersion: number;
} | {
    type: 'AI_VOTE_DONE';
    playerId: number;
    targetId: number;
} | {
    type: 'AI_NIGHT_DONE';
    playerId: number;
    targetId: number;
} | {
    type: 'MASON_CHAT';
    playerId: number;
    text: string;
} | {
    type: 'ACTION_TIMEOUT';
    gateId: string;
} | {
    type: 'DISCONNECT';
    playerId: number;
} | {
    type: 'CLOSE_DISCUSSION';
} | {
    type: 'RESOLVE_NIGHT';
} | {
    type: 'RESOLVE_VOTES';
} | {
    type: 'ADVANCE_DAY';
} | {
    type: 'HUMAN_JOIN';
    playerId: number;
    name?: string;
} | {
    type: 'AI_JOIN';
    playerId: number;
} | {
    type: 'RECONNECT';
    playerId: number;
};
export interface PendingGate {
    kind: 'night' | 'vote';
    required: number[];
    done: number[];
    timeoutMs: number;
    deadline: number;
}
export declare enum Role {
    VILLAGER = "villager",// 村民
    SEER = "seer",// 占い師
    MEDIUM = "medium",// 靈能者
    GUARD = "guard",// 獵人（守衛/狩人）
    MASON = "mason",// 共有者
    WEREWOLF = "werewolf",// 人狼
    MADMAN = "madman"
}
export declare enum Team {
    VILLAGE = "village",// 村人陣營
    WEREWOLF = "werewolf"
}
export declare enum NightActionType {
    WOLF_KILL = "wolf_kill",
    SEER_CHECK = "seer_check",
    GUARD_PROTECT = "guard_protect"
}
export declare enum SeerResult {
    VILLAGER = "villager",// 村人 (includes Madman, Mason, Villager)
    WEREWOLF = "werewolf"
}
export declare enum MediumResult {
    VILLAGER = "villager",
    WEREWOLF = "werewolf"
}
export interface Player {
    id: number;
    name: string;
    role: Role;
    team: Team;
    controlledBy: 'human' | 'ai';
    personality: string;
    alive: boolean;
    isMasonPartner?: boolean;
    seerChecks?: SeerCheck[];
    guardProtects?: GuardProtect[];
    masonPartnerId?: number;
}
export interface NightAction {
    type: NightActionType;
    targetId: number;
    actorId: number;
}
export interface SeerCheck {
    targetId: number;
    result: SeerResult;
    day: number;
}
export interface GuardProtect {
    targetId: number;
    day: number;
    success: boolean;
}
export interface Vote {
    voterId: number;
    targetId: number;
    day: number;
}
export interface DeathRecord {
    playerId: number;
    day: number;
    cause: 'vote' | 'wolf_kill' | 'suicide';
}
export interface DiscussionEntry {
    playerId: number;
    text: string;
    day: number;
}
export interface MasonChatEntry {
    playerId: number;
    text: string;
    day: number;
}
export interface GameState {
    schemaVersion: number;
    phase: Phase;
    day: number;
    players: Player[];
    humanPlayerIndices: number[];
    discussionLog: DiscussionEntry[];
    votes: Vote[];
    deathHistory: DeathRecord[];
    seerChecks: {
        seerId: number;
        targetId: number;
        result: Team;
        day: number;
    }[];
    guardProtects: {
        guardId: number;
        targetId: number;
        day: number;
    }[];
    winner: Team | null;
    gameOver: boolean;
    boardVersion: number;
    daySummaries: string[];
    voteReady: number[];
    skippedHumans: number[];
    pendingGate: PendingGate | null;
    /** 大廳目標人數：CLIENT_JOIN 達標 → SETUP_READY 的依據 */
    expectedPlayerCount: number;
    /** 夜晚行動暫存（NIGHT_COLLECTING 收集 → NIGHT_RESOLVING 交 night.ts 結算） */
    nightActions: NightAction[];
    /** 共有者夜聊（MASON_CHAT 事件儲存，僅共有者 snapshot 可見） */
    masonChatLog: MasonChatEntry[];
    wolfKillTarget?: number;
    guardProtectedTarget?: number;
    seerCheckTarget?: number;
    seerCheckResult?: SeerResult;
}
export interface PlayerSnapshot {
    phase: Phase;
    day: number;
    alivePlayers: {
        id: number;
        name: string;
    }[];
    deadPlayers: {
        id: number;
        name: string;
        cause: string;
        day: number;
    }[];
    nightResult: string | null;
    discussionLog: {
        playerId: number;
        text: string;
    }[];
    votes: {
        voterId: number;
        targetId: number;
    }[];
    winner: Team | null;
    gameOver: boolean;
    gateDeadline: number | null;
    you: {
        role: Role;
        team: Team;
        seerChecks?: {
            targetId: number;
            result: Team;
            day: number;
        }[];
        guardProtects?: {
            targetId: number;
            day: number;
        }[];
        mediumResults?: {
            targetId: number;
            team: Team;
            day: number;
        }[];
        masonPartnerId?: number;
        masonChatLog?: {
            playerId: number;
            text: string;
        }[];
        wolfAllyIds?: number[];
        canAct?: boolean;
        wolfMeeting?: {
            wolfId: number;
            targetId: number;
        }[];
    };
}
/** Phase 2：大廳 snapshot（遊戲前 UI，唯一允許顯示 controlledBy 的介面，AI 永不看到） */
export interface LobbySnapshot {
    phase: Phase;
    expectedPlayerCount: number;
    seats: {
        playerId: number;
        name: string;
        controlledBy: 'ai' | 'human' | 'empty';
    }[];
    started: boolean;
}
export interface GMSnapshot {
    phase: Phase;
    day: number;
    players: Player[];
    discussionLog: {
        playerId: number;
        text: string;
        day: number;
    }[];
    votes: {
        voterId: number;
        targetId: number;
        day: number;
    }[];
    deathHistory: {
        playerId: number;
        cause: string;
        day: number;
    }[];
    boardVersion: number;
    pendingGate: PendingGate | null;
    voteReady: number[];
}
export interface TransitionResult {
    state: GameState;
    effects: Effect[];
    accepted: boolean;
    reason?: string;
}
export type Effect = {
    type: 'BROADCAST';
} | {
    type: 'SAVE';
} | {
    type: 'ARM_GATE';
    gate: PendingGate;
} | {
    type: 'DISPATCH_LLM';
    playerId: number;
    kind: 'speech' | 'vote' | 'night';
} | {
    type: 'ENQUEUE';
    event: GameEvent;
};
export interface RoleConfig {
    [playerCount: number]: {
        [role in Role]?: number;
    };
}
export declare const ROLE_CONFIG: RoleConfig;
export declare const ROLE_TEAM: Record<Role, Team>;
export declare const ROLE_DISPLAY: Record<Role, string>;
export declare const ROLE_DESCRIPTION: Record<Role, string>;
export declare function getTeam(role: Role): Team;
export declare function getDisplayName(role: Role): string;
export declare function getDescription(role: Role): string;
export declare function isVillageTeam(role: Role): boolean;
export declare function isWerewolfTeam(role: Role): boolean;
export declare function seerSeesAs(targetRole: Role): SeerResult;
export declare function mediumSeesAs(targetRole: Role): MediumResult;
export type { Personality };
/** LLM 文字生成參數（沿用 llm.ts 語義；正典定義移至此，llm.ts 再匯出相容） */
export interface GenerationConfig {
    temperature?: number;
    maxTokens?: number;
}
/** 觀戰者視角：與 PlayerSnapshot 公開欄位相同，不含 you（永不洩漏角色） */
export interface SpectatorSnapshot {
    phase: Phase;
    day: number;
    alivePlayers: {
        id: number;
        name: string;
    }[];
    deadPlayers: {
        id: number;
        name: string;
        cause: string;
        day: number;
    }[];
    nightResult: string | null;
    discussionLog: {
        playerId: number;
        text: string;
    }[];
    votes: {
        voterId: number;
        targetId: number;
    }[];
    winner: Team | null;
    gameOver: boolean;
}
/** Worker 任務（主 → worker） */
export interface WorkerJob {
    jobId: string;
    kind: 'speech' | 'vote' | 'night' | 'pre_speech' | 'judge' | 'expand';
    prompt: string;
    temperature?: number;
    maxTokens?: number;
}
export type MainToWorkerMessage = {
    type: 'INIT';
    modelPath: string;
    contextSize: number;
    contextCount: number;
} | {
    type: 'JOB';
    job: WorkerJob;
} | {
    type: 'SHUTDOWN';
};
export type WorkerToMainMessage = {
    type: 'READY';
} | {
    type: 'RESULT';
    jobId: string;
    ok: true;
    text: string;
} | {
    type: 'RESULT';
    jobId: string;
    ok: false;
    error: string;
} | {
    type: 'LOG';
    level: 'info' | 'warn' | 'error';
    message: string;
};
/** LLM 分派器（Phase 1 新增 generate，供預發言/裁判/展開用） */
export interface LLMDispatcher {
    requestNightAction(playerId: number, prompt: string): Promise<{
        targetId: number;
    }>;
    requestVote(playerId: number, prompt: string): Promise<{
        targetId: number;
    }>;
    requestSpeech(playerId: number, prompt: string): Promise<{
        text: string;
    }>;
    /** Phase 1 新增：原始文字生成（預發言/裁判/展開用） */
    generate(prompt: string, config?: GenerationConfig): Promise<string>;
}
/** 客戶端註冊表（Phase 1 新增觀戰者廣播，optional 保持相容） */
export interface ClientRegistry {
    getConnectedPlayerIds(): number[];
    send(playerId: number, snapshot: PlayerSnapshot): void;
    /** Phase 1 新增（optional）：觀戰者廣播 */
    sendSpectator?(snapshot: SpectatorSnapshot): void;
    hasSpectators?(): boolean;
    /** Phase 2 新增（optional）：大廳廣播（SETUP 階段取代 snapshot 廣播） */
    sendLobby?(lobby: LobbySnapshot): void;
}
/** SpeechScheduler 建構參數 */
export interface SchedulerContext {
    enqueue(event: GameEvent): void;
    getState(): GameState;
    llm: LLMDispatcher;
}
/** 前端 WS 協定：伺服器 → 客戶端（Phase 2 擴充） */
export type ServerToClientMessage = {
    type: 'SNAPSHOT';
    snapshot: PlayerSnapshot | SpectatorSnapshot | GMSnapshot;
    gmView: boolean;
} | {
    type: 'LOBBY';
    lobby: LobbySnapshot;
} | {
    type: 'JOINED';
    playerId: number;
    token: string;
} | {
    type: 'JOIN_REJECTED';
    reason: string;
} | {
    type: 'ACTION_REJECTED';
    reason: string;
} | {
    type: 'MODEL_STATUS';
    state: 'downloading' | 'ready' | 'error';
    stage?: 'llama-server' | 'model';
    downloaded?: number;
    total?: number;
    error?: string;
} | {
    type: 'PING';
} | {
    type: 'SHUTDOWN';
};
/** 前端 WS 協定：客戶端 → 伺服器（Phase 2 擴充；真人操作訊息不含 playerId，伺服器由連線補上） */
export type ClientToServerMessage = {
    type: 'PONG';
} | {
    type: 'REQUEST_SNAPSHOT';
} | {
    type: 'SET_GM_VIEW';
    enabled: boolean;
} | {
    type: 'LEAVE';
} | {
    type: 'JOIN';
    playerId: number;
    name?: string;
} | {
    type: 'RECONNECT';
    token: string;
} | {
    type: 'START_GAME';
} | {
    type: 'HUMAN_SPEAK';
    text: string;
} | {
    type: 'HUMAN_SKIP';
} | {
    type: 'HUMAN_READY_VOTE';
} | {
    type: 'HUMAN_UNREADY_VOTE';
} | {
    type: 'HUMAN_VOTE';
    targetId: number;
} | {
    type: 'HUMAN_NIGHT_ACTION';
    targetId: number;
};
//# sourceMappingURL=types.d.ts.map