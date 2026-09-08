/**
 * Game State Manager — Phase 0 純事件驅動狀態機
 *
 * - 所有狀態變更經由 `transition(state, event)` 單一入口（純函式：原地 mutate，
 *   開 gate 時 deadline: 0，timer 由 engine 在 phase entry 時設定）
 * - I/O 副作用（timer、LLM 分派、廣播、存檔）一律以 Effect 回傳，由 engine 執行
 * - 夜晚結算唯一來源：night.ts resolveNightActions
 * - 平票 = 無人出局（全系統唯一規則）
 */

import {
  GameState, Player, Role, Team, Phase, GameEvent, PendingGate,
  PlayerSnapshot, GMSnapshot, SpectatorSnapshot, LobbySnapshot, TransitionResult, Effect,
  NightAction, NightActionType, SeerResult, SCHEMA_VERSION,
} from './types.js';
import { assignRolesToPlayers, getAlivePlayers, getAliveWerewolves } from './assignment.js';
import { resolveNightActions } from './night.js';
import { checkWinCondition } from './day.js';
import { summarizeDay } from './character-session.js';
import { getDataDir } from './utils.js';
import { personalities } from './personalities.js';
import * as fs from 'fs';
import * as path from 'path';

function stateFile(): string {
  return path.join(getDataDir(), 'game-state.json');
}

// ============================================
// 建立
// ============================================

