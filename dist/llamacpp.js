/**
 * llamacpp.ts — node-llama-cpp 依賴集中處（Phase 3 拆分）
 *
 * LlamaCppProvider + ensureModelDownloaded（原 llm.ts 內容原樣搬移）。
 * 此檔是 exe bundle 中唯一會觸及 node-llama-cpp 的模組；
 * esbuild 設 --external:./llamacpp.js 使其不進 bundle。
 */
import * as fs from 'fs';
import { getLlama, LlamaChatSession, QwenChatWrapper, resolveModelFile } from 'node-llama-cpp';
/**
 * 確保本地模型已下載（首次啟動下載，之後離線可用）
 * 若模型檔已存在於 modelsDir，resolveModelFile 會直接回傳路徑而不下載
 * @returns 解析後的 modelPath（.gguf 絕對路徑）
 */
export async function ensureModelDownloaded(modelUri, modelsDir, onProgress) {
    // 若 models 目錄不存在則先建立
    if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
    }
    try {
        const modelPath = await resolveModelFile(modelUri, {
            directory: modelsDir,
            cli: false, // 關閉內建 CLI 進度條，改用自訂 onProgress
            onProgress: onProgress
                ? (status) => {
                    onProgress(status.downloadedSize, status.totalSize);
                }
                : undefined,
        });
        return modelPath;
    }
    catch (err) {
        throw new Error(`本地模型下載失敗（${modelUri}）：${err instanceof Error ? err.message : String(err)}`);
    }
}
/**
 * 本地 llama.cpp Provider：使用專案內建 GGUF 模型，離線可用
 * 惰性初始化：首次 chat 時才載入模型，之後重用同一個 session
 */
export class LlamaCppProvider {
    modelPath;
    name = 'llamacpp';
    session = null;
    initPromise = null;
    /** @param modelPath 已下載的 .gguf 檔案絕對路徑 */
    constructor(modelPath) {
        this.modelPath = modelPath;
    }
    /** 首次呼叫時初始化 llama 引擎並建立 chat session，之後重用 */
    getOrCreateSession() {
        if (this.session)
            return Promise.resolve(this.session);
        if (this.initPromise)
            return this.initPromise;
        this.initPromise = (async () => {
            try {
                const llama = await getLlama();
                const model = await llama.loadModel({ modelPath: this.modelPath });
                const context = await model.createContext({
                    contextSize: Number(process.env.LLM_CONTEXT_SIZE ?? 8192),
                });
                const session = new LlamaChatSession({
                    contextSequence: context.getSequence(),
                    // Qwen3 需明確指定 chat wrapper，auto 偵測可能失敗導致空輸出
                    chatWrapper: new QwenChatWrapper({ variation: '3', thoughts: 'discourage' }),
                });
                this.session = session;
                return session;
            }
            catch (err) {
                this.initPromise = null;
                throw new Error(`本地模型載入失敗（${this.modelPath}）：${err instanceof Error ? err.message : String(err)}`);
            }
        })();
        return this.initPromise;
    }
    async chat(messages, config) {
        const session = await this.getOrCreateSession();
        // 將 messages（含 system/user/assistant）依序拼接成單一文字 prompt，
        // system 開頭，user/assistant 交替，確保 system prompt 有被納入
        const prompt = messages
            .map((m) => {
            if (m.role === 'system')
                return `系統：${m.content}`;
            if (m.role === 'assistant')
                return `助理：${m.content}`;
            return `使用者：${m.content}`;
        })
            .join('\n\n');
        try {
            const answer = await session.prompt(prompt, {
                temperature: config?.temperature,
                maxTokens: config?.maxTokens,
            });
            const text = answer.trim();
            if (text === '') {
                throw new Error('模型回傳空字串');
            }
            return text;
        }
        catch (err) {
            throw new Error(`本地模型推理失敗：${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
//# sourceMappingURL=llamacpp.js.map