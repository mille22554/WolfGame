/**
 * night-parse.ts — 統一夜間會議 loop（§12.3）的純函數解析器（server 端，無 I/O）
 *
 * 格式契約（逐字以 docs/strategy-prompt-variables.md 為準）：
 * - 策略輸出第一行：`status: speak|wait|ready`＋一句理由
 * - speak：第一行之後的策略主文必須 > STRATEGY_BODY_MIN
 * - wait／ready：正文必須 ≤ STRATEGY_BODY_MIN（不出策略文）
 * - 不合格 → 整份重生，最多 MAX_STRATEGY_ATTEMPTS 次；仍不合格視為 wait
 *
 * judge 輸出（§12.3 ③，1-based `best`）：`{"scores":[n,...],"best":N}`
 */
/** 策略主文最小字數：speak 須 > 150；wait／ready 須 ≤ 150 */
export declare const STRATEGY_BODY_MIN = 150;
/** 策略不合格整份重生的最大次數 */
export declare const MAX_STRATEGY_ATTEMPTS = 3;
export type NightStatus = 'speak' | 'wait' | 'ready';
export type ParsedStrategy = {
    ok: true;
    status: NightStatus;
    reason: string;
    body: string;
} | {
    ok: false;
    error: string;
};
/**
 * 解析策略輸出。
 * 規則：trim；切行並捨去空行；第一行須 match `status:`；
 * speak 正文 > STRATEGY_BODY_MIN；wait/ready 正文 ≤ STRATEGY_BODY_MIN。
 */
export declare function parseStrategy(text: string): ParsedStrategy;
/** 去掉第一行 status 行（若有），回傳剩餘文字（trim）；發言失敗時作為發布 fallback。 */
export declare function strategyBody(text: string): string;
/**
 * 解析 judge 輸出為被選中策略的 0-based index。
 * 優先序：合法 `best`（1-based，1..n）→ `scores`（長度 n 的數組）取最高分（同分取第一個）→ -1。
 * 永不拋錯；-1 由呼叫方 random fallback。
 */
export declare function parseJudge(text: string, n: number): number;
//# sourceMappingURL=night-parse.d.ts.map