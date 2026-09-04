/**
 * Day Phase Logic
 * Handles discussion, voting, and elimination
 */

import {
  GameState,
  Player,
  Role,
  Team,
  Phase,
  Vote,
  DeathRecord,
  DiscussionEntry,
} from './types.js';
import { getAlivePlayers, getAliveVillagers, getAliveWerewolves, getRoleCounts } from './assignment.js';
import { pickRandom, findPlayerById, getMajorityThreshold, countOccurrences, randomInt } from './utils.js';
import { AIPlayer } from './ai.js';

/**
 * Result of day voting
 */
export interface VotingResult {
  eliminatedPlayerId?: number;
  eliminatedPlayerRole?: Role;
  voteCounts: Map<number, number>;  // targetId -> vote count
  votes: Vote[];
  tie: boolean;
}

/**
 * Conduct voting phase
 * All alive players vote for someone to eliminate
 */
export function conductVoting(gameState: GameState, humanVoteTargetId?: number): VotingResult {
  const alivePlayers = getAlivePlayers(gameState.players);
  const currentDay = gameState.day;
  const votes: Vote[] = [];
  const voteCounts = new Map<number, number>();

  // Each alive player votes
  for (const voter of alivePlayers) {
    let targetId: number;
    
    if (voter.isHuman && humanVoteTargetId !== undefined) {
      targetId = humanVoteTargetId;
    } else {
      targetId = selectVoteTarget(voter, alivePlayers, gameState);
    }
    
    const vote: Vote = {
      voterId: voter.id,
      targetId,
      day: currentDay,
    };
    votes.push(vote);
    gameState.votes.push(vote);
    
    voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1);
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

  // Handle tie - no elimination (or random among tied)
  if (tie && eliminatedPlayerId) {
    // Get all tied players
    const tiedPlayers = Array.from(voteCounts.entries())
      .filter(([, count]) => count === maxVotes)
      .map(([id]) => id);
    
    // Random tiebreaker
    eliminatedPlayerId = pickRandom(tiedPlayers);
  }

  const result: VotingResult = {
    eliminatedPlayerId,
    voteCounts,
    votes,
    tie,
  };

  // Process elimination
  if (eliminatedPlayerId) {
    const eliminated = findPlayerById(alivePlayers, eliminatedPlayerId);
    if (eliminated) {
      eliminated.alive = false;
      result.eliminatedPlayerRole = eliminated.role;
      gameState.eliminatedPlayerId = eliminatedPlayerId;
      gameState.eliminatedPlayerRole = eliminated.role;

      // Record death
      const deathRecord: DeathRecord = {
        playerId: eliminatedPlayerId,
        day: currentDay,
        cause: 'vote',
      };
      gameState.deathHistory.push(deathRecord);
    }
  }

  return result;
}

/**
 * Select vote target for a player — 基於 AIPlayer.buildReasoningContext 的 suspectRanking[0]
 * 投票邏輯與討論中的推理一致，不再僅算被提及次數
 */
function selectVoteTarget(voter: Player, alivePlayers: Player[], gameState: GameState): number {
  const candidates = alivePlayers.filter(p => p.id !== voter.id);
  if (candidates.length === 0) return voter.id;

  try {
    const ai = new AIPlayer(voter, gameState);
    const reasoning = ai.getReasoningContext();
    if (reasoning.suspectRanking.length > 0) {
      const top = reasoning.suspectRanking[0];
      if (candidates.some(c => c.id === top)) {
        return top;
      }
      // 若 top 非法（如已死/非候選），退回排序中第一個合法
      for (const id of reasoning.suspectRanking) {
        if (candidates.some(c => c.id === id)) return id;
      }
    }
  } catch {
    // 推理失敗退回隨機
  }

  // 極端回退：隨機候選（理論上不應走到此分支）
  return pickRandom(candidates).id;
}

/**
 * Format voting result for public announcement
 * IMPORTANT: Role of eliminated player is NOT revealed publicly
 * Only the medium learns it privately
 */
export function formatVotingResultPublic(result: VotingResult): string {
  const lines = [`=== 第 ${result.votes[0]?.day || 1} 天 投票結果 ===`];
  
  // Show vote counts (anonymized or public based on preference)
  // In standard werewolf, votes are public
  const voteCountsArray = Array.from(result.voteCounts.entries())
    .sort((a, b) => b[1] - a[1]);
  
  for (const [targetId, count] of voteCountsArray) {
    lines.push(`P${targetId}: ${count} 票`);
  }
  
  if (result.eliminatedPlayerId) {
    lines.push(`\n🗳️ P${result.eliminatedPlayerId} 被投票出局（身分不公開）`);
    if (result.tie) {
      lines.push(`⚠️ 平票，隨機決定`);
    }
  } else {
    lines.push(`\n🗳️ 無人被投票出局（棄票或平票）`);
  }
  
  return lines.join('\n');
}

