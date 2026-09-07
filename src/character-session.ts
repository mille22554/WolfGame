/**
 * character-session.ts — Phase 0：buildPrompt 純函式 + summarizeDay + 截斷演算法
 *
 * 組裝順序：角色卡（persona/agents.md + memory.md）→ 遊戲規則 →
 * 公開知識（buildPublicKnowledge）→ 私有知識（依角色）→ 當天討論 →
 * 歷史摘要（daySummaries）→ 任務指令（依 kind）
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GameState } from './types.js';
import { Role, Team } from './types.js';
import { buildPublicKnowledge, parseAccusatoryIds } from './ai.js';
import { getAlivePlayers } from './assignment.js';
import { getResourceRoot } from './utils.js';

function readTextIfExists(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

export type PromptKind = 'speech' | 'vote' | 'night';

function taskInstruction(kind: PromptKind, playerId: number): string {
  switch (kind) {
    case 'speech':
      return `【任務】你是 P${playerId}，請進行白天發言（一句話，30-60字）。圍繞「誰的反應讓你在意」「想聽聽誰的說法」聊，用「我比較在意…」語氣，避免直接定罪。格式：P${playerId}：「你的發言」`;
    case 'vote':
      return `【任務】你是 P${playerId}，請投票。回顧今天的發言與你的私有情報，選出最值得懷疑的一人。回覆格式：我投 P{編號}。`;
    case 'night':
      return `【任務】你是 P${playerId}，請選擇今晚行動的目標（必須是存活且非自己的玩家）。回覆：我選擇 P{編號}。`;
  }
}

function privateKnowledgeLines(state: GameState, playerId: number): string[] {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return [];
  const lines: string[] = [];
  lines.push(`你的編號：P${player.id}（${player.name}）`);
  if (player.role === Role.SEER) {
    const checks = state.seerChecks.filter((c) => c.seerId === playerId);
    if (checks.length > 0) {
      lines.push(
        `你的查驗紀錄：${checks
          .map((c) => `第${c.day}天查驗 P${c.targetId}：${c.result === Team.WEREWOLF ? '人狼' : '村人'}`)
          .join('；')}`,
      );
    }
  }
  if (player.role === Role.GUARD) {
    const protects = state.guardProtects.filter((g) => g.guardId === playerId);
    if (protects.length > 0) {
      lines.push(`你的守護紀錄：${protects.map((g) => `第${g.day}天守護 P${g.targetId}`).join('；')}`);
    }
  }
  if (player.role === Role.MEDIUM) {
    const voteDeaths = state.deathHistory.filter((d) => d.cause === 'vote');
    if (voteDeaths.length > 0) {
      lines.push(
        `你的靈能情報：${voteDeaths
          .map((d) => {
            const pl = state.players.find((p) => p.id === d.playerId);
            const team = pl && pl.role === Role.WEREWOLF ? '人狼' : '村人';
            return `第${d.day}天票死 P${d.playerId} 是${team}`;
          })
          .join('；')}`,
      );
    }
  }
  if (player.role === Role.MASON && player.masonPartnerId !== undefined) {
    lines.push(`你的共有者夥伴：P${player.masonPartnerId}`);
  }
  if (player.role === Role.WEREWOLF) {
    const allies = state.players.filter((p) => p.role === Role.WEREWOLF && p.alive && p.id !== playerId);
    if (allies.length > 0) {
      lines.push(`你的人狼同盟：${allies.map((a) => `P${a.id}`).join('、')}`);
    }
  }
  return lines;
}

export function buildPrompt(
  state: GameState,
  playerId: number,
  kind: PromptKind,
  budget = 8000,
): string {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`找不到玩家 P${playerId}`);

  const maxChars = budget ?? 8000;
  const maxCurrentDayEntries = 60;

  // --- 固定部分 ---
  const personaId = player.personality || `p${playerId}`;
  const personaPrompt = readTextIfExists(path.join(getResourceRoot(), 'character', personaId, 'agents.md'));
  const privateMemory = readTextIfExists(path.join(getResourceRoot(), 'character', personaId, 'memory.md'));
  const rules = readTextIfExists(path.join(getResourceRoot(), 'character', 'day-meeting.md'));

  const pub = buildPublicKnowledge(state);
  const aliveNames = pub.alivePlayers.map((p) => `P${p.id}`).join('、') || '無';
  const deadNames = pub.deadPlayers.map((p) => `P${p.id}`).join('、') || '無';

  const fixedParts: string[] = [
    '你是人狼遊戲中的角色。',
    personaPrompt ? `【人格設定】\n${personaPrompt}` : '【人格設定】（無）',
    privateMemory ? `【你的私有記憶】\n${privateMemory}` : '',
    `【你的角色資訊】\n${privateKnowledgeLines(state, playerId).join('\n')}`,
    rules ? `【遊戲規則】\n${rules}` : '',
    `【公開知識】第${state.day}天，存活玩家：${aliveNames}；死亡玩家：${deadNames}。`,
    taskInstruction(kind, playerId),
  ].filter((s) => s !== '');

  // --- 可截斷部分 ---
  const todayEntries = state.discussionLog
    .filter((d) => d.day === state.day)
    .slice(-maxCurrentDayEntries);
  let currentLines = todayEntries.map((d) => `P${d.playerId}：${d.text}`);
  let summaries = [...state.daySummaries];

  const totalLength = (): number =>
    fixedParts.join('\n\n').length + currentLines.join('\n').length + summaries.join('\n').length;

  // 截斷演算法：先丟最舊 daySummary，再丟當天最舊討論條目；
  // 固定部分超限 → 原樣輸出（不截斷）
  while (totalLength() > maxChars) {
    if (summaries.length > 0) {
      summaries = summaries.slice(1);
    } else if (currentLines.length > 0) {
      currentLines = currentLines.slice(1);
    } else {
      break;
    }
  }

  const parts: string[] = [...fixedParts];
  parts.splice(
    fixedParts.length - 1,
    0,
    `【今日對話紀錄】\n${currentLines.length > 0 ? currentLines.join('\n') : '（尚無發言）'}`,
    summaries.length > 0 ? `【歷史摘要】\n${summaries.join('\n')}` : '',
  );
  return parts.filter((s) => s !== '').join('\n\n');
}

/**
 * summarizeDay：啟發式摘要 — top3 指控（被最多人點名）+ 投票結果
 */
