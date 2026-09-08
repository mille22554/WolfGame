/**
 * download-stall.ts — 下載停滯（idle）超時共用 helper。
 *
 * 用 AbortController 實作：一段時間無任何 bytes 進展就 abort。
 * 不用固定總時長——2.38GB 模型在慢速網路可能超過 10 分鐘，總時長超時會誤殺正常慢速下載。
 * 每收到一個 chunk 就重置計時（呼叫端在 'data' 裡呼叫 guard.reset()）。
 */
/** 停滯上限（ms）：預設 60 秒，可用 DOWNLOAD_STALL_TIMEOUT_MS 覆寫（非正數 → 預設） */
export declare function downloadStallTimeoutMs(): number;
/**
 * 停滯守衛：建構當下即開始計時（連上後完全不吐資料也會 abort）；
 * 每次 reset() 重置；超時 → 標記 stalled + abort signal。
 * 呼叫端在 catch 裡檢查 didStall，命中即 throw stallError()
 * （含「下載停滯超時」字樣，供 MODEL_STATUS error 廣播透出到前端）。
 */
export declare class StallGuard {
    private readonly stallMs;
    private readonly label;
    private timer;
    private readonly ctrl;
    private stalled;
    constructor(stallMs: number, label: string);
    get signal(): AbortSignal;
    get didStall(): boolean;
    reset(): void;
    cancel(): void;
    stallError(): Error;
}
//# sourceMappingURL=download-stall.d.ts.map