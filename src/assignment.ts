/**
 * Role Assignment Logic
 * Assigns roles to players based on the player count table from rules
 */

import { Role, ROLE_CONFIG, Team, Player, ROLE_TEAM, getDisplayName, getDescription } from './types.js';
import { shuffleArray, randomInt } from './utils.js';
import { assignPersonalities } from './personalities.js';

/**
 * Assign roles to players based on player count
 * Returns array of roles (shuffled) for the given player count
 */
export function assignRoles(playerCount: number): Role[] {
  if (playerCount < 6 || playerCount > 15) {
    throw new Error(`Player count must be between 6 and 15, got ${playerCount}`);
  }

  const config = ROLE_CONFIG[playerCount];
  if (!config) {
    throw new Error(`No role configuration for ${playerCount} players`);
  }

  const roles: Role[] = [];
  
  // Add roles according to config
  for (const [role, count] of Object.entries(config)) {
    for (let i = 0; i < count; i++) {
      roles.push(role as Role);
    }
  }

  // Verify total matches player count
  if (roles.length !== playerCount) {
    throw new Error(`Role assignment error: ${roles.length} roles for ${playerCount} players`);
  }

  // Shuffle roles randomly
  return shuffleArray(roles);
}

/**
 * Create player objects with assigned roles
 */
export function createPlayers(playerCount: number, humanPlayerIndex?: number): Player[] {
  const roles = assignRoles(playerCount);
  const players: Player[] = [];

  for (let i = 0; i < playerCount; i++) {
    const playerId = i + 1;
    const role = roles[i];
    const isHuman = humanPlayerIndex !== undefined && humanPlayerIndex === i;
    
    players.push({
      id: playerId,
      name: `P${playerId}`,
      role,
      team: ROLE_TEAM[role],
      alive: true,
      isHuman,
      seerChecks: [],
      guardProtects: [],
    });
  }

  // Set up mason partners
  const masons = players.filter(p => p.role === Role.MASON);
  if (masons.length === 2) {
    masons[0].masonPartnerId = masons[1].id;
    masons[1].masonPartnerId = masons[0].id;
  }

  // 分配人格
  const assignedPersonalities = assignPersonalities(playerCount);
  for (let i = 0; i < players.length; i++) {
    players[i].personality = assignedPersonalities[i];
  }

  return players;
}

/**
 * Get role counts for display/debugging
 */
export function getRoleCounts(players: Player[]): Record<Role, number> {
  const counts: Partial<Record<Role, number>> = {};
  for (const player of players) {
    counts[player.role] = (counts[player.role] || 0) + 1;
  }
  return counts as Record<Role, number>;
}

/**
 * Get alive players of a specific role
 */
export function getAlivePlayers(players: Player[], role?: Role): Player[] {
  return players.filter(p => p.alive && (!role || p.role === role));
}

/**
 * Get alive werewolves
 */
export function getAliveWerewolves(players: Player[]): Player[] {
  return getAlivePlayers(players, Role.WEREWOLF);
}

/**
 * Get alive villagers (village team)
 */
export function getAliveVillagers(players: Player[]): Player[] {
  return players.filter(p => p.alive && p.team === Team.VILLAGE);
}

/**
 * Check if seer can check (alive and has not checked this night)
 * In this implementation, seer checks once per night
 */
export function canSeerAct(player: Player, currentDay: number): boolean {
  return player.alive && player.role === Role.SEER;
}

/**
 * Check if guard can protect (alive, not day 1)
 */
export function canGuardAct(player: Player, currentDay: number): boolean {
  return player.alive && player.role === Role.GUARD && currentDay > 1;
}

/**
 * Get seer's check history
 */
export function getSeerChecks(player: Player): { targetId: number; result: string; day: number }[] {
  if (!player.seerChecks) return [];
  return player.seerChecks.map(c => ({
    targetId: c.targetId,
    result: c.result,
    day: c.day,
  }));
}

/**
 * Get guard's protect history
 */
export function getGuardProtects(player: Player): { targetId: number; day: number; success: boolean }[] {
  if (!player.guardProtects) return [];
  return player.guardProtects.map(p => ({
    targetId: p.targetId,
    day: p.day,
    success: p.success,
  }));
}

/**
 * Format role assignment for display (GM only - never shown to players)
 */
export function formatRoleAssignment(players: Player[]): string {
  const lines = ['=== 角色分配 (GM視角) ==='];
  for (const player of players) {
    lines.push(`${player.name}: ${getDisplayName(player.role)}`);
  }
  return lines.join('\n');
}

/**
 * Format player's own role info (what each player sees at game start)
 */
export function formatPlayerRoleInfo(player: Player): string {
  let info = `你的身分是：${getDisplayName(player.role)}\n`;
  info += `${getDescription(player.role)}\n`;
  
  if (player.role === Role.WEREWOLF) {
    const wolfAllies = getAlivePlayers(
      [] as Player[], // Will be filled by game engine
      Role.WEREWOLF
    );
    // This will be set by game engine with full player list
  }
  
  if (player.role === Role.MASON && player.masonPartnerId) {
    info += `你的共有者夥伴是：P${player.masonPartnerId}\n`;
  }
  
  return info;
}