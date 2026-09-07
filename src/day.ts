/**
 * Day Phase Logic
 * Handles discussion, voting, and elimination
 */

import {
  GameState,
  Role,
  Team,
  Vote,
} from './types.js';
import { getAlivePlayers, getAliveVillagers, getAliveWerewolves } from './assignment.js';

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