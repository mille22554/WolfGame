/**
 * llm-dispatcher.ts — OpenAICompatibleDispatcher + MockDispatcher
 */
import { OpenAICompatibleProvider, MockProvider } from './llm.js';
import { parseTargetId, KIND_DEFAULTS } from './worker-dispatcher.js';
import type { LLMDispatcher, GenerationConfig } from './types.js';
import type { ServerLLM } from './server.js';

/** 包裝任何 OpenAI 相容端點（本地 llama-server 或外部 API）為 LLMDispatcher */
export class OpenAICompatibleDispatcher implements LLMDispatcher {
  readonly name = 'openai-compatible';
  constructor(private readonly provider: OpenAICompatibleProvider) {}

  // ServerLLM 相容：無需啟動/關閉（sidecar 由 LlamaServerManager 管理）
  async start(): Promise<void> {}
  async shutdown(): Promise<void> {}

  async requestSpeech(playerId: number, prompt: string): Promise<{ text: string }> {
    void playerId;
    const text = await this.provider.chat([{ role: 'user', content: prompt }], KIND_DEFAULTS.speech);
    return { text: text.trim() };
  }
  async requestVote(playerId: number, prompt: string): Promise<{ targetId: number }> {
    void playerId;
    const text = await this.provider.chat([{ role: 'user', content: prompt }], KIND_DEFAULTS.vote);
    return { targetId: parseTargetId(text) };
  }
  async requestNightAction(playerId: number, prompt: string): Promise<{ targetId: number }> {
    void playerId;
    const text = await this.provider.chat([{ role: 'user', content: prompt }], KIND_DEFAULTS.night);
    return { targetId: parseTargetId(text) };
  }
  async generate(prompt: string, config?: GenerationConfig): Promise<string> {
    const text = await this.provider.chat([{ role: 'user', content: prompt }], config ?? KIND_DEFAULTS.expand);
    return text.trim();
  }
}

/** mock 模式用的 LLMDispatcher 包裝（MockProvider 不實作 LLMDispatcher） */
export class MockDispatcher implements ServerLLM {
  private readonly provider = new MockProvider();
  async start(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async requestSpeech(_p: number, prompt: string): Promise<{ text: string }> {
    return { text: (await this.provider.chat([{ role: 'user', content: prompt }])).trim() };
  }
  async requestVote(_p: number, prompt: string): Promise<{ targetId: number }> {
    return { targetId: parseTargetId(await this.provider.chat([{ role: 'user', content: prompt }])) };
  }
  async requestNightAction(_p: number, prompt: string): Promise<{ targetId: number }> {
    return { targetId: parseTargetId(await this.provider.chat([{ role: 'user', content: prompt }])) };
  }
  async generate(prompt: string): Promise<string> {
    return (await this.provider.chat([{ role: 'user', content: prompt }])).trim();
  }
}
