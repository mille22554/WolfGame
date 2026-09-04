/**
 * Game State Manager — 純狀態機，不生成任何對話
 * 所有對話和決策由 GM（遊戲主持人）在外部處理
 */

import {
  GameState, Player, Role, Team, Phase,
  NightAction, NightActionType, Vote, DiscussionEntry, DeathRecord,
} from './types.js';
import { assignRoles, createPlayers, getAlivePlayers, getAliveWerewolves, getAliveVillagers } from './assignment.js';
import { resolveNightActions, getMediumInfoAtDawn, formatNightResult, formatSeerResult, formatGuardResult, formatMediumResult } from './night.js';
import { checkWinCondition, formatDayStart, formatVotingResultPublic, formatVotingResultForMedium, formatDiscussionPrompt, getGameStatus } from './day.js';
import { pickRandom } from './utils.js';
import * as fs from 'fs';
import * as path from 'path';

const STATE_FILE = path.join(process.cwd(), 'game-state.json');

export interface GMNightActions {
  seerCheck?: number;      // target player ID
  wolfKill?: number;       // target player ID
  guardProtect?: number;   // target player ID
}

export interface GMVote {
  voterId: number;
  targetId: number;
}

export interface GameStateSnapshot {
  day: number;
  phase: string;
  alivePlayers: { id: number; name: string; role: string; team: string; personality?: string }[];
  deadPlayers: { id: number; name: string; day: number; cause: string }[];
  nightResult?: string;
  seerInfo?: string;       // only if seer is alive
  guardInfo?: string;      // only if guard is alive
  mediumInfo?: string;     // only if medium is alive
  discussionLog: { playerId: number; playerName: string; message: string; day: number }[];
  votes: { voterId: number; targetId: number; day: number }[];
  winner?: string;
  gameOver: boolean;
}

/**
 * Initialize a new game
 */
export function initGame(playerCount: number): GameState {
  const players = createPlayers(playerCount);
  const gameState: GameState = {
    players,
    day: 0,
    phase: Phase.SETUP,
    nightActions: [],
    votes: [],
    deathHistory: [],
    discussionLog: [],
    masonChatLog: [],
    gameOver: false,
  };
  saveState(gameState);
  return gameState;
}

/**
 * Save game state to file
 */
export function saveState(state: GameState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Load game state from file
 */
export function loadState(): GameState {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error('No game state file found. Run "node gm.js init <playerCount>" first.');
  }
  const data = fs.readFileSync(STATE_FILE, 'utf-8');
  return JSON.parse(data) as GameState;
}

/**
 * Get current state as a snapshot for GM
 */
export function getStateSnapshot(state: GameState): GameStateSnapshot {
  const alivePlayers = getAlivePlayers(state.players);
  const deadPlayers = state.deathHistory.map(d => {
    const player = state.players.find(p => p.id === d.playerId);
    return {
      id: d.playerId,
      name: player?.name || `P${d.playerId}`,
      day: d.day,
      cause: d.cause,
    };
  });

  // Get private info for special roles
  let seerInfo: string | undefined;
  let guardInfo: string | undefined;
  let mediumInfo: string | undefined;

  const seer = state.players.find(p => p.role === Role.SEER && p.alive);
  if (seer && seer.seerChecks && seer.seerChecks.length > 0) {
    const lastCheck = seer.seerChecks[seer.seerChecks.length - 1];
    const target = state.players.find(p => p.id === lastCheck.targetId);
    seerInfo = `你查驗了 ${target?.name || `P${lastCheck.targetId}`}，結果是：${lastCheck.result === 'werewolf' ? '人狼 🔴' : '村人 🟢'}`;
  }

  const guard = state.players.find(p => p.role === Role.GUARD && p.alive);
  if (guard && guard.guardProtects && guard.guardProtects.length > 0) {
    const lastProtect = guard.guardProtects[guard.guardProtects.length - 1];
    const target = state.players.find(p => p.id === lastProtect.targetId);
    guardInfo = `你守護了 ${target?.name || `P${lastProtect.targetId}`}，${lastProtect.success ? '成功擋殺' : '沒有狼人來殺'}`;
  }

  const mediumInfoResult = getMediumInfoAtDawn(state);
  if (mediumInfoResult) {
    const fmt = formatMediumResult(mediumInfoResult);
    if (fmt) mediumInfo = fmt;
  }

  return {
    day: state.day,
    phase: state.phase,
    alivePlayers: alivePlayers.map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      team: p.team,
      personality: p.personality?.id,
    })),
    deadPlayers,
    seerInfo,
    guardInfo,
    mediumInfo,
    discussionLog: state.discussionLog.map(d => ({
      playerId: d.playerId,
      playerName: state.players.find(p => p.id === d.playerId)?.name || `P${d.playerId}`,
      message: d.message,
      day: d.day,
    })),
    votes: state.votes.map(v => ({
      voterId: v.voterId,
      targetId: v.targetId,
      day: v.day,
    })),
    winner: state.winner,
    gameOver: state.gameOver,
  };
}

