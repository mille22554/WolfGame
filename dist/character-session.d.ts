/**
 * character-session.ts — Phase 0：buildPrompt 純函式 + summarizeDay + 截斷演算法
 *
 * 組裝順序：角色卡（persona/agents.md + memory.md）→ 遊戲規則 →
 * 公開知識（buildPublicKnowledge）→ 私有知識（依角色）→ 當天討論 →
 * 歷史摘要（daySummaries）→ 任務指令（依 kind）
 *
 * 人格分層：草稿（pre_speech）與正式發言（speech/expand）皆帶人格
 * （人格是決策依據之一）；night/vote 行動決策保持中性（不帶人格），
 * 維持嚴格輸出格式的服從性。
 */
import type { GameState } from './types.js';
export type PromptKind = 'speech' | 'vote' | 'night' | 'wolf_speech';
export declare function buildPrompt(state: GameState, playerId: number, kind: PromptKind, budget?: number): string;
/**
 * summarizeDay：啟發式摘要 — top3 指控（被最多人點名）+ 投票結果
 */
export declare function summarizeDay(state: GameState, day: number): string;
export declare const PRE_SPEECH_BUDGET = 2000;
export declare const PRE_SPEECH_RECENT = 5;
/**
 * buildPreSpeechPrompt（輕量，2-3K tokens）：
 * 人格（前 500 字）→ 私有知識 → 當天摘要（最後一則）→ 最近 5 則討論 → 任務指令
 */
export declare function buildPreSpeechPrompt(state: GameState, playerId: number): string;
/**
 * buildJudgePrompt（裁判，全盲）：
 * 當天摘要 + 打亂匿名預發言（slot 1..N，不含 P 編號）+ 評分指令
 */
export declare function buildJudgePrompt(daySummary: string, preSpeeches: {
    slot: number;
    text: string;
}[]): string;
/**
 * buildExpandPrompt（展開完整發言）：
 * buildPrompt(state, playerId, 'speech') + 預發言草稿附加
 */
export declare function buildExpandPrompt(state: GameState, playerId: number, preSpeech: string): string;
/**
 * summarizeWolfDiscussion：狼討論摘要 — top 提及的襲擊目標（無投票段）
 */
export declare function summarizeWolfDiscussion(state: GameState, day: number): string;
/**
 * buildWolfPreSpeechPrompt（狼預發言，輕量）：
 * 私有知識 → 當晚狼討論最近 5 則 → 任務指令（含殺人決策旗標）
 */
export declare function buildWolfPreSpeechPrompt(state: GameState, playerId: number): string;
/**
 * buildWolfExpandPrompt（狼展開完整發言）：
 * buildPrompt(state, playerId, 'wolf_speech') + 預發言草稿附加
 */
export declare function buildWolfExpandPrompt(state: GameState, playerId: number, preSpeech: string): string;
//# sourceMappingURL=character-session.d.ts.map