/**
 * model-download.ts — 純 fetch GGUF 下載器（無 node-llama-cpp）
 */
export interface ModelUri {
    url: string;
    fileName: string;
}
/** 'hf:owner/repo:file' → HF resolve URL；'https://...' 直通 */
export declare function parseModelUri(uri: string): ModelUri;
/**
 * 純 fetch 下載 GGUF（無 node-llama-cpp）。
 * 已存在（精確檔名或任一 .gguf）→ 直接回傳路徑，不下載。
 * 下載流程：fetch → res.ok 檢查 → Readable.fromWeb(res.body) → pipe 到 <file>.tmp → rename 原子寫入。
 * 失敗 → 刪除 tmp → throw。
 */
export declare function downloadModelFile(uri: string, modelsDir: string, onProgress?: (downloaded: number, total: number) => void, fetchImpl?: typeof fetch): Promise<string>;
//# sourceMappingURL=model-download.d.ts.map