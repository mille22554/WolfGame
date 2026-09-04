/**
 * Werewolf Game Types
 * Core type definitions for the game engine
 */

import { Personality } from './personalities.js';

// ============================================
// Role Definitions
// ============================================

export enum Role {
  VILLAGER = 'villager',           // 村民
  SEER = 'seer',                   // 占い師
  MEDIUM = 'medium',               // 靈能者
  GUARD = 'guard',                 // 獵人（守衛/狩人）
  MASON = 'mason',                 // 共有者
  WEREWOLF = 'werewolf',           // 人狼
  MADMAN = 'madman',               // 狂人
}

export enum Team {
  VILLAGE = 'village',             // 村人陣營
  WEREWOLF = 'werewolf',           // 人狼陣營
}

export enum Phase {
  SETUP = 'setup',
  NIGHT = 'night',
  DAY_DISCUSSION = 'day_discussion',
  DAY_VOTING = 'day_voting',
  DAY_RESULT = 'day_result',
  GAME_OVER = 'game_over',
}

export enum NightActionType {
  WOLF_KILL = 'wolf_kill',
  SEER_CHECK = 'seer_check',
  GUARD_PROTECT = 'guard_protect',
  // Medium has no active action - receives info passively
  // Masons have private chat (handled separately)
}

export enum SeerResult {
  VILLAGER = 'villager',    // 村人 (includes Madman, Mason, Villager)
  WEREWOLF = 'werewolf',    // 人狼
}

export enum MediumResult {
  VILLAGER = 'villager',
  WEREWOLF = 'werewolf',
}

// ============================================
// Player & Game State
// ============================================

export interface Player {
  id: number;                    // 1-based player number (P1, P2, ...)
  name: string;                  // "P1", "P2", etc.
  role: Role;
  team: Team;
  alive: boolean;
  isHuman: boolean;              // true for human player, false for AI
  // Night action choices (set during night, resolved at dawn)
  nightAction?: NightAction;
  // For seer: history of checks { targetId, result, day }
  seerChecks?: SeerCheck[];
  // For guard: history of protects { targetId, day }
  guardProtects?: GuardProtect[];
  // For masons: partner player id
  masonPartnerId?: number;
  personality?: Personality;  // 玩家的人格設定
}

export interface NightAction {
  type: NightActionType;
  targetId: number;              // Target player ID
  actorId: number;               // Acting player ID
}

export interface SeerCheck {
  targetId: number;
  result: SeerResult;
  day: number;
}

export interface GuardProtect {
  targetId: number;
  day: number;
  success: boolean;              // Whether protection blocked a kill
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
  // Role is NOT public - only medium learns vote deaths
}

// ============================================
// Game State
// ============================================

export interface GameState {
  // Core setup
  players: Player[];
  day: number;                   // Current day (1-indexed)
  phase: Phase;
  
  // Night tracking
  nightActions: NightAction[];   // Actions submitted this night
  wolfKillTarget?: number;       // Resolved wolf kill target
  guardProtectedTarget?: number; // Resolved guard protect target
  seerCheckTarget?: number;      // Resolved seer check target
  seerCheckResult?: SeerResult;  // Result of seer check
  
  // Day tracking
  votes: Vote[];                 // Votes cast this day
  eliminatedPlayerId?: number;   // Player eliminated by vote
  eliminatedPlayerRole?: Role;   // Role of eliminated (only for medium/GM)
  
  // History
  deathHistory: DeathRecord[];   // All deaths in order
  discussionLog: DiscussionEntry[]; // Public discussion
  masonChatLog: MasonChatEntry[];   // Private mason chat
  
