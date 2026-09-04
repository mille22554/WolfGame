/**
 * LLM Provider 抽象層
 * 支援 OpenAI 相容端點、測試用 Mock 與本地 llama.cpp 模型
 * OpenAI 分支使用 Node 內建 fetch，不引入新依賴
 */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface GenerationConfig {
    temperature?: number;
    maxTokens?: number;
}
export interface LLMProvider {
    chat(messages: ChatMessage[], config?: GenerationConfig): Promise<string>;
    readonly name: string;
}
export interface OpenAICompatibleOptions {
    baseURL?: string;
    model?: string;
    apiKey?: string;
}
/**
 * OpenAI 相容 Provider（預設指向本地代理 http://localhost:3001/v1）
 */
export declare class OpenAICompatibleProvider implements LLMProvider {
    readonly name = "openai-compatible";
    private readonly baseURL;
    private readonly model;
    private readonly apiKey;
    constructor(options?: OpenAICompatibleOptions);
    chat(messages: ChatMessage[], config?: GenerationConfig): Promise<string>;
}
/**
 * 測試用 Mock Provider，不呼叫網路，回傳確定性繁體回應
 */
export declare class MockProvider implements LLMProvider {
    readonly name = "mock";
    chat(messages: ChatMessage[], _config?: GenerationConfig): Promise<string>;
}
/**
 * 本地 llama.cpp 模型的預設 HF URI 與 models 目錄
 */
export declare const DEFAULT_LLAMACPP_MODEL_URI = "hf:Qwen/Qwen3-4B-GGUF:Qwen3-4B-Q4_K_M.gguf";
/** 預設 models 目錄：專案根目錄下的 models 資料夾 */
export declare function getDefaultModelsDir(): string;
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
/**
 * 工廠：讀環境變數決定使用哪個 Provider
 * - LLM_PROVIDER='mock' → MockProvider
 * - LLM_PROVIDER='llamacpp' → LlamaCppProvider（自動下載本地模型）
 * - 其餘（含未設定）→ OpenAICompatibleProvider
 */
export declare function createProvider(): Promise<LLMProvider>;
//# sourceMappingURL=llm.d.ts.map