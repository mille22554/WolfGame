/**
 * ai-scheduler.ts — SpeechScheduler（發言選擇機制，實作 AIScheduler）
 *
 * 管線：IDLE → PRE_SPEECH（分批平行）→ JUDGE（全盲裁判）→ SELECT（新穎性懲罰 + top3 隨機）
 *       → EXPAND（commit 後不中斷）→ BROADCAST（保證 ≥ CD 距最後訊息）
 *
 * 版本語意：PRE_SPEECH / JUDGE 完成時版本不符 → 作廢回 IDLE；
 * SELECT 之後 commit，EXPAND 跑完後 enqueue AI_SPEECH_DONE 帶 commit 版本
 * （期間版本變更則由 engine 既有機制丟棄）。
 */
import type { AIScheduler } from './engine.js';
import type { GameState, SchedulerContext } from './types.js';
export interface SpeechSchedulerOptions {
    cdMs?: number;
    quietMs?: number;
    checkIntervalMs?: number;
    preSpeechBatch?: number;
    preSpeechTemp?: number;
    judgeTemp?: number;
    expandTemp?: number;
    topK?: number;
    recentCompareCount?: number;
}
export declare class SpeechScheduler implements AIScheduler {
    private readonly ctx;
    private readonly options;
    private timer;
    private lastMessageTime;
    private lastSeenBoardVersion;
    private pipelineToken;
    private pipelineActive;
    private stopped;
    constructor(ctx: SchedulerContext, options?: SpeechSchedulerOptions);
    onPhaseEntered(state: GameState): void;
    onBoardUpdated(state: GameState): void;
    /** 清除 timer（server 關閉時） */
    stop(): void;
    private startTimer;
    private clearTimer;
    private cancelPipeline;
    private tick;
    private aliveAIIds;
    private runPipeline;
    /** 存活 AI ≤ 2：跳過管線，直接隨機選一展開 */
    private runDirect;
    private collectPreSpeeches;
    private judge;
    /** 廣播保證 ≥ CD 距最後訊息；commit 語意：等待後照常 enqueue（帶 commit 版本） */
    private broadcastAfterCd;
}
//# sourceMappingURL=ai-scheduler.d.ts.map