export function createGameState(playerCount: number, humanPlayerIndices: number[] = []): GameState {
  if (!Number.isInteger(playerCount) || playerCount < 6 || playerCount > 15) {
    throw new Error(`Player count must be between 6 and 15, got ${playerCount}`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    phase: 'SETUP_WAITING_JOIN',
    day: 0,
    players: [],
    humanPlayerIndices: [...humanPlayerIndices],
    discussionLog: [],
    votes: [],
    deathHistory: [],
    seerChecks: [],
    guardProtects: [],
    winner: null,
    gameOver: false,
    boardVersion: 0,
    daySummaries: [],
    voteReady: [],
    skippedHumans: [],
    pendingGate: null,
    expectedPlayerCount: playerCount,
    nightActions: [],
    masonChatLog: [],
  };
}

// ============================================
// 內部輔助
// ============================================

function touch(effects: Effect[]): void {
  effects.push({ type: 'BROADCAST' }, { type: 'SAVE' });
}

function openNightGate(state: GameState, effects: Effect[]): void {
  const gate: PendingGate = {
    kind: 'night',
    required: getNightActors(state),
    done: [],
    timeoutMs: 0,
    deadline: 0,
  };
  state.pendingGate = gate;
  effects.push({ type: 'ARM_GATE', gate });
  // Phase 2：只對 AI 座位派發 LLM（真人自行行動；斷線接管時由 DISCONNECT 補派）
  for (const pid of gate.required) {
    const p = state.players.find((x) => x.id === pid);
    if (p && p.controlledBy === 'ai') {
      effects.push({ type: 'DISPATCH_LLM', playerId: pid, kind: 'night' });
    }
  }
}

function openVoteGate(state: GameState, effects: Effect[]): void {
  const aliveIds = getAlivePlayers(state.players).map((p) => p.id);
  const gate: PendingGate = {
    kind: 'vote',
    required: aliveIds,
    done: [],
    timeoutMs: 0,
    deadline: 0,
  };
  state.pendingGate = gate;
  effects.push({ type: 'ARM_GATE', gate });
  for (const p of getAlivePlayers(state.players)) {
    if (p.controlledBy === 'ai') {
      effects.push({ type: 'DISPATCH_LLM', playerId: p.id, kind: 'vote' });
    }
  }
}

/** Phase 2：建立指定座位的玩家（大廳用；players 陣列依 id 排序、保持稠密） */
function makeSeatPlayer(state: GameState, playerId: number, name: string, controlledBy: 'ai' | 'human'): Player {
  const p: Player = {
    id: playerId,
    name: name || `P${playerId}`,
    role: Role.VILLAGER,   // 佔位，START_GAME 時重分配
    team: Team.VILLAGE,
    controlledBy,
    personality: personalities[(playerId - 1) % personalities.length].id,
    alive: true,
    isMasonPartner: false,
    seerChecks: [],
    guardProtects: [],
  };
  state.players.push(p);
  state.players.sort((a, b) => a.id - b.id);
  return p;
}

/** Phase 2：座位是否已被佔（存在玩家） */
function seatOccupied(state: GameState, playerId: number): boolean {
  return state.players.some((p) => p.id === playerId);
}

/** Phase 2：大廳座位加入共用（成功回傳 null；失敗回傳拒絕結果） */
function applySeatJoin(
  state: GameState, playerId: number, name: string | undefined, controlledBy: 'ai' | 'human',
): TransitionResult | null {
  if (!Number.isInteger(playerId) || playerId < 1 || playerId > state.expectedPlayerCount) {
    return { state, effects: [], accepted: false, reason: `seat P${playerId} out of range` };
  }
  const existing = state.players.find((p) => p.id === playerId);
  if (existing) {
    if (controlledBy === 'human') {
      // 座位已被 AI 佔 → 轉換為真人（name 更新）；已被真人佔 → 拒絕
      if (existing.controlledBy === 'human') {
        return { state, effects: [], accepted: false, reason: 'seat taken' };
      }
      existing.controlledBy = 'human';
      if (name) existing.name = name;
      return null;
    }
    return { state, effects: [], accepted: false, reason: 'seat taken' };
  }
  if (controlledBy === 'human') {
    // 先填補座位 1..playerId-1 的空位為 AI
    for (let id = 1; id < playerId; id++) {
      if (!seatOccupied(state, id)) makeSeatPlayer(state, id, '', 'ai');
    }
  }
  makeSeatPlayer(state, playerId, name ?? '', controlledBy);
  return null;
}

/** Phase 2：全存活真人皆已跳過發言（無真人 → false） */
export function allAliveHumansSkipped(state: GameState): boolean {
  const humans = getAlivePlayers(state.players).filter((p) => p.controlledBy === 'human');
  return humans.length > 0 && humans.every((h) => state.skippedHumans.includes(h.id));
}

/** Phase 2：大廳 snapshot */
export function buildLobbySnapshot(state: GameState): LobbySnapshot {
  const seats: LobbySnapshot['seats'] = [];
  for (let id = 1; id <= state.expectedPlayerCount; id++) {
    const p = state.players.find((x) => x.id === id);
    seats.push(p
      ? { playerId: id, name: p.name, controlledBy: p.controlledBy }
      : { playerId: id, name: '', controlledBy: 'empty' });
  }
  const started = state.phase !== 'SETUP_WAITING_JOIN' && state.phase !== 'SETUP_READY';
  return { phase: state.phase, expectedPlayerCount: state.expectedPlayerCount, seats, started };
}

/** Phase 2：斷線接管共用（翻轉為 ai + 移出 voteReady/skippedHumans；gate 內未完成 → 補派 DISPATCH_LLM） */
function applyDisconnect(state: GameState, playerId: number, effects: Effect[]): TransitionResult | null {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) {
    return { state, effects: [], accepted: false, reason: `unknown player P${playerId}` };
  }
  if (player.controlledBy === 'ai') {
    return { state, effects, accepted: true };   // 冪等：接受但無狀態變更
  }
  player.controlledBy = 'ai';
  state.voteReady = state.voteReady.filter((id) => id !== playerId);
  state.skippedHumans = state.skippedHumans.filter((id) => id !== playerId);
  const gate = state.pendingGate;
  if (gate && gate.required.includes(playerId) && !gate.done.includes(playerId)) {
    effects.push({ type: 'DISPATCH_LLM', playerId, kind: gate.kind });
  }
  return null;
}

/** Phase 2：重連拿回共用（僅存活；SETUP 階段拒絕） */
function applyReconnect(state: GameState, playerId: number): TransitionResult | null {
  if (state.phase === 'SETUP_WAITING_JOIN' || state.phase === 'SETUP_READY') {
    return { state, effects: [], accepted: false, reason: 'not started' };
  }
  const player = state.players.find((p) => p.id === playerId);
  if (!player || !player.alive) {
    return { state, effects: [], accepted: false, reason: 'not alive' };
  }
  player.controlledBy = 'human';
  return null;
}

function makeLobbyPlayer(state: GameState, name: string): Player {
  const id = state.players.length + 1;
  const slot = id - 1;
  return {
    id,
    name: name || `P${id}`,
    role: Role.VILLAGER,
    team: Team.VILLAGE,
    controlledBy: state.humanPlayerIndices.includes(slot) ? 'human' : 'ai',
    personality: personalities[slot % personalities.length].id,
    alive: true,
    isMasonPartner: false,
    seerChecks: [],
    guardProtects: [],
  };
}

