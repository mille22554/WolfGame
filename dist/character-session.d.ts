/**
 * character-session.ts — Phase 0：buildPrompt 純函式 + summarizeDay + 截斷演算法
 *
 * 組裝順序：角色卡（persona/agents.md + memory.md）→ 遊戲規則 →
 * 公開知識（buildPublicKnowledge）→ 私有知識（依角色）→ 當天討論 →
 * 歷史摘要（daySummaries）→ 任務指令（依 kind）
 */
import type { GameState } from './types.js';
export type PromptKind = 'speech' | 'vote' | 'night';
export declare function buildPrompt(state: GameState, playerId: number, kind: PromptKind, budget?: number): string;
/**
 * summarizeDay：啟發式摘要 — top3 指控（被最多人點名）+ 投票結果
 */
export declare function summarizeDay(state: GameState, day: number): string;
//# sourceMappingURL=character-session.d.ts.map