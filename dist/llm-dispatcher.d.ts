/**
 * llm-dispatcher.ts — OpenAICompatibleDispatcher + MockDispatcher
 */
import { OpenAICompatibleProvider } from './llm.js';
import type { LLMDispatcher, GenerationConfig } from './types.js';
import type { ServerLLM } from './server.js';
/** 包裝任何 OpenAI 相容端點（本地 llama-server 或外部 API）為 LLMDispatcher */
export declare class OpenAICompatibleDispatcher implements LLMDispatcher {
    private readonly provider;
    readonly name = "openai-compatible";
    constructor(provider: OpenAICompatibleProvider);
    start(): Promise<void>;
    shutdown(): Promise<void>;
    requestSpeech(playerId: number, prompt: string): Promise<{
        text: string;
    }>;
    requestVote(playerId: number, prompt: string): Promise<{
        targetId: number;
    }>;
    requestNightAction(playerId: number, prompt: string): Promise<{
        targetId: number;
    }>;
    generate(prompt: string, config?: GenerationConfig): Promise<string>;
}
/** mock 模式用的 LLMDispatcher 包裝（MockProvider 不實作 LLMDispatcher） */
export declare class MockDispatcher implements ServerLLM {
    private readonly provider;
    start(): Promise<void>;
    shutdown(): Promise<void>;
    requestSpeech(_p: number, prompt: string): Promise<{
        text: string;
    }>;
    requestVote(_p: number, prompt: string): Promise<{
        targetId: number;
    }>;
    requestNightAction(_p: number, prompt: string): Promise<{
        targetId: number;
    }>;
    generate(prompt: string): Promise<string>;
}
//# sourceMappingURL=llm-dispatcher.d.ts.map