/**
 * Role Assignment Logic
 * Assigns roles to players based on the player count table from rules
 */
import { Role, Player } from './types.js';
/**
 * Assign roles to players based on player count
 * Returns array of roles (shuffled) for the given player count
 */
export declare function assignRoles(playerCount: number): Role[];
/**
 * Create player objects with assigned roles
 */
export declare function createPlayers(playerCount: number, humanPlayerIndex?: number): Player[];
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
 * Check if seer can check (alive and has not checked this night)
 * In this implementation, seer checks once per night
 */
export declare function canSeerAct(player: Player, currentDay: number): boolean;
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
//# sourceMappingURL=assignment.d.ts.map