/**
 * Start a new day cycle (night phase)
 */
export function startDay(state: GameState): GameState {
  state.day++;
  state.phase = Phase.NIGHT;
  state.nightActions = [];
  saveState(state);
  return state;
}

/**
 * Process night actions from GM decisions
 */
export function processNight(state: GameState, actions: GMNightActions): { nightResult: any; state: GameState } {
  // Build night actions
  const nightActions: NightAction[] = [];

  if (actions.seerCheck !== undefined) {
    const seer = state.players.find(p => p.role === Role.SEER && p.alive);
    if (seer) {
      nightActions.push({
        type: NightActionType.SEER_CHECK,
        actorId: seer.id,
        targetId: actions.seerCheck,
      });
    }
  }

  if (actions.wolfKill !== undefined) {
    const wolves = getAliveWerewolves(state.players);
    if (wolves.length > 0) {
      // Use first wolf as actor (they coordinate anyway)
      nightActions.push({
        type: NightActionType.WOLF_KILL,
        actorId: wolves[0].id,
        targetId: actions.wolfKill,
      });
    }
  }

  if (actions.guardProtect !== undefined) {
    const guard = state.players.find(p => p.role === Role.GUARD && p.alive);
    if (guard) {
      nightActions.push({
        type: NightActionType.GUARD_PROTECT,
        actorId: guard.id,
        targetId: actions.guardProtect,
      });
    }
  }

  state.nightActions = nightActions;

  // Resolve night actions
  const nightResult = resolveNightActions(state);

  // Apply deaths - resolveNightActions already applied kill & deathHistory,
  // but spec's duplicate logic is guarded to avoid double-record
  if (nightResult.killedPlayerId !== undefined && !nightResult.killBlocked) {
    const victim = state.players.find(p => p.id === nightResult.killedPlayerId);
    if (victim) {
      // resolveNightActions already set victim.alive = false and pushed deathHistory
      // Only ensure deathHistory not duplicated
      const alreadyRecorded = state.deathHistory.some(d => d.playerId === victim.id && d.day === state.day && d.cause === 'wolf_kill');
      if (!alreadyRecorded) {
        victim.alive = false;
        state.deathHistory.push({
          playerId: victim.id,
          day: state.day,
          cause: 'wolf_kill',
        });
      }
    }
  }

  // Check win condition
  const winner = checkWinCondition(state);
  if (winner) {
    state.winner = winner;
    state.gameOver = true;
  }

  state.phase = Phase.DAY_DISCUSSION;
  saveState(state);

  return { nightResult, state };
}

/**
 * Record a discussion message from a player
 */
export function addMessage(state: GameState, playerId: number, message: string): GameState {
  const player = state.players.find(p => p.id === playerId);
  state.discussionLog.push({
    playerId,
    playerName: player?.name || `P${playerId}`,
    message,
    day: state.day,
    phase: 'discussion',
  });
  saveState(state);
  return state;
}

/**
 * Process votes from GM decisions
 */
export function processVotes(state: GameState, votes: GMVote[]): { eliminatedPlayerId?: number; eliminatedPlayerRole?: Role; state: GameState } {
  // Record votes
  for (const vote of votes) {
    state.votes.push({
      voterId: vote.voterId,
      targetId: vote.targetId,
      day: state.day,
    });
  }

  // Count votes
  const voteCounts = new Map<number, number>();
  for (const vote of votes) {
    voteCounts.set(vote.targetId, (voteCounts.get(vote.targetId) || 0) + 1);
  }

  // Find player with most votes
  let maxVotes = 0;
  let eliminatedPlayerId: number | undefined;
  let tie = false;

  for (const [targetId, count] of voteCounts) {
    if (count > maxVotes) {
      maxVotes = count;
      eliminatedPlayerId = targetId;
      tie = false;
    } else if (count === maxVotes) {
      tie = true;
    }
  }

  // Handle tie - no elimination
  if (tie) {
    eliminatedPlayerId = undefined;
  }

  // Eliminate player
  if (eliminatedPlayerId !== undefined) {
    const victim = state.players.find(p => p.id === eliminatedPlayerId);
    if (victim) {
      victim.alive = false;
      state.deathHistory.push({
        playerId: victim.id,
        day: state.day,
        cause: 'vote',
      });
    }
  }

  // Check win condition
  const winner = checkWinCondition(state);
  if (winner) {
    state.winner = winner;
    state.gameOver = true;
  }

  saveState(state);

  return {
    eliminatedPlayerId,
    eliminatedPlayerRole: eliminatedPlayerId !== undefined
      ? state.players.find(p => p.id === eliminatedPlayerId)?.role
      : undefined,
    state,
  };
}

/**
 * Reveal all roles (end of game)
 */
export function revealRoles(state: GameState): { id: number; name: string; role: string; team: string; alive: boolean }[] {
  return state.players.map(p => ({
    id: p.id,
    name: p.name,
    role: p.role,
    team: p.team,
    alive: p.alive,
  }));
}
