/**
 * Werewolf Game Types — Phase 0 事件驅動狀態機型別層
 *
 * - Role / Team / SeerResult / MediumResult / NightActionType / ROLE_CONFIG 等沿用現有定義
 * - Phase 改為扁平 string union（10 值）；GameState / Player 改為事件驅動形狀
 * - GameState 另含 night.ts 相容欄位（nightActions / wolfKillTarget / guardProtectedTarget /
 *   seerCheckTarget / seerCheckResult）與 masonChatLog、expectedPlayerCount（規格缺口補位，見 game-state.ts）
 */
import { Personality } from './personalities.js';
export declare const SCHEMA_VERSION = 2;
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
    };
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
//# sourceMappingURL=types.d.ts.map