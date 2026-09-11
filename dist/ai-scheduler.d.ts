/**
 * ai-scheduler.ts — SpeechScheduler（白板更新驅動迴圈＋AI 決策 flag 收斂）
 *
 * 迴圈（用戶定案）：
 * - 白板更新 → 開工生產（未就緒 AI 除上輪發言者外全員草稿；已就緒者不再草稿）＋ CD 重啟。
 * - 生產完成 → 暫存，不直接播。
 * - CD 到有貨 → 播出（播出即白板更新，迴圈回去）。
 * - CD 到沒貨 → 等做好馬上播。
 * - 中間白板又更新 → 暫存作廢＋生產用新白板重跑＋CD 重啟（版本作廢沿用）。
 * - 同一時間只有一條生產線＋一個暫存位，不會疊跑。
 * - 生產失敗 → N 秒後重試（預設 60s，env SPEECH_RETRY_MS 可調）；重試前不播出、不推進掛機計數。
 * - 純 AI 局：CD=0，做好就播（計時器保留，只是 0ms）。
 * - quiet 整組拔除；跳過按鈕（HUMAN_SKIP／allAliveHumansSkipped）保留但 scheduler 不再依賴。
 *
 * 收斂（第 2 項）：
 * - 每輪未就緒 AI 除上輪發言者外寫草稿；候選為空不生產，等真人講話；唯一候選不斷線。
 * - 草稿結尾 flag 兩層解析（正規＋寬鬆決策語境關鍵字，不用 LLM）；剝離統一在收草稿回傳前，
 *   broadcast 前再洗一次 expand 輸出；flag 永不進白板。
 * - 安全閥：單一 AI 連續 maxUncertainRounds（預設 50）次資訊不足 → 強制 decided:abstain。
 * - AI decided 且其發言成功播出後 → enqueue AI_READY_VOTE（不帶版本；單向不退；標的可變覆蓋）；
 *   transition 統一檢查全員 ready → 直進投票（無 CLOSING）。
 */
import type { AIScheduler } from './engine.js';
import type { FlagStats, GameState, SchedulerContext } from './types.js';
export type AIDecision = {
    status: 'decided';
    target: number | 'abstain';
} | {
    status: 'uncertain';
};
/** 安全閥：單一 AI 連續資訊不足次數上限（防卡死底線；只計真正資訊不足） */
export declare const MAX_UNCERTAIN_ROUNDS = 50;
/** 正規 flag：[決定:投P3]／[決定:殺P3]／[決定:棄票]／[決定:資訊不足]（方括號跳脫、全形/半形冒號、全域匹配） */
export declare const DECISION_FLAG_RE: RegExp;
/** 剝離 flag（全域，一律在收草稿回傳前＋broadcast 前各洗一次；含無方括號裸 flag 整行） */
export declare function stripDecisionFlags(text: string): string;
/** 兩層解析：先正規，失敗走寬鬆關鍵字；都抓不到 → uncertain（計入安全閥） */
export declare function parseDecisionFlag(text: string): AIDecision;
export interface SpeechSchedulerOptions {
    cdMs?: number;
    retryMs?: number;
    preSpeechBatch?: number;
    preSpeechTemp?: number;
    judgeTemp?: number;
    expandTemp?: number;
    topK?: number;
    recentCompareCount?: number;
    maxUncertainRounds?: number;
}
interface Stash {
    playerId: number;
    text: string;
    boardVersion: number;
    decision: AIDecision;
}
export declare class SpeechScheduler implements AIScheduler {
    private readonly ctx;
    private readonly options;
    private stopped;
    private lastSeenBoardVersion;
    private lastDay;
    private prodToken;
    private producing;
    private stash;
    private cdReady;
    private cdTimer;
    private retryTimer;
    private uncertainCounts;
    private decisions;
    constructor(ctx: SchedulerContext, options?: SpeechSchedulerOptions);
    onPhaseEntered(state: GameState): void;
    onBoardUpdated(state: GameState): void;
    /** 清除 timer（server 關閉時） */
    stop(): void;
    /** 供測試：目前暫存（有貨／無貨） */
    stashForTest(): Stash | null;
    /** 供測試：單一 AI 連續資訊不足次數 */
    uncertainCountForTest(playerId: number): number;
    private resetCycle;
    private effectiveCdMs;
    private restartCd;
    private onCdFired;
    /** 草稿候選：存活 AI 除上輪發言者外全員（狼模式僅存活狼 AI）；為空 → 不生產（等真人）。
     *  已就緒（voteReady/wolfReady）者排除：已表態者不再草稿，降噪＋省算力＋加速收斂；
     *  收回就緒（人類）會重回候選。唯一候選時不斷線（避免單人僵局）。 */
    private candidateIds;
    private startProduction;
    private runProduction;
    /** 生產失敗 → N 秒後重試；重試前不播出（無暫存）、不推進掛機計數（transition 只在發言成功時計數） */
    private scheduleRetry;
    private collectPreSpeeches;
    /** 驗證狼襲擊目標合法性：存活、非自己、非狼同盟；不合法 → 視為棄票（狼放棄這票，不擋會議；夜晚結算另有過濾） */
    private validateWolfTarget;
    /** 決策更新：decided 覆蓋標的＋清空計數；資訊不足累計，達安全閥強制 decided:abstain */
    private updateDecision;
    /** GM 除錯用：每輪 AI 決策 flag 統計（每玩家最新決策，非累計筆數；決定投誰／棄票／資訊不足各幾筆） */
    flagStats(): FlagStats;
    private judge;
    /** CD 到有貨 → 播出；播出成功且 decided → enqueue AI_READY_VOTE（統一檢查由 transition 執行） */
    private broadcastStash;
}
export {};
//# sourceMappingURL=ai-scheduler.d.ts.map