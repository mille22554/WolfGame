/**
 * Role Assignment Logic — Phase 0
 * 角色分配演算法沿用現有（ROLE_CONFIG 表）
 */
import { Role, Player, GameState } from './types.js';
import { assignPersonalities } from './personalities.js';
/**
 * 建立大廳佔位玩家：全部 VILLAGER + 依序 personality，
 * controlledBy 依 humanPlayerIndices（缺口補位：humanPlayerIndices 為選填，預設全 ai）
 */
export declare function createLobbyPlayers(playerCount: number, humanPlayerIndices?: number[]): Player[];
/**
 * START_GAME 時呼叫：覆寫 role/team/isMasonPartner（並配對 masonPartnerId）
 * 角色分配演算法沿用現有 ROLE_CONFIG：
 * 狼人 1–3（依人數）、占卜師 1、守衛 1、靈能者（8+ 人）、共有者（13+ 人）、狂人 1、其餘村民
 */
export declare function assignRolesToPlayers(state: GameState): void;
/**
 * 相容舊介面：直接建立含角色分配的玩家（測試用）
 */
export declare function createPlayers(playerCount: number, humanPlayerIndices?: number[]): Player[];
/**
 * Assign roles to players based on player count
 * Returns array of roles (shuffled) for the given player count
 */
export declare function assignRoles(playerCount: number): Role[];
/**
 * Get role counts for display/debugging
 */
export declare function getRoleCounts(players: Player[]): Record<Role, number>;
/**
 * Get alive players of a specific role
 */
export declare function getAlivePlayers(players: Player[], role?: Role): Player[];
/**
 * Get alive werewolves
 */
export declare function getAliveWerewolves(players: Player[]): Player[];
/**
 * Get alive villagers (village team)
 */
export declare function getAliveVillagers(players: Player[]): Player[];
/**
 * Check if seer can check (alive)
 */
export declare function canSeerAct(player: Player, _currentDay: number): boolean;
/**
 * Check if guard can protect (alive, not day 1)
 */
export declare function canGuardAct(player: Player, currentDay: number): boolean;
/**
 * Get seer's check history
 */
export declare function getSeerChecks(player: Player): {
    targetId: number;
    result: string;
    day: number;
}[];
/**
 * Get guard's protect history
 */
export declare function getGuardProtects(player: Player): {
    targetId: number;
    day: number;
    success: boolean;
}[];
/**
 * Format role assignment for display (GM only - never shown to players)
 */
export declare function formatRoleAssignment(players: Player[]): string;
/**
 * Format player's own role info (what each player sees at game start)
 */
export declare function formatPlayerRoleInfo(player: Player): string;
export { assignPersonalities };
//# sourceMappingURL=assignment.d.ts.map