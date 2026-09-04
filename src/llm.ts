/**
 * LLM Provider 抽象層
 * 支援 OpenAI 相容端點、測試用 Mock 與本地 llama.cpp 模型
 * OpenAI 分支使用 Node 內建 fetch，不引入新依賴
 */

import * as fs from 'fs';
import * as path from 'path';
import { getLlama, LlamaChatSession, resolveModelFile } from 'node-llama-cpp';

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

const DEFAULT_BASE_URL = 'http://localhost:3001/v1';
const DEFAULT_MODEL = 'gemini-3.6-flash';

/**
 * OpenAI 相容 Provider（預設指向本地代理 http://localhost:3001/v1）
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = 'openai-compatible';
  private readonly baseURL: string;
  private readonly model: string;
  private readonly apiKey: string;

  constructor(options: OpenAICompatibleOptions = {}) {
    this.baseURL = options.baseURL ?? DEFAULT_BASE_URL;
    this.model = options.model ?? DEFAULT_MODEL;
    this.apiKey = options.apiKey ?? '';
  }

  async chat(messages: ChatMessage[], config?: GenerationConfig): Promise<string> {
    const url = `${this.baseURL.replace(/\/$/, '')}/chat/completions`;
    let res: Response;
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
    } catch (err) {
      throw new Error(`LLM 連線失敗（${url}）：${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM 回應錯誤（HTTP ${res.status}）：${body.slice(0, 300)}`);
    }

    let data: any;
    try {
      data = await res.json();
    } catch (err) {
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
export class MockProvider implements LLMProvider {
  readonly name = 'mock';

  async chat(messages: ChatMessage[], _config?: GenerationConfig): Promise<string> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const text = lastUser?.content ?? '';
    const m = text.match(/P(\d+)/);
    const n = m ? m[1] : '1';

    if (text.includes('投票')) {
      return `P${n}：「我投 P${n}。」`;
    }
    // 夜間行動提示使用「今晚」，同時相容「夜晚」
    if (text.includes('夜晚') || text.includes('今晚') || text.includes('殺害') || text.includes('查驗') || text.includes('守護') || text.includes('選擇')) {
      return `P${n}：「我選擇 P${n}。」`;
    }
    return `P${n}：「我認為 P${n} 值得注意。」`;
  }
}

/**
 * 本地 llama.cpp 模型的預設 HF URI 與 models 目錄
 */
export const DEFAULT_LLAMACPP_MODEL_URI =
  'hf:Qwen/Qwen2.5-1.5B-Instruct-GGUF:qwen2.5-1.5b-instruct-q4_k_m.gguf';

/** 預設 models 目錄：專案根目錄下的 models 資料夾 */
export function getDefaultModelsDir(): string {
  return path.join(process.cwd(), 'models');
}

/**
 * 確保本地模型已下載（首次啟動下載，之後離線可用）
 * 若模型檔已存在於 modelsDir，resolveModelFile 會直接回傳路徑而不下載
 * @returns 解析後的 modelPath（.gguf 絕對路徑）
 */
export async function ensureModelDownloaded(
  modelUri: string,
  modelsDir: string,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<string> {
  // 若 models 目錄不存在則先建立
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }

  try {
    const modelPath = await resolveModelFile(modelUri, {
      directory: modelsDir,
      cli: false, // 關閉內建 CLI 進度條，改用自訂 onProgress
      onProgress: onProgress
        ? (status: { totalSize: number; downloadedSize: number }) => {
            onProgress(status.downloadedSize, status.totalSize);
          }
        : undefined,
    });
    return modelPath;
  } catch (err) {
    throw new Error(`本地模型下載失敗（${modelUri}）：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 本地 llama.cpp Provider：使用專案內建 GGUF 模型，離線可用
 * 惰性初始化：首次 chat 時才載入模型，之後重用同一個 session
 */
export class LlamaCppProvider implements LLMProvider {
  readonly name = 'llamacpp';
  private session: LlamaChatSession | null = null;
  private initPromise: Promise<LlamaChatSession> | null = null;

  /** @param modelPath 已下載的 .gguf 檔案絕對路徑 */
  constructor(private readonly modelPath: string) {}

  /** 首次呼叫時初始化 llama 引擎並建立 chat session，之後重用 */
  private getOrCreateSession(): Promise<LlamaChatSession> {
    if (this.session) return Promise.resolve(this.session);
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        const llama = await getLlama();
        const model = await llama.loadModel({ modelPath: this.modelPath });
        const context = await model.createContext();
        const session = new LlamaChatSession({
          contextSequence: context.getSequence(),
        });
        this.session = session;
        return session;
      } catch (err) {
        this.initPromise = null;
        throw new Error(
          `本地模型載入失敗（${this.modelPath}）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    return this.initPromise;
  }

  async chat(messages: ChatMessage[], config?: GenerationConfig): Promise<string> {
    const session = await this.getOrCreateSession();

    // 將 messages（含 system/user/assistant）依序拼接成單一文字 prompt，
    // system 開頭，user/assistant 交替，確保 system prompt 有被納入
    const prompt = messages
      .map((m) => {
        if (m.role === 'system') return `系統：${m.content}`;
        if (m.role === 'assistant') return `助理：${m.content}`;
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
    } catch (err) {
      throw new Error(`本地模型推理失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * 工廠：讀環境變數決定使用哪個 Provider
 * - LLM_PROVIDER='mock' → MockProvider
 * - LLM_PROVIDER='llamacpp' → LlamaCppProvider（自動下載本地模型）
 * - 其餘（含未設定）→ OpenAICompatibleProvider
 */
export async function createProvider(): Promise<LLMProvider> {
  if (process.env.LLM_PROVIDER === 'mock') {
    return new MockProvider();
  }
  if (process.env.LLM_PROVIDER === 'llamacpp') {
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
