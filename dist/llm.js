/**
 * LLM Provider 抽象層（Phase 3 拆分後：無 node-llama-cpp）
 * 支援 OpenAI 相容端點、測試用 Mock；本地 llama.cpp 相關已移至 llamacpp.ts
 * OpenAI 分支使用 Node 內建 fetch，不引入新依賴
 */
import * as path from 'path';
import { getDataDir } from './utils.js';
const DEFAULT_BASE_URL = 'http://localhost:2064/v1';
const DEFAULT_MODEL = 'gemini-3.6-flash';
/**
 * OpenAI 相容 Provider（預設指向本地代理 http://localhost:3001/v1）
 */
export class OpenAICompatibleProvider {
    name = 'openai-compatible';
    baseURL;
    model;
    apiKey;
    constructor(options = {}) {
        this.baseURL = options.baseURL ?? DEFAULT_BASE_URL;
        this.model = options.model ?? DEFAULT_MODEL;
        this.apiKey = options.apiKey ?? '';
    }
    async chat(messages, config) {
        const url = `${this.baseURL.replace(/\/$/, '')}/chat/completions`;
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: this.model,
                    messages,
                    temperature: config?.temperature ?? 0.8,
                    max_tokens: config?.maxTokens ?? 300,
                }),
            });
        }
        catch (err) {
            throw new Error(`LLM 連線失敗（${url}）：${err instanceof Error ? err.message : String(err)}`);
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`LLM 回應錯誤（HTTP ${res.status}）：${body.slice(0, 300)}`);
        }
        let data;
        try {
            data = await res.json();
        }
        catch (err) {
            throw new Error(`LLM 回應不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
        }
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim() === '') {
            throw new Error(`LLM 回應缺少 choices[0].message.content：${JSON.stringify(data).slice(0, 300)}`);
        }
        return content;
    }
}
/**
 * 測試用 Mock Provider，不呼叫網路，回傳確定性繁體回應
 */
export class MockProvider {
    name = 'mock';
    async chat(messages, _config) {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        const text = lastUser?.content ?? '';
        const m = text.match(/你是 P(\d+)/) ?? text.match(/P(\d+)/);
        const n = m ? parseInt(m[1], 10) : 1;
        if (text.includes('投票')) {
            return `P${n}：「我投 P${pickTarget(text, n)}。」`;
        }
        // 夜間行動提示使用「今晚」，同時相容「夜晚」
        if (text.includes('夜晚') || text.includes('今晚') || text.includes('殺害') || text.includes('查驗') || text.includes('守護') || text.includes('選擇')) {
            return `P${n}：「我選擇 P${pickTarget(text, n)}。」`;
        }
        return `P${n}：「我認為 P${n} 值得注意。」`;
    }
}
/** 從 prompt 的「存活玩家：P1、P2…」選出非自己的最小編號（避免夜間/投票自選被拒） */
function pickTarget(prompt, selfId) {
    const ids = [];
    const aliveMatch = prompt.match(/存活玩家：([^；\n]+)/);
    const source = aliveMatch ? aliveMatch[1] : prompt;
    for (const mm of source.matchAll(/P(\d+)/g)) {
        const id = parseInt(mm[1], 10);
        if (id !== selfId && !ids.includes(id))
            ids.push(id);
    }
    if (ids.length > 0)
        return ids.sort((a, b) => a - b)[0];
    return selfId === 1 ? 2 : 1;
}
/**
 * 本地 llama.cpp 模型的預設 HF URI 與 models 目錄
 */
export const DEFAULT_LLAMACPP_MODEL_URI = 'hf:Qwen/Qwen3-4B-GGUF:Qwen3-4B-Q4_K_M.gguf';
/** 語意化別名（llama-server 模式也用） */
export const DEFAULT_MODEL_URI = DEFAULT_LLAMACPP_MODEL_URI;
/** 預設 models 目錄：可寫資料目錄下的 models 資料夾 */
export function getDefaultModelsDir() {
    return path.join(getDataDir(), 'models');
}
/**
 * 工廠：讀環境變數決定使用哪個 Provider
 * - LLM_PROVIDER='mock' → MockProvider
 * - LLM_PROVIDER='llamacpp' → LlamaCppProvider（動態 import，自動下載本地模型）
 * - 其餘（含未設定）→ OpenAICompatibleProvider
 */
export async function createProvider() {
    if (process.env.LLM_PROVIDER === 'mock') {
        return new MockProvider();
    }
    if (process.env.LLM_PROVIDER === 'llamacpp') {
        const { ensureModelDownloaded, LlamaCppProvider } = await import('./llamacpp.js');
        const modelUri = process.env.LLM_MODEL_URI ?? DEFAULT_LLAMACPP_MODEL_URI;
        const modelsDir = process.env.LLM_MODELS_DIR ?? getDefaultModelsDir();
        const modelPath = await ensureModelDownloaded(modelUri, modelsDir);
        return new LlamaCppProvider(modelPath);
    }
    return new OpenAICompatibleProvider({
        baseURL: process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL,
        model: process.env.LLM_MODEL ?? DEFAULT_MODEL,
        apiKey: process.env.FREELLMAPI_API_KEY ?? '',
    });
}
//# sourceMappingURL=llm.js.map