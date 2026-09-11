/**
 * memory.ts — 私有記憶層（機械式，無 LLM）
 *
 * 每天結束（ADVANCE_DAY）為每位玩家把「自己視角的一天」沉澝成 memory.md：
 * 我的發言、我的投票、我的夜間行動、狼會議我的發言與最終擊殺目標。
 * buildPrompt 的【你的私有記憶】區塊讀取它 → AI 跨天保有「我做過什麼」的連續性。
 *
 * 設計取捨：
 * - 機械式推導（純函式 builder）：零幻覺風險、零 LLM 成本、可單測
 * - 寫入走 getDataDir()（pkg 環境 exe 旁 data/ 可寫）；讀取 fallback resource root（dev 同源）
 * - 只記「事實」（誰說了/投了/殺了誰），不做主觀總結 — 主觀沉澱屬 external-accumulation-plan 範圍
 * - 整局保留：不設天數上限；單日發言取最後 5 則（防單日話癆膨脹 prompt）
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GameState } from './types.js';
import { getDataDir, getResourceRoot } from './utils.js';

/** 單日發言保留上限（每人每天，防話癆膨脹） */
export const MEMORY_SPEECHES_PER_DAY = 5;

/**
 * 為單一玩家生成某天的記憶段（純函式）：
 * 我的白天發言 / 我的投票 / 我的夜間行動 / 我的狼會議發言與最終擊殺。
 * 只含該玩家自身視角的事實，不含他人私有資訊。
 */
export function buildDailyMemory(state: GameState, playerId: number, day: number): string {
  const lines: string[] = [];
  const mySpeeches = state.discussionLog
    .filter((d) => d.playerId === playerId && d.day === day)
    .slice(-MEMORY_SPEECHES_PER_DAY);
  for (const s of mySpeeches) lines.push(`我說：「${s.text}」`);
  const myVote = state.votes.find((v) => v.voterId === playerId && v.day === day);
  if (myVote) lines.push(`我投了 P${myVote.targetId}`);
  // 夜間行動：nightActions 即提交紀錄（每 actor 每夜一筆，覆寫式）
  const myAction = state.nightActions.find((a) => a.actorId === playerId);
  if (myAction) {
    const kindText = myAction.type === 'wolf_kill' ? '襲擊' : myAction.type === 'seer_check' ? '查驗' : '守護';
    lines.push(`我夜間${kindText}了 P${myAction.targetId}`);
  }
  const player = state.players.find((p) => p.id === playerId);
  if (player?.role === 'werewolf') {
    const myWolfSpeeches = state.wolfDiscussionLog
      .filter((d) => d.playerId === playerId && d.day === day)
      .slice(-MEMORY_SPEECHES_PER_DAY);
    for (const s of myWolfSpeeches) lines.push(`狼會議我說：「${s.text}」`);
    if (state.wolfKillTarget !== undefined) lines.push(`狼群最終襲擊了 P${state.wolfKillTarget}`);
  }
  if (lines.length === 0) return '';
  return `第${day}天：\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

/** memory 檔內容（純函式）：多天記憶段組合，整局保留（不設天數上限） */
export function buildMemoryContent(
  state: GameState, playerId: number, days: number[],
): string {
  const sections: string[] = [];
  for (const day of days) {
    const sec = buildDailyMemory(state, playerId, day);
    if (sec) sections.push(sec);
  }
  return sections.join('\n\n');
}

/** memory 檔案路徑（寫入用：getDataDir 下，pkg 環境可寫） */
export function memoryFilePath(personaId: string, dataDir?: string): string {
  return path.join(dataDir ?? getDataDir(), 'character-memory', `${personaId}.md`);
}

/** 寫入單一玩家 memory（覆寫） */
export function writeMemory(personaId: string, content: string, dataDir?: string): void {
  const file = memoryFilePath(personaId, dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

/** 清空單一玩家 memory（新局） */
export function clearMemory(personaId: string, dataDir?: string): void {
  writeMemory(personaId, '', dataDir);
}

/**
 * 讀取單一玩家 memory：優先 dataDir（運行期寫入處），無檔則 fallback resource root
 * （dev 環境兩者同源；pkg 環境 character/ 打包唯讀，運行期記憶在 data/character-memory/）
 */
export function readMemory(personaId: string, dataDir?: string): string {
  const writable = memoryFilePath(personaId, dataDir);
  try {
    if (fs.existsSync(writable)) return fs.readFileSync(writable, 'utf-8');
  } catch { /* fallthrough */ }
  try {
    const readonly = path.join(getResourceRoot(), 'character', personaId, 'memory.md');
    if (fs.existsSync(readonly)) return fs.readFileSync(readonly, 'utf-8');
  } catch { /* 無記憶 */ }
  return '';
}