export function summarizeDay(state: GameState, day: number): string {
  const entries = state.discussionLog.filter((d) => d.day === day);
  const votes = state.votes.filter((v) => v.day === day);
  const alivePlayers = getAlivePlayers(state.players);

  const mentionCounts = new Map<number, number>();
  for (const e of entries) {
    for (const id of parseAccusatoryIds(e.text, alivePlayers)) {
      mentionCounts.set(id, (mentionCounts.get(id) ?? 0) + 1);
    }
  }
  const top3 = Array.from(mentionCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const voteCounts = new Map<number, number>();
  for (const v of votes) {
    voteCounts.set(v.targetId, (voteCounts.get(v.targetId) ?? 0) + 1);
  }
  const voteLines = Array.from(voteCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id, c]) => `P${id}: ${c} 票`);

  const parts: string[] = [`第${day}天摘要：`];
  if (top3.length > 0) {
    parts.push(`最多被指控：${top3.map(([id, c]) => `P${id}（${c}次）`).join('、')}`);
  } else {
    parts.push('無明確指控');
  }
  if (voteLines.length > 0) {
    parts.push(`投票結果：${voteLines.join('、')}`);
    const max = Math.max(...voteCounts.values());
    const tied = Array.from(voteCounts.values()).filter((c) => c === max).length > 1;
    if (tied) {
      parts.push('平票，無人出局');
    } else {
      const out = Array.from(voteCounts.entries()).find(([, c]) => c === max);
      if (out) parts.push(`P${out[0]} 被投票出局`);
    }
  } else {
    parts.push('無投票紀錄');
  }
  return parts.join('；');
}

