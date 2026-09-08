/**
 * download-stall.ts — 下載停滯（idle）超時共用 helper。
 *
 * 用 AbortController 實作：一段時間無任何 bytes 進展就 abort。
 * 不用固定總時長——2.38GB 模型在慢速網路可能超過 10 分鐘，總時長超時會誤殺正常慢速下載。
 * 每收到一個 chunk 就重置計時（呼叫端在 'data' 裡呼叫 guard.reset()）。
 */

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

/** 停滯上限（ms）：預設 60 秒，可用 DOWNLOAD_STALL_TIMEOUT_MS 覆寫（非正數 → 預設） */
export function downloadStallTimeoutMs(): number {
  const v = envInt('DOWNLOAD_STALL_TIMEOUT_MS', 60000);
  return v > 0 ? v : 60000;
}

/**
 * 停滯守衛：建構當下即開始計時（連上後完全不吐資料也會 abort）；
 * 每次 reset() 重置；超時 → 標記 stalled + abort signal。
 * 呼叫端在 catch 裡檢查 didStall，命中即 throw stallError()
 * （含「下載停滯超時」字樣，供 MODEL_STATUS error 廣播透出到前端）。
 */
export class StallGuard {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly ctrl = new AbortController();
  private stalled = false;

  constructor(
    private readonly stallMs: number,
    private readonly label: string,
  ) {
    this.reset();
  }

  get signal(): AbortSignal {
    return this.ctrl.signal;
  }

  get didStall(): boolean {
    return this.stalled;
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.stalled = true;
      try {
        this.ctrl.abort();
      } catch { /* ignore */ }
    }, this.stallMs);
    const t = this.timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  stallError(): Error {
    return new Error(`${this.label}下載停滯超時（${Math.round(this.stallMs / 1000)} 秒無資料進展）`);
  }
}