function markGateDone(state: GameState, playerId: number): void {
  const gate = state.pendingGate;
  if (!gate) return;
  if (!gate.done.includes(playerId)) gate.done.push(playerId);
}

function gateComplete(state: GameState): boolean {
  const gate = state.pendingGate;
  if (!gate) return false;
  return gate.required.every((r) => gate.done.includes(r));
}

function allAliveHumansReady(state: GameState): boolean {
  const humans = getAlivePlayers(state.players).filter((p) => p.controlledBy === 'human');
  return humans.every((h) => state.voteReady.includes(h.id));
}

function applyWinCheck(state: GameState, effects: Effect[]): void {
  const winner = checkWinCondition(state);
  if (winner) {
    state.winner = winner;
    state.gameOver = true;
    state.phase = 'GAME_OVER_FINAL';
    state.pendingGate = null;
  }
}

function nightActionTypeFor(role: Role, day: number): NightActionType | null {
  switch (role) {
    case Role.SEER: return NightActionType.SEER_CHECK;
    // guard 第一天不可守護（與 getNightActors 的 day > 1 一致，否則 gate 外行動會被接受）
    case Role.GUARD: return day > 1 ? NightActionType.GUARD_PROTECT : null;
    case Role.WEREWOLF: return NightActionType.WOLF_KILL;
    default: return null;
  }
}

function recordNightAction(state: GameState, playerId: number, targetId: number): TransitionResult | null {
  const actor = state.players.find((p) => p.id === playerId);
  if (!actor || !actor.alive) {
    return { state, effects: [], accepted: false, reason: `actor P${playerId} not alive` };
  }
  const type = nightActionTypeFor(actor.role, state.day);
  if (!type) {
    return { state, effects: [], accepted: false, reason: `role ${actor.role} has no night action` };
  }
  const target = state.players.find((p) => p.id === targetId);
  if (!target || !target.alive) {
    return { state, effects: [], accepted: false, reason: `target P${targetId} not alive` };
  }
  if (targetId === playerId) {
    return { state, effects: [], accepted: false, reason: `P${playerId} 不可指定自己` };
  }
  state.nightActions = state.nightActions.filter((a) => a.actorId !== playerId);
  const action: NightAction = { type, actorId: playerId, targetId };
  state.nightActions.push(action);
  markGateDone(state, playerId);
  return null;
}

function recordVote(state: GameState, voterId: number, targetId: number): TransitionResult | null {
  const voter = state.players.find((p) => p.id === voterId);
  if (!voter || !voter.alive) {
    return { state, effects: [], accepted: false, reason: `voter P${voterId} not alive` };
  }
  const target = state.players.find((p) => p.id === targetId);
  if (!target || !target.alive) {
    return { state, effects: [], accepted: false, reason: `target P${targetId} not alive` };
  }
  state.votes = state.votes.filter((v) => !(v.voterId === voterId && v.day === state.day));
  state.votes.push({ voterId, targetId, day: state.day });
  markGateDone(state, voterId);
  return null;
}

function recordSpeech(state: GameState, playerId: number, text: string): TransitionResult | null {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || !player.alive) {
    return { state, effects: [], accepted: false, reason: `speaker P${playerId} not alive` };
  }
  state.discussionLog.push({ playerId, text, day: state.day });
  state.boardVersion++;
  return null;
}

// ============================================
// transition（純函式：原地 mutate；開 gate 時 deadline: 0）
// ============================================

