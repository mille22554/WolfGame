/**
 * LLM Provider 抽象層（Phase 3 拆分後：無 node-llama-cpp）
 * 支援 OpenAI 相容端點、測試用 Mock；本地 llama.cpp 相關已移至 llamacpp.ts
 * OpenAI 分支使用 Node 內建 fetch，不引入新依賴
 */
import type { GenerationConfig } from './types.js';
export type { GenerationConfig } from './types.js';
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
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
/** Qwen3 關閉思考輸出後綴（/completion 手動包模板驗證有效：空 think 塊＋正常發言） */
export declare const NO_THINK_SUFFIX = "/no_think";
/**
 * user 訊息尾附加 /no_think（冪等）：
 * - 空字串原樣回傳
 * - 尾部（去尾空白後）已有後綴則不重複附加
 * - 否則去尾空白＋換行＋後綴
 */
export declare function withNoThink(content: string): string;
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
/** 語意化別名（llama-server 模式也用） */
export declare const DEFAULT_MODEL_URI = "hf:Qwen/Qwen3-4B-GGUF:Qwen3-4B-Q4_K_M.gguf";
/** 預設 models 目錄：可寫資料目錄下的 models 資料夾 */
export declare function getDefaultModelsDir(): string;
/**
 * 工廠：讀環境變數決定使用哪個 Provider
 * - LLM_PROVIDER='mock' → MockProvider
 * - LLM_PROVIDER='llamacpp' → LlamaCppProvider（動態 import，自動下載本地模型）
 * - 其餘（含未設定）→ OpenAICompatibleProvider
 */
export declare function createProvider(): Promise<LLMProvider>;
//# sourceMappingURL=llm.d.ts.map