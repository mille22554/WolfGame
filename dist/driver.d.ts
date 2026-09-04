/**
 * 遊戲驅動器：由程式碼直接呼叫 LLM Provider，依序驅動各角色 session
 * 討論保持順序執行，不做平行呼叫
 */
import { GameState } from './types.js';
import { GMNightActions } from './game-state.js';
import { LLMProvider } from './llm.js';
/**
 * 白天討論：每個存活且非 human 的玩家依序發言，並記錄到 discussionLog
 */
export declare function runDiscussion(gameState: GameState, provider: LLMProvider): Promise<void>;
/**
 * 白天投票：每個存活玩家依序投票，收集 {voterId, targetId}（解析失敗跳過）
 */
export declare function runVoting(gameState: GameState, provider: LLMProvider): Promise<{
    voterId: number;
    targetId: number;
}[]>;
/**
 * 夜間行動：狼（第一個存活狼）、預言家、守衛各自決策，組出 GMNightActions
 */
export declare function runNight(gameState: GameState, provider: LLMProvider): Promise<GMNightActions>;
//# sourceMappingURL=driver.d.ts.map