  // Win state
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

// ============================================
// Role Configuration (from rules)
// ============================================

export interface RoleConfig {
  [playerCount: number]: {
    [role in Role]?: number;
  };
}

export const ROLE_CONFIG: RoleConfig = {
  6: { [Role.VILLAGER]: 2, [Role.SEER]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 1, [Role.MADMAN]: 1 },
  7: { [Role.VILLAGER]: 3, [Role.SEER]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 1, [Role.MADMAN]: 1 },
  8: { [Role.VILLAGER]: 2, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
  9: { [Role.VILLAGER]: 3, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
  10: { [Role.VILLAGER]: 4, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
  11: { [Role.VILLAGER]: 5, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
  12: { [Role.VILLAGER]: 6, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
  13: { [Role.VILLAGER]: 4, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.MASON]: 2, [Role.WEREWOLF]: 3, [Role.MADMAN]: 1 },
  14: { [Role.VILLAGER]: 5, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.MASON]: 2, [Role.WEREWOLF]: 3, [Role.MADMAN]: 1 },
  15: { [Role.VILLAGER]: 6, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.MASON]: 2, [Role.WEREWOLF]: 3, [Role.MADMAN]: 1 },
};

// ============================================
// Role Metadata
// ============================================

export const ROLE_TEAM: Record<Role, Team> = {
  [Role.VILLAGER]: Team.VILLAGE,
  [Role.SEER]: Team.VILLAGE,
  [Role.MEDIUM]: Team.VILLAGE,
  [Role.GUARD]: Team.VILLAGE,
  [Role.MASON]: Team.VILLAGE,
  [Role.WEREWOLF]: Team.WEREWOLF,
  [Role.MADMAN]: Team.VILLAGE,  // Madman is human team but wins with wolves
};

export const ROLE_DISPLAY: Record<Role, string> = {
  // 守衛即獵人/狩人（顯示為「獵人」以對應官方與截圖）
  [Role.VILLAGER]: '村民 🟢',
  [Role.SEER]: '占い師 🔮',
  [Role.MEDIUM]: '靈能者 👁️',
  [Role.GUARD]: '獵人 🛡️', // 獵人（狩人/守衛）
  [Role.MASON]: '共有者 🤝',
  [Role.WEREWOLF]: '人狼 🔴',
  [Role.MADMAN]: '狂人 🤡',
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  // 守衛即獵人/狩人
  [Role.VILLAGER]: '無特殊能力，靠推理與投票找出人狼',
  [Role.SEER]: '每夜選一名存活玩家查驗，結果為「村人」或「人狼」（狂人顯示為村人）',
  [Role.MEDIUM]: '只能得知白天被投票出局者的身分（「村人」或「人狼」），夜間被殺者無法得知',
  [Role.GUARD]: '獵人（狩人/守衛）：每夜守護一人免於人狼襲擊，可連續守護同一人，第一天不可守護',
  [Role.MASON]: '雙人組，互相知道對方身分，夜間可私聊，查驗結果為「村人」',
  [Role.WEREWOLF]: '夜間互相認識並合謀，全體共同選擇一人殺害，查驗結果為「人狼」',
  [Role.MADMAN]: '為人類陣營效力但不知同夥誰，無特殊能力，查驗結果為「村人」，人狼勝則狂人勝',
};

// ============================================
// Utility Functions
// ============================================

export function getTeam(role: Role): Team {
  return ROLE_TEAM[role];
}

export function getDisplayName(role: Role): string {
  return ROLE_DISPLAY[role];
}

export function getDescription(role: Role): string {
  return ROLE_DESCRIPTION[role];
}

export function isVillageTeam(role: Role): boolean {
  return ROLE_TEAM[role] === Team.VILLAGE;
}

export function isWerewolfTeam(role: Role): boolean {
  return ROLE_TEAM[role] === Team.WEREWOLF;
}

export function seerSeesAs(targetRole: Role): SeerResult {
  // Seer sees Werewolf as Werewolf, everything else as Villager (including Madman, Mason)
  return targetRole === Role.WEREWOLF ? SeerResult.WEREWOLF : SeerResult.VILLAGER;
}

export function mediumSeesAs(targetRole: Role): MediumResult {
  // Medium sees Werewolf as Werewolf, everything else as Villager (cannot distinguish Madman)
  return targetRole === Role.WEREWOLF ? MediumResult.WEREWOLF : MediumResult.VILLAGER;
}