// ============================================
// Phase 1：預發言 / 裁判 / 展開 prompt
// ============================================

export const PRE_SPEECH_BUDGET = 3000;        // 字元預算
export const PRE_SPEECH_RECENT = 5;           // 最近幾則
export const PRE_SPEECH_PERSONA_MAX = 500;    // 人格精簡上限

/**
 * buildPreSpeechPrompt（輕量，2-3K tokens）：
 * 人格（前 500 字）→ 私有知識 → 當天摘要（最後一則）→ 最近 5 則討論 → 任務指令
 */
export function buildPreSpeechPrompt(state: GameState, playerId: number): string {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`找不到玩家 P${playerId}`);

  const personaId = player.personality || `p${playerId}`;
  const personaFull = readTextIfExists(path.join(getResourceRoot(), 'character', personaId, 'agents.md'));
  const persona = personaFull.slice(0, PRE_SPEECH_PERSONA_MAX);

  const privateLines = privateKnowledgeLines(state, playerId);
  const lastSummary = state.daySummaries.length > 0
    ? state.daySummaries[state.daySummaries.length - 1]
    : '尚無摘要';
  const recent = state.discussionLog
    .filter((d) => d.day === state.day)
    .slice(-PRE_SPEECH_RECENT)
    .map((d) => `P${d.playerId}：${d.text}`);

  const parts: string[] = [
    persona ? `【人格設定】\n${persona}` : '【人格設定】（無）',
    `【你的角色資訊】\n${privateLines.join('\n')}`,
    `【當天摘要】\n${lastSummary}`,
    `【最近討論】\n${recent.length > 0 ? recent.join('\n') : '（尚無發言）'}`,
    `【任務】你是 P${playerId}，請寫一句 20-40 字的預發言草稿（不超過 40 字）。\n這是候選草稿，稍後可能被選中展開。圍繞當前局勢，提出一個值得討論的點。\n格式：P${playerId}：「你的草稿」`,
  ];

  let prompt = parts.join('\n\n');
  // 超預算：先丟最近討論最舊條目（固定部分保留）
  while (prompt.length > PRE_SPEECH_BUDGET && recent.length > 1) {
    recent.shift();
    parts[3] = `【最近討論】\n${recent.join('\n')}`;
    prompt = parts.join('\n\n');
  }
  return prompt;
}

/**
 * buildJudgePrompt（裁判，全盲）：
 * 當天摘要 + 打亂匿名預發言（slot 1..N，不含 P 編號）+ 評分指令
 */
export function buildJudgePrompt(
  daySummary: string,
  preSpeeches: { slot: number; text: string }[],
): string {
  const lines = preSpeeches.map((p) => `${p.slot}. ${p.text}`);
  const formatExample = preSpeeches.map((p) => `${p.slot}: 分數`).join('\n');
  return [
    `【當天摘要】\n${daySummary}`,
    `【候選發言】\n${lines.join('\n')}`,
    `【裁判任務】以下是 ${preSpeeches.length} 位玩家的候選發言（順序已打亂，匿名）。\n請針對每一則以 0-10 整數評分，考量三個面向：\n- 新資訊：是否帶來討論中尚未出現的資訊\n- 相關性：是否緊扣當前局勢\n- 推進力：是否能推動討論前進\n輸出格式（每行一則，嚴格遵守）：\n${formatExample}`,
  ].join('\n\n');
}

/**
 * buildExpandPrompt（展開完整發言）：
 * buildPrompt(state, playerId, 'speech') + 預發言草稿附加
 */
export function buildExpandPrompt(state: GameState, playerId: number, preSpeech: string): string {
  const base = buildPrompt(state, playerId, 'speech');
  return `${base}\n\n【你的預發言草稿】${preSpeech}\n你可以沿用或修改這則草稿，展開成完整發言（30-60 字）。`;
}
