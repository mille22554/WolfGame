/**
 * llamacpp.ts — node-llama-cpp 依賴集中處（Phase 3 拆分）
 *
 * LlamaCppProvider + ensureModelDownloaded（原 llm.ts 內容原樣搬移）。
 * 此檔是 exe bundle 中唯一會觸及 node-llama-cpp 的模組；
 * esbuild 設 --external:./llamacpp.js 使其不進 bundle。
 */
import type { ChatMessage, LLMProvider } from './llm.js';
import type { GenerationConfig } from './types.js';
/**
 * 確保本地模型已下載（首次啟動下載，之後離線可用）
 * 若模型檔已存在於 modelsDir，resolveModelFile 會直接回傳路徑而不下載
 * @returns 解析後的 modelPath（.gguf 絕對路徑）
 */
export declare function ensureModelDownloaded(modelUri: string, modelsDir: string, onProgress?: (downloaded: number, total: number) => void): Promise<string>;
/**
 * 本地 llama.cpp Provider：使用專案內建 GGUF 模型，離線可用
 * 惰性初始化：首次 chat 時才載入模型，之後重用同一個 session
 */
export declare class LlamaCppProvider implements LLMProvider {
    private readonly modelPath;
    readonly name = "llamacpp";
    private session;
    private initPromise;
    /** @param modelPath 已下載的 .gguf 檔案絕對路徑 */
    constructor(modelPath: string);
    /** 首次呼叫時初始化 llama 引擎並建立 chat session，之後重用 */
    private getOrCreateSession;
    chat(messages: ChatMessage[], config?: GenerationConfig): Promise<string>;
}
//# sourceMappingURL=llamacpp.d.ts.map