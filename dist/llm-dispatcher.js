/**
 * llm-dispatcher.ts — OpenAICompatibleDispatcher + MockDispatcher
 */
import { MockProvider } from './llm.js';
import { parseTargetId, KIND_DEFAULTS } from './worker-dispatcher.js';
/** 包裝任何 OpenAI 相容端點（本地 llama-server 或外部 API）為 LLMDispatcher */
export class OpenAICompatibleDispatcher {
    provider;
    name = 'openai-compatible';
    constructor(provider) {
        this.provider = provider;
    }
    // ServerLLM 相容：無需啟動/關閉（sidecar 由 LlamaServerManager 管理）
    async start() { }
    async shutdown() { }
    async requestSpeech(playerId, prompt) {
        void playerId;
        const text = await this.provider.chat([{ role: 'user', content: prompt }], KIND_DEFAULTS.speech);
        return { text: text.trim() };
    }
    async requestVote(playerId, prompt) {
        void playerId;
        const text = await this.provider.chat([{ role: 'user', content: prompt }], KIND_DEFAULTS.vote);
        return { targetId: parseTargetId(text) };
    }
    async requestNightAction(playerId, prompt) {
        void playerId;
        const text = await this.provider.chat([{ role: 'user', content: prompt }], KIND_DEFAULTS.night);
        return { targetId: parseTargetId(text) };
    }
    async generate(prompt, config) {
        const text = await this.provider.chat([{ role: 'user', content: prompt }], config ?? KIND_DEFAULTS.expand);
        return text.trim();
    }
}
/** mock 模式用的 LLMDispatcher 包裝（MockProvider 不實作 LLMDispatcher） */
export class MockDispatcher {
    provider = new MockProvider();
    async start() { }
    async shutdown() { }
    async requestSpeech(_p, prompt) {
        return { text: (await this.provider.chat([{ role: 'user', content: prompt }])).trim() };
    }
    async requestVote(_p, prompt) {
        return { targetId: parseTargetId(await this.provider.chat([{ role: 'user', content: prompt }])) };
    }
    async requestNightAction(_p, prompt) {
        return { targetId: parseTargetId(await this.provider.chat([{ role: 'user', content: prompt }])) };
    }
    async generate(prompt) {
        return (await this.provider.chat([{ role: 'user', content: prompt }])).trim();
    }
}
//# sourceMappingURL=llm-dispatcher.js.map