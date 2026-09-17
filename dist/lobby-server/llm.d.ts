/**
 * LLM Client — SGLang (Qwen3.8-27B) HTTP client
 *
 * 同機 localhost:9090，Bearer auth。
 * OpenAI-compatible /v1/chat/completions API。
 */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface ChatOptions {
    temperature?: number;
}
/**
 * 呼叫 SGLang /v1/chat/completions，回傳 assistant 回覆文字。
 * 不設 timeout：等待 LLM 回傳（reasoning model 長 prompt 可能 >60s）。
 * 失敗回 null。
 */
export declare function chat(messages: ChatMessage[], options?: ChatOptions): Promise<string | null>;
//# sourceMappingURL=llm.d.ts.map