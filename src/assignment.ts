/**
 * Role Assignment Logic — Phase 0
 * 角色分配演算法沿用現有（ROLE_CONFIG 表）
 */

import { Role, ROLE_CONFIG, Team, Player, GameState, ROLE_TEAM, getDisplayName, getDescription } from './types.js';
import { shuffleArray } from './utils.js';
import { personalities, assignPersonalities } from './personalities.js';

/** 依序取 personality id（lobby 佔位用） */
function personalityIdForSlot(slot: number): string {
  return personalities[slot % personalities.length].id;
}

/**
 * 建立大廳佔位玩家：全部 VILLAGER + 依序 personality，
 * controlledBy 依 humanPlayerIndices（缺口補位：humanPlayerIndices 為選填，預設全 ai）
 */
export function createLobbyPlayers(playerCount: number, humanPlayerIndices: number[] = []): Player[] {
  if (playerCount < 6 || playerCount > 15) {
    throw new Error(`Player count must be between 6 and 15, got ${playerCount}`);
  }
  const players: Player[] = [];
  for (let i = 0; i < playerCount; i++) {
    const id = i + 1;
    players.push({
      id,
      name: `P${id}`,
      role: Role.VILLAGER,
      team: Team.VILLAGE,
      controlledBy: humanPlayerIndices.includes(i) ? 'human' : 'ai',
      personality: personalityIdForSlot(i),
      alive: true,
      isMasonPartner: false,
      seerChecks: [],
      guardProtects: [],
    });
  }
  return players;
}

/**
 * START_GAME 時呼叫：覆寫 role/team/isMasonPartner（並配對 masonPartnerId）
 * 角色分配演算法沿用現有 ROLE_CONFIG：
 * 狼人 1–3（依人數）、占卜師 1、守衛 1、靈能者（8+ 人）、共有者（13+ 人）、狂人 1、其餘村民
 */
export function assignRolesToPlayers(state: GameState): void {
  const roles = assignRoles(state.players.length);
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    p.role = roles[i];
    p.team = ROLE_TEAM[roles[i]];
    p.isMasonPartner = false;
    p.masonPartnerId = undefined;
    p.seerChecks = [];
    p.guardProtects = [];
  }
  // 共有者配對（狼人以外的 2 人；現有配置僅 13+ 人局有 MASON）
  const masons = state.players.filter((p) => p.role === Role.MASON);
  if (masons.length === 2) {
    masons[0].masonPartnerId = masons[1].id;
    masons[1].masonPartnerId = masons[0].id;
    masons[0].isMasonPartner = true;
    masons[1].isMasonPartner = true;
  }
}

/**
 * 相容舊介面：直接建立含角色分配的玩家（測試用）
 */
export function createPlayers(playerCount: number, humanPlayerIndices: number[] = []): Player[] {
  const players = createLobbyPlayers(playerCount, humanPlayerIndices);
  const roles = assignRoles(playerCount);
  for (let i = 0; i < players.length; i++) {
    players[i].role = roles[i];
    players[i].team = ROLE_TEAM[roles[i]];
  }
  const masons = players.filter((p) => p.role === Role.MASON);
  if (masons.length === 2) {
    masons[0].masonPartnerId = masons[1].id;
    masons[1].masonPartnerId = masons[0].id;
    masons[0].isMasonPartner = true;
    masons[1].isMasonPartner = true;
  }
  return players;
}

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

  for (const [role, count] of Object.entries(config)) {
    for (let i = 0; i < count!; i++) {
      roles.push(role as Role);
    }
  }

  if (roles.length !== playerCount) {
    throw new Error(`Role assignment error: ${roles.length} roles for ${playerCount} players`);
  }

  return shuffleArray(roles);
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
  return players.filter((p) => p.alive && (!role || p.role === role));
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
  return players.filter((p) => p.alive && p.team === Team.VILLAGE);
}

/**
 * Check if seer can check (alive)
 */
export function canSeerAct(player: Player, _currentDay: number): boolean {
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
  return player.seerChecks.map((c) => ({
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
  return player.guardProtects.map((p) => ({
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

  if (player.role === Role.MASON && player.masonPartnerId) {
    info += `你的共有者夥伴是：P${player.masonPartnerId}\n`;
  }

  return info;
}

// 保留再匯出，供 Phase 1 沿用
export { assignPersonalities };
