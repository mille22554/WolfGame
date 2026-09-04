/**
 * 遊戲驅動器：由程式碼直接呼叫 LLM Provider，依序驅動各角色 session
 * 討論保持順序執行，不做平行呼叫
 */

import { GameState, Role, Team } from './types.js';
import { GMNightActions, addMessage, initGame, startDay, processNight, processVotes } from './game-state.js';
import { getAlivePlayers, getAliveWerewolves } from './assignment.js';
import { CharacterSession } from './character-session.js';
import { LLMProvider } from './llm.js';

/**
 * 白天討論：每個存活且非 human 的玩家依序發言，並記錄到 discussionLog
 */
export async function runDiscussion(gameState: GameState, provider: LLMProvider): Promise<void> {
  const speakers = getAlivePlayers(gameState.players).filter((p) => !p.isHuman);
  for (const player of speakers) {
    const session = new CharacterSession(player.id, provider, gameState);
    const text = await session.speak();
    addMessage(gameState, player.id, text);
  }
}

/**
 * 白天投票：每個存活玩家依序投票，收集 {voterId, targetId}（解析失敗跳過）
 */
export async function runVoting(
  gameState: GameState,
  provider: LLMProvider,
): Promise<{ voterId: number; targetId: number }[]> {
  const voters = getAlivePlayers(gameState.players);
  const result: { voterId: number; targetId: number }[] = [];
  for (const player of voters) {
    const session = new CharacterSession(player.id, provider, gameState);
    const targetId = await session.vote();
    if (targetId === -1) continue;
    result.push({ voterId: player.id, targetId });
  }
  return result;
}

/**
 * 夜間行動：狼（第一個存活狼）、預言家、守衛各自決策，組出 GMNightActions
 */
export async function runNight(gameState: GameState, provider: LLMProvider): Promise<GMNightActions> {
  const actions: GMNightActions = {};

  const wolves = getAliveWerewolves(gameState.players);
  if (wolves.length > 0) {
    const session = new CharacterSession(wolves[0].id, provider, gameState);
    const action = await session.nightAction();
    if (action) actions.wolfKill = action.targetId;
  }

  const seer = getAlivePlayers(gameState.players).find((p) => p.role === Role.SEER);
  if (seer) {
    const session = new CharacterSession(seer.id, provider, gameState);
    const action = await session.nightAction();
    if (action) actions.seerCheck = action.targetId;
  }

  const guard = getAlivePlayers(gameState.players).find((p) => p.role === Role.GUARD);
  if (guard) {
    const session = new CharacterSession(guard.id, provider, gameState);
    const action = await session.nightAction();
    if (action) actions.guardProtect = action.targetId;
  }

  return actions;
}

export interface RunGameOptions {
  /** 最多進行天數（防無限迴圈），預設 100 */
  maxDays?: number;
  /** 是否印出每步摘要，預設 false */
  verbose?: boolean;
}

/**
 * 一鍵跑完整局：從初始化一路自動進行到分出勝負
 * GM（裁判）不需 AI，規則由狀態機處理；AI 只用於玩家角色決策
 */
export async function runGame(
  provider: LLMProvider,
  playerCount: number,
  options?: RunGameOptions,
): Promise<GameState> {
  const maxDays = options?.maxDays ?? 100;
  const verbose = options?.verbose ?? false;

  let state = initGame(playerCount);
  if (verbose) {
    console.log(`🎮 遊戲開始：${playerCount} 位玩家`);
  }

  while (state.day < maxDays && !state.gameOver) {
    // 1. 開始新的一天（夜晚階段）
    state = startDay(state);
    if (verbose) {
      console.log(`\n📅 第 ${state.day} 天開始`);
    }

    // 2. 夜間行動
    const actions = await runNight(state, provider);
    const { nightResult, state: afterNight } = processNight(state, actions);
    state = afterNight;
    if (verbose) {
      if (nightResult.killBlocked) {
        console.log('🛡️ 夜間：守衛成功擋殺');
      } else if (nightResult.killedPlayerId !== undefined) {
        console.log(`💀 夜間：犧牲者 P${nightResult.killedPlayerId}（身分不公開）`);
      } else {
        console.log('🌅 夜間：平安夜');
      }
    }

    // 夜間後若已分出勝負則結束
    if (state.gameOver) break;

    // 3. 白天討論
    const beforeDiscuss = state.discussionLog.length;
    await runDiscussion(state, provider);
    if (verbose) {
      const count = state.discussionLog.length - beforeDiscuss;
      console.log(`💬 討論完成（${count} 則發言）`);
    }

    // 4. 白天投票
    const votes = await runVoting(state, provider);
    const { eliminatedPlayerId, state: afterVotes } = processVotes(state, votes);
    state = afterVotes;
    if (verbose) {
      if (eliminatedPlayerId !== undefined) {
        console.log(`🗳️ 投票：P${eliminatedPlayerId} 被投票出局（身分不公開）`);
      } else {
        console.log('🗳️ 投票：無人被投票出局');
      }
    }
  }

  if (verbose) {
    if (state.gameOver) {
      console.log(`\n${state.winner === Team.WEREWOLF ? '🔴 人狼陣營獲勝' : '🟢 村人陣營獲勝'}`);
    } else {
      console.log(`\n⚠️ 已達上限 ${maxDays} 天，遊戲未分勝負`);
    }
  }

  return state;
}
