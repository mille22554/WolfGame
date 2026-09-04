/**
 * Werewolf Game Types
 * Core type definitions for the game engine
 */
import { Personality } from './personalities.js';
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
export declare enum Phase {
    SETUP = "setup",
    NIGHT = "night",
    DAY_DISCUSSION = "day_discussion",
    DAY_VOTING = "day_voting",
    DAY_RESULT = "day_result",
    GAME_OVER = "game_over"
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
    alive: boolean;
    isHuman: boolean;
    nightAction?: NightAction;
    seerChecks?: SeerCheck[];
    guardProtects?: GuardProtect[];
    masonPartnerId?: number;
    personality?: Personality;
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
    cause: 'vote' | 'wolf_kill';
}
export interface GameState {
    players: Player[];
    day: number;
    phase: Phase;
    nightActions: NightAction[];
    wolfKillTarget?: number;
    guardProtectedTarget?: number;
    seerCheckTarget?: number;
    seerCheckResult?: SeerResult;
    votes: Vote[];
    eliminatedPlayerId?: number;
    eliminatedPlayerRole?: Role;
    deathHistory: DeathRecord[];
    discussionLog: DiscussionEntry[];
    masonChatLog: MasonChatEntry[];
    winner?: Team;
    gameOver: boolean;
}
export interface DiscussionEntry {
    playerId: number;
    playerName: string;
    message: string;
    day: number;
    phase: 'discussion' | 'voting' | 'result';
}
export interface MasonChatEntry {
    playerId: number;
    playerName: string;
    message: string;
    night: number;
}
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
//# sourceMappingURL=types.d.ts.map