/**
 * Format voting result for medium (private)
 */
export function formatVotingResultForMedium(result: VotingResult): string | null {
  if (result.eliminatedPlayerId && result.eliminatedPlayerRole) {
    const isWolf = result.eliminatedPlayerRole === Role.WEREWOLF;
    return `👁️ 靈能者得知：P${result.eliminatedPlayerId} 是 ${isWolf ? '人狼 🔴' : '村人 🟢'}`;
  }
  return null;
}

/**
 * Check win conditions
 */
export function checkWinCondition(gameState: GameState): Team | null {
  const alivePlayers = getAlivePlayers(gameState.players);
  const aliveWerewolves = getAliveWerewolves(gameState.players);
  const aliveVillagers = getAliveVillagers(gameState.players);
  
  const wolfCount = aliveWerewolves.length;
  const villageCount = aliveVillagers.length;
  
  // Werewolf win: wolves >= villagers
  if (wolfCount >= villageCount && wolfCount > 0) {
    return Team.WEREWOLF;
  }
  
  // Village win: all wolves eliminated
  if (wolfCount === 0) {
    return Team.VILLAGE;
  }
  
  return null;
}

/**
 * Get game status summary
 */
export function getGameStatus(gameState: GameState): string {
  const alivePlayers = getAlivePlayers(gameState.players);
  const aliveWerewolves = getAliveWerewolves(gameState.players);
  const aliveVillagers = getAliveVillagers(gameState.players);
  
  const lines = [
    `=== 遊戲狀態 (第 ${gameState.day} 天) ===`,
    `存活玩家: ${alivePlayers.length} 人`,
    `  村人陣營: ${aliveVillagers.length} 人`,
    `  人狼陣營: ${aliveWerewolves.length} 人`,
    '',
    '存活玩家列表:',
  ];
  
  for (const player of alivePlayers) {
    lines.push(`  ${player.name} (${player.role})`);
  }
  
  return lines.join('\n');
}

/**
 * Format day start announcement
 */
export function formatDayStart(gameState: GameState, nightResult?: any): string {
  const lines = [`=== 第 ${gameState.day} 天 早晨 ===`];
  
  if (nightResult) {
    if (nightResult.killBlocked) {
      lines.push('🌅 昨晚是平安夜，無人犧牲');
    } else if (nightResult.killedPlayerId) {
      lines.push(`💀 昨晚犧牲者：P${nightResult.killedPlayerId}（身分不公開）`);
    } else {
      lines.push('🌅 昨晚是平安夜，無人犧牲');
    }
  }
  
  lines.push('');
  lines.push(`存活玩家: ${getAlivePlayers(gameState.players).map(p => p.name).join('、')}`);
  
  return lines.join('\n');
}

/**
 * Format discussion prompt — 依 @oracle P0 設計：Day1/Day2+ 差異化，首日避免硬懷疑
 */
export function formatDiscussionPrompt(gameState: GameState): string {
  if (gameState.day === 1) {
    // 動態找昨晚死者：優先 deathHistory cause==='wolf_kill' 且 day===當前day 或 day-1，最後回退 getAlivePlayers 反推
    let victimId: number | undefined;
    const dh = gameState.deathHistory;
    let rec = dh.find(d => d.cause === 'wolf_kill' && d.day === gameState.day);
    if (!rec) rec = dh.find(d => d.cause === 'wolf_kill' && d.day === gameState.day - 1);
    if (rec) victimId = rec.playerId;
    else {
      const rev = [...dh].reverse().find(d => d.cause === 'wolf_kill');
      if (rev) victimId = rev.playerId;
    }
    if (victimId === undefined) {
      const aliveIds = new Set(getAlivePlayers(gameState.players).map(p => p.id));
      const dead = gameState.players.filter(p => !aliveIds.has(p.id));
      if (dead.length > 0) {
        if (dh.length > 0) victimId = dh[dh.length - 1].playerId;
        else victimId = dead[0].id;
      }
    }
    const label = victimId !== undefined ? `P${victimId}` : 'P?';
    return `=== 第1天 討論 ===\n昨晚 ${label} 被殺（唯一事實）。請圍繞「狼為何刀 ${label}」「誰的反應讓你在意」「若今天要投會先看誰（試探）」聊，用「我比較在意…」「想聽聽…」語氣，避免直接定罪。`;
  } else {
    return `=== 第${gameState.day}天 討論 ===\n回顧昨天的發言與投票，結合昨晚的結果，聊聊誰的行為最值得關注。特殊職若有情報可考慮是否暗示。`;
  }
}