export function transition(state: GameState, event: GameEvent): TransitionResult {
  // GAME_OVER_FINAL：全部忽略
  if (state.phase === 'GAME_OVER_FINAL') {
    return { state, effects: [], accepted: false, reason: 'game over' };
  }

  switch (state.phase) {
    case 'SETUP_WAITING_JOIN': {
      if (event.type === 'CLIENT_JOIN') {
        if (state.players.length >= state.expectedPlayerCount) {
          return { state, effects: [], accepted: false, reason: 'lobby full' };
        }
        state.players.push(makeLobbyPlayer(state, event.name));
        const effects: Effect[] = [];
        touch(effects);
        if (state.players.length >= state.expectedPlayerCount) {
          state.phase = 'SETUP_READY';
        }
        return { state, effects, accepted: true };
      }
      if (event.type === 'HUMAN_JOIN') {
        const r = applySeatJoin(state, event.playerId, event.name, 'human');
        if (r) return r;
        const effects: Effect[] = [];
        touch(effects);
        if (state.players.length >= state.expectedPlayerCount) {
          state.phase = 'SETUP_READY';
        }
        return { state, effects, accepted: true };
      }
      if (event.type === 'AI_JOIN') {
        const r = applySeatJoin(state, event.playerId, undefined, 'ai');
        if (r) return r;
        const effects: Effect[] = [];
        touch(effects);
        if (state.players.length >= state.expectedPlayerCount) {
          state.phase = 'SETUP_READY';
        }
        return { state, effects, accepted: true };
      }
      if (event.type === 'DISCONNECT') {
        const idx = state.players.findIndex((p) => p.id === event.playerId);
        if (idx < 0) {
          return { state, effects: [], accepted: false, reason: `unknown player P${event.playerId}` };
        }
        state.players.splice(idx, 1);
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'CLIENT_LEAVE') {
        if (state.players.length === 0) {
          return { state, effects: [], accepted: false, reason: 'lobby empty' };
        }
        state.players.pop();
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'START_GAME') {
        return { state, effects: [], accepted: false, reason: 'not enough players' };
      }
      return { state, effects: [], accepted: false, reason: `ignored in ${state.phase}` };
    }

    case 'SETUP_READY': {
      if (event.type === 'CLIENT_JOIN') {
        if (state.players.length >= state.expectedPlayerCount) {
          return { state, effects: [], accepted: false, reason: 'lobby full' };
        }
        state.players.push(makeLobbyPlayer(state, event.name));
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'HUMAN_JOIN') {
        const r = applySeatJoin(state, event.playerId, event.name, 'human');
        if (r) return r;
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'AI_JOIN') {
        const r = applySeatJoin(state, event.playerId, undefined, 'ai');
        if (r) return r;
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'DISCONNECT') {
        const idx = state.players.findIndex((p) => p.id === event.playerId);
        if (idx < 0) {
          return { state, effects: [], accepted: false, reason: `unknown player P${event.playerId}` };
        }
        state.players.splice(idx, 1);
        if (state.players.length < state.expectedPlayerCount) {
          state.phase = 'SETUP_WAITING_JOIN';
        }
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'CLIENT_LEAVE') {
        state.players.pop();
        if (state.players.length < state.expectedPlayerCount) {
          state.phase = 'SETUP_WAITING_JOIN';
        }
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'START_GAME') {
        if (state.players.length < state.expectedPlayerCount) {
          return { state, effects: [], accepted: false, reason: 'not enough players' };
        }
        assignRolesToPlayers(state);
        state.day = 1;
        state.nightActions = [];
        state.voteReady = [];
        state.skippedHumans = [];
        state.phase = 'NIGHT_COLLECTING';
        state.boardVersion++;
        const effects: Effect[] = [];
        touch(effects);
        openNightGate(state, effects);
        return { state, effects, accepted: true };
      }
      return { state, effects: [], accepted: false, reason: `ignored in ${state.phase}` };
    }

    case 'NIGHT_COLLECTING': {
      if (event.type === 'HUMAN_NIGHT_ACTION' || event.type === 'AI_NIGHT_DONE') {
        const rejected = recordNightAction(state, event.playerId, event.targetId);
        if (rejected) return rejected;
        const effects: Effect[] = [];
        touch(effects);
        if (gateComplete(state)) {
          state.pendingGate = null; // gate 已消費
          state.phase = 'NIGHT_RESOLVING';
          effects.push({ type: 'ENQUEUE', event: { type: 'RESOLVE_NIGHT' } });
        }
        return { state, effects, accepted: true };
      }
      if (event.type === 'DISCONNECT') {
        const effects: Effect[] = [];
        touch(effects);
        const r = applyDisconnect(state, event.playerId, effects);
        if (r) return r;
        return { state, effects, accepted: true };
      }
      if (event.type === 'RECONNECT') {
        const r = applyReconnect(state, event.playerId);
        if (r) return r;
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'ACTION_TIMEOUT') {
        state.pendingGate = null; // gate 已消費
        state.phase = 'NIGHT_RESOLVING';
        const effects: Effect[] = [];
        touch(effects);
        effects.push({ type: 'ENQUEUE', event: { type: 'RESOLVE_NIGHT' } });
        return { state, effects, accepted: true };
      }
      return { state, effects: [], accepted: false, reason: `ignored in ${state.phase}` };
    }

    case 'NIGHT_RESOLVING': {
      if (event.type === 'RESOLVE_NIGHT') {
        // night.ts 為夜晚結算唯一來源
        const result = resolveNightActions(state);
        // state 層 seerChecks / guardProtects（snapshot 用；Team 語義）
        if (result.seerCheckTargetId !== undefined && result.seerCheckResult !== undefined) {
          const seer = state.players.find((p) => p.role === Role.SEER);
          if (seer) {
            state.seerChecks.push({
              seerId: seer.id,
              targetId: result.seerCheckTargetId,
              result: result.seerCheckResult === SeerResult.WEREWOLF ? Team.WEREWOLF : Team.VILLAGE,
              day: state.day,
            });
          }
        }
        if (state.guardProtectedTarget !== undefined) {
          const guard = state.players.find((p) => p.role === Role.GUARD);
          if (guard) {
            state.guardProtects.push({ guardId: guard.id, targetId: state.guardProtectedTarget, day: state.day });
          }
        }
        state.boardVersion++;
        const effects: Effect[] = [];
        touch(effects);
        applyWinCheck(state, effects);
        if (!state.gameOver) {
          state.phase = 'DAY_DISCUSSION_OPEN';
        } else {
          touch(effects);
        }
        return { state, effects, accepted: true };
      }
      if (event.type === 'DISCONNECT') {
        const effects: Effect[] = [];
        touch(effects);
        const r = applyDisconnect(state, event.playerId, effects);
        if (r) return r;
        return { state, effects, accepted: true };
      }
      if (event.type === 'RECONNECT') {
        const r = applyReconnect(state, event.playerId);
        if (r) return r;
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      return { state, effects: [], accepted: false, reason: `ignored in ${state.phase}` };
    }

    case 'DAY_DISCUSSION_OPEN': {
      if (event.type === 'HUMAN_SPEAK') {
        const rejected = recordSpeech(state, event.playerId, event.text);
        if (rejected) return rejected;
        state.skippedHumans = state.skippedHumans.filter((id) => id !== event.playerId);
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'AI_SPEECH_DONE') {
        if (event.boardVersion !== state.boardVersion) {
          return { state, effects: [], accepted: false, reason: 'stale boardVersion' };
        }
        const rejected = recordSpeech(state, event.playerId, event.text);
        if (rejected) return rejected;
        state.skippedHumans = [];
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'HUMAN_SKIP') {
        const player = state.players.find((p) => p.id === event.playerId);
        if (!player || !player.alive) {
          return { state, effects: [], accepted: false, reason: `P${event.playerId} not alive` };
        }
        if (!state.skippedHumans.includes(event.playerId)) state.skippedHumans.push(event.playerId);
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'HUMAN_READY_VOTE') {
        const player = state.players.find((p) => p.id === event.playerId);
        if (!player || !player.alive) {
          return { state, effects: [], accepted: false, reason: `P${event.playerId} not alive` };
        }
        if (!state.voteReady.includes(event.playerId)) state.voteReady.push(event.playerId);
        const effects: Effect[] = [];
        touch(effects);
        if (allAliveHumansReady(state)) {
          state.phase = 'DAY_VOTING_COLLECTING';
          openVoteGate(state, effects);
        }
        return { state, effects, accepted: true };
      }
      if (event.type === 'HUMAN_UNREADY_VOTE') {
        state.voteReady = state.voteReady.filter((id) => id !== event.playerId);
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'DISCONNECT') {
        const effects: Effect[] = [];
        touch(effects);
        const r = applyDisconnect(state, event.playerId, effects);
        if (r) return r;
        return { state, effects, accepted: true };
      }
      if (event.type === 'RECONNECT') {
        const r = applyReconnect(state, event.playerId);
        if (r) return r;
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'MASON_CHAT') {
        const player = state.players.find((p) => p.id === event.playerId);
        if (!player || player.role !== Role.MASON || !player.alive) {
          return { state, effects: [], accepted: false, reason: `P${event.playerId} is not an alive mason` };
        }
        state.masonChatLog.push({ playerId: event.playerId, text: event.text, day: state.day });
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'CLOSE_DISCUSSION') {
        state.phase = 'DAY_DISCUSSION_CLOSING';
        const effects: Effect[] = [];
        touch(effects);
        // 缺口補位：全 AI 局無真人可 ready，直接開投票 gate（否則 CLOSING 永遠卡住）
        if (getAlivePlayers(state.players).filter((p) => p.controlledBy === 'human').length === 0) {
          state.phase = 'DAY_VOTING_COLLECTING';
          openVoteGate(state, effects);
        }
        return { state, effects, accepted: true };
      }
      return { state, effects: [], accepted: false, reason: `ignored in ${state.phase}` };
    }

    case 'DAY_DISCUSSION_CLOSING': {
      if (event.type === 'HUMAN_READY_VOTE' || event.type === 'HUMAN_SKIP') {
        if (!state.voteReady.includes(event.playerId)) state.voteReady.push(event.playerId);
        const effects: Effect[] = [];
        touch(effects);
        if (allAliveHumansReady(state)) {
          state.phase = 'DAY_VOTING_COLLECTING';
          openVoteGate(state, effects);
        }
        return { state, effects, accepted: true };
      }
      if (event.type === 'HUMAN_UNREADY_VOTE') {
        state.voteReady = state.voteReady.filter((id) => id !== event.playerId);
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'DISCONNECT') {
        const effects: Effect[] = [];
        touch(effects);
        const r = applyDisconnect(state, event.playerId, effects);
        if (r) return r;
        return { state, effects, accepted: true };
      }
      if (event.type === 'RECONNECT') {
        const r = applyReconnect(state, event.playerId);
        if (r) return r;
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      return { state, effects: [], accepted: false, reason: `ignored in ${state.phase}` };
    }

    case 'DAY_VOTING_COLLECTING': {
      if (event.type === 'HUMAN_VOTE' || event.type === 'AI_VOTE_DONE') {
        const rejected = recordVote(state, event.playerId, event.targetId);
        if (rejected) return rejected;
        const effects: Effect[] = [];
        touch(effects);
        if (gateComplete(state)) {
          state.pendingGate = null; // gate 已消費
          state.phase = 'DAY_VOTING_RESOLVING';
          effects.push({ type: 'ENQUEUE', event: { type: 'RESOLVE_VOTES' } });
        }
        return { state, effects, accepted: true };
      }
      if (event.type === 'DISCONNECT') {
        const effects: Effect[] = [];
        touch(effects);
        const r = applyDisconnect(state, event.playerId, effects);
        if (r) return r;
        return { state, effects, accepted: true };
      }
      if (event.type === 'RECONNECT') {
        const r = applyReconnect(state, event.playerId);
        if (r) return r;
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'ACTION_TIMEOUT') {
        state.pendingGate = null; // gate 已消費
        state.phase = 'DAY_VOTING_RESOLVING';
        const effects: Effect[] = [];
        touch(effects);
        effects.push({ type: 'ENQUEUE', event: { type: 'RESOLVE_VOTES' } });
        return { state, effects, accepted: true };
      }
      return { state, effects: [], accepted: false, reason: `ignored in ${state.phase}` };
    }

    case 'DAY_VOTING_RESOLVING': {
      if (event.type === 'RESOLVE_VOTES') {
        const tally = new Map<number, number>();
        for (const v of state.votes) {
          if (v.day !== state.day) continue;
          tally.set(v.targetId, (tally.get(v.targetId) ?? 0) + 1);
        }
        let maxVotes = 0;
        let topId: number | undefined;
        let tied = false;
        for (const [targetId, count] of tally) {
          if (count > maxVotes) {
            maxVotes = count;
            topId = targetId;
            tied = false;
          } else if (count === maxVotes) {
            tied = true;
          }
        }
        // 平票 = 無人出局（全系統唯一規則）
        if (!tied && topId !== undefined) {
          const victim = state.players.find((p) => p.id === topId && p.alive);
          if (victim) {
            victim.alive = false;
            state.deathHistory.push({ playerId: victim.id, day: state.day, cause: 'vote' });
          }
        }
        state.boardVersion++;
        const effects: Effect[] = [];
        touch(effects);
        applyWinCheck(state, effects);
        if (!state.gameOver) {
          state.phase = 'DAY_RESULT_ANNOUNCING';
        } else {
          touch(effects);
        }
        return { state, effects, accepted: true };
      }
      if (event.type === 'DISCONNECT') {
        const effects: Effect[] = [];
        touch(effects);
        const r = applyDisconnect(state, event.playerId, effects);
        if (r) return r;
        return { state, effects, accepted: true };
      }
      if (event.type === 'RECONNECT') {
        const r = applyReconnect(state, event.playerId);
        if (r) return r;
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      return { state, effects: [], accepted: false, reason: `ignored in ${state.phase}` };
    }

    case 'DAY_RESULT_ANNOUNCING': {
      if (event.type === 'DISCONNECT') {
        const effects: Effect[] = [];
        touch(effects);
        const r = applyDisconnect(state, event.playerId, effects);
        if (r) return r;
        return { state, effects, accepted: true };
      }
      if (event.type === 'RECONNECT') {
        const r = applyReconnect(state, event.playerId);
        if (r) return r;
        const effects: Effect[] = [];
        touch(effects);
        return { state, effects, accepted: true };
      }
      if (event.type === 'ADVANCE_DAY') {
        state.daySummaries.push(summarizeDay(state, state.day));
        state.day++;
        state.phase = 'NIGHT_COLLECTING';
        state.nightActions = [];
        state.voteReady = [];
        state.skippedHumans = [];
        delete state.wolfKillTarget;
        delete state.guardProtectedTarget;
        delete state.seerCheckTarget;
        delete state.seerCheckResult;
        state.boardVersion++;
        const effects: Effect[] = [];
        touch(effects);
        openNightGate(state, effects);
        return { state, effects, accepted: true };
      }
      return { state, effects: [], accepted: false, reason: `ignored in ${state.phase}` };
    }

    default:
      return { state, effects: [], accepted: false, reason: `unknown phase ${state.phase}` };
  }
}

// ============================================
// getNightActors：seer（存活）+ guard（存活且 day > 1）+ 第一隻狼（存活）
// ============================================

export function getNightActors(state: GameState): number[] {
  // Phase 2：seer（存活）+ guard（存活且 day > 1）+ 全部存活狼（狼人會議）
  const actors: number[] = [];
  const seer = state.players.find((p) => p.role === Role.SEER && p.alive);
  if (seer) actors.push(seer.id);
  const guard = state.players.find((p) => p.role === Role.GUARD && p.alive && state.day > 1);
  if (guard) actors.push(guard.id);
  for (const w of getAliveWerewolves(state.players)) actors.push(w.id);
  return actors;
}

// ============================================
// getMediumResults：由 deathHistory 推導（票死者身分）
// ============================================

export function getMediumResults(state: GameState): { targetId: number; team: Team; day: number }[] {
  const results: { targetId: number; team: Team; day: number }[] = [];
  for (const d of state.deathHistory) {
    if (d.cause !== 'vote') continue;
    const player = state.players.find((p) => p.id === d.playerId);
    if (!player) continue;
    results.push({
      targetId: d.playerId,
      team: player.role === Role.WEREWOLF ? Team.WEREWOLF : Team.VILLAGE,
      day: d.day,
    });
  }
  return results;
}

// ============================================
// buildPlayerSnapshot（per-client 過濾：永不洩漏 role/team/controlledBy）
// ============================================

// ============================================
// 公開欄位（buildPlayerSnapshot / buildSpectatorSnapshot 共用；永不含 role/team/controlledBy）
// ============================================

interface PublicSnapshotFields {
  alivePlayers: { id: number; name: string }[];
  deadPlayers: { id: number; name: string; cause: string; day: number }[];
  nightResult: string | null;
  discussionLog: { playerId: number; text: string }[];
  votes: { voterId: number; targetId: number }[];
}

function buildPublicFields(state: GameState): PublicSnapshotFields {
  const alivePlayers = getAlivePlayers(state.players).map((p) => ({ id: p.id, name: p.name }));
  const deadPlayers = state.deathHistory.map((d) => {
    const pl = state.players.find((p) => p.id === d.playerId);
    return { id: d.playerId, name: pl?.name ?? `P${d.playerId}`, cause: d.cause, day: d.day };
  });

  // nightResult：由 deathHistory 最後一筆 wolf_kill 推導（僅當天有效，否則平安夜 → null）
  let nightResult: string | null = null;
  const wolfKills = state.deathHistory.filter((d) => d.cause === 'wolf_kill');
  const lastKill = wolfKills[wolfKills.length - 1];
  if (lastKill && lastKill.day === state.day) {
    nightResult = `昨晚 P${lastKill.playerId} 遇襲身亡`;
  }

  const discussionLog = state.discussionLog
    .filter((d) => d.day === state.day)
    .map((d) => ({ playerId: d.playerId, text: d.text }));
  const votes = state.votes
    .filter((v) => v.day === state.day)
    .map((v) => ({ voterId: v.voterId, targetId: v.targetId }));

  return { alivePlayers, deadPlayers, nightResult, discussionLog, votes };
}

export function buildPlayerSnapshot(state: GameState, playerId: number): PlayerSnapshot {
  const me = state.players.find((p) => p.id === playerId);
  if (!me) throw new Error(`unknown player P${playerId}`);

  const pub = buildPublicFields(state);

  const you: PlayerSnapshot['you'] = { role: me.role, team: me.team };
  if (me.role === Role.SEER) {
    you.seerChecks = state.seerChecks
      .filter((c) => c.seerId === playerId)
      .map((c) => ({ targetId: c.targetId, result: c.result, day: c.day }));
  }
  if (me.role === Role.GUARD) {
    you.guardProtects = state.guardProtects
      .filter((g) => g.guardId === playerId)
      .map((g) => ({ targetId: g.targetId, day: g.day }));
  }
  if (me.role === Role.MEDIUM) {
    you.mediumResults = getMediumResults(state);
  }
  if (me.role === Role.MASON) {
    you.masonPartnerId = me.masonPartnerId;
    you.masonChatLog = state.masonChatLog.map((m) => ({ playerId: m.playerId, text: m.text }));
  }
  if (me.role === Role.WEREWOLF) {
    you.wolfAllyIds = getAliveWerewolves(state.players)
      .map((w) => w.id)
      .filter((id) => id !== playerId);
    // Phase 2：狼人會議目前提交（僅狼；內容只有 wolfId/targetId，無 controlledBy）
    you.wolfMeeting = state.nightActions
      .filter((a) => a.type === NightActionType.WOLF_KILL)
      .map((a) => ({ wolfId: a.actorId, targetId: a.targetId }));
  }

  // Phase 2：gate 公開資訊（無身分洩漏）
  const gate = state.pendingGate;
  const canAct = gate !== null
    && gate.required.includes(playerId)
    && !gate.done.includes(playerId);
  you.canAct = canAct;

  return {
    phase: state.phase,
    day: state.day,
    ...pub,
    winner: state.winner,
    gameOver: state.gameOver,
    gateDeadline: gate?.deadline ?? null,
    you,
  };
}

// ============================================
// buildSpectatorSnapshot（觀戰者視角：公開欄位，不含 you，永不洩漏角色）
// ============================================

export function buildSpectatorSnapshot(state: GameState): SpectatorSnapshot {
  return {
    phase: state.phase,
    day: state.day,
    ...buildPublicFields(state),
    winner: state.winner,
    gameOver: state.gameOver,
  };
}

// ============================================
// buildGMSnapshot（GM 全貌，含 role/team/controlledBy）
// ============================================

export function buildGMSnapshot(state: GameState): GMSnapshot {
  return {
    phase: state.phase,
    day: state.day,
    players: state.players.map((p) => ({ ...p })),
    discussionLog: state.discussionLog.map((d) => ({ playerId: d.playerId, text: d.text, day: d.day })),
    votes: state.votes.map((v) => ({ voterId: v.voterId, targetId: v.targetId, day: v.day })),
    deathHistory: state.deathHistory.map((d) => ({ playerId: d.playerId, cause: d.cause, day: d.day })),
    boardVersion: state.boardVersion,
    pendingGate: state.pendingGate ? { ...state.pendingGate } : null,
    voteReady: [...state.voteReady],
  };
}

// ============================================
// 持久化：原子寫入（tmp → rename），載入檢查 schemaVersion
// ============================================

export function saveState(state: GameState): void {
  const file = stateFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export function loadState(): GameState | null {
  const file = stateFile();
  try {
    if (!fs.existsSync(file)) return null;
    const data = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(data) as GameState;
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

// 供 engine 判斷 phase 集合（RESOLVING / ANNOUNCING 自動推進用）
export const AUTO_ADVANCE_PHASES: Phase[] = ['NIGHT_RESOLVING', 'DAY_VOTING_RESOLVING', 'DAY_RESULT_ANNOUNCING'];
