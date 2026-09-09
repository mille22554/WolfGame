/**
 * worker-dispatcher.ts — WorkerDispatcher（LLMDispatcher 實作）
 *
 * - 管理 worker 生命週期：spawn、READY 等待、崩潰偵測、重啟
 * - job 佇列與 pending map；崩潰時已送出的 job 重試（≤ maxRetries）
 * - 僅 INIT 前崩潰（未 READY）視為啟動失敗：start() reject，不自動重啟
 */

import { Worker } from 'worker_threads';
import { randomUUID } from 'crypto';
import type { LLMDispatcher, GenerationConfig, WorkerJob, WorkerToMainMessage } from './types.js';

export interface WorkerDispatcherOptions {
  modelPath: string;
  contextSize?: number;      // 預設 8192
  contextCount?: number;     // 預設 3（env LLM_WORKER_CONTEXTS）
  maxRetries?: number;       // 預設 2
}

interface PendingJob {
  job: WorkerJob;
  retries: number;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

// 各 kind 預設參數（規格指定：預發言 temp 0.7/maxTokens 100；裁判 temp 0.3/maxTokens 200；展開 temp 0.8/maxTokens 100）
export const KIND_DEFAULTS: Record<WorkerJob['kind'], { temperature: number; maxTokens: number }> = {
  pre_speech: { temperature: 0.7, maxTokens: 100 },
  judge: { temperature: 0.3, maxTokens: 200 },
  expand: { temperature: 0.8, maxTokens: 100 },
  speech: { temperature: 0.8, maxTokens: 100 },
  vote: { temperature: 0.3, maxTokens: 100 },
  night: { temperature: 0.3, maxTokens: 100 },
};

/** 取文字中最後一個 P{編號}；無 → throw */
export function parseTargetId(text: string): number {
  const re = /P(\d+)/g;
  let m: RegExpExecArray | null;
  let last: number | null = null;
  while ((m = re.exec(text)) !== null) {
    last = parseInt(m[1], 10);
  }
  if (last === null) throw new Error(`無法從 LLM 輸出解析目標：${text.slice(0, 100)}`);
  return last;
}

export class WorkerDispatcher implements LLMDispatcher {
  private readonly options: Required<WorkerDispatcherOptions>;
  private worker: Worker | null = null;
  private ready = false;
  private shuttingDown = false;
  private startResolve: (() => void) | null = null;
  private startReject: ((err: Error) => void) | null = null;
  private readonly pending = new Map<string, PendingJob>();

  constructor(options: WorkerDispatcherOptions) {
    this.options = {
      contextSize: options.contextSize ?? 8192,
      contextCount: options.contextCount
        ?? Number(process.env.LLM_WORKER_CONTEXTS ?? 3),
      maxRetries: options.maxRetries ?? 2,
      modelPath: options.modelPath,
    };
  }

  /** spawn worker + 等 READY */
  start(): Promise<void> {
    if (this.worker) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      this.spawn();
    });
  }

  private spawn(): void {
    this.ready = false;
    const worker = new Worker(new URL('./worker.js', import.meta.url));
    this.worker = worker;
    worker.on('message', (msg: WorkerToMainMessage) => this.onMessage(msg));
    // 身份檢查：已被取代的 worker（重啟後的前代）的 exit/error 直接忽略，
    // 避免 terminate 前代觸發重入 onCrash、誤判為重啟期崩潰
    worker.on('error', (err: unknown) => {
      if (this.worker !== worker) return;
      this.onCrash(err instanceof Error ? err : new Error(String(err)));
    });
    worker.on('exit', () => {
      if (this.shuttingDown) return;
      if (this.worker !== worker) return;
      this.onCrash(new Error('worker exited unexpectedly'));
    });
    worker.postMessage({
      type: 'INIT',
      modelPath: this.options.modelPath,
      contextSize: this.options.contextSize,
      contextCount: this.options.contextCount,
    });
  }

  private onMessage(msg: WorkerToMainMessage): void {
    switch (msg.type) {
      case 'READY':
        this.ready = true;
        this.startResolve?.();
        this.startResolve = null;
        this.startReject = null;
        break;
      case 'RESULT': {
        const p = this.pending.get(msg.jobId);
        if (!p) break;
        this.pending.delete(msg.jobId);
        if (msg.ok) p.resolve(msg.text);
        else p.reject(new Error(msg.error));
        break;
      }
      case 'LOG':
        // eslint-disable-next-line no-console
        console[msg.level === 'info' ? 'log' : msg.level](`[llm-worker] ${msg.message}`);
        break;
    }
  }

  private onCrash(err: Error): void {
    const crashed = this.worker;
    this.worker = null;
    this.ready = false;
    if (crashed) void crashed.terminate().catch(() => undefined);

    // 啟動期崩潰（未 READY）：start() reject，不自動重啟（主進程進入錯誤狀態）
    if (this.startReject) {
      const reject = this.startReject;
      this.startResolve = null;
      this.startReject = null;
      for (const [jobId, p] of this.pending) {
        this.pending.delete(jobId);
        p.reject(new Error(`worker crashed: ${err.message}`));
      }
      reject(err);
      return;
    }

    if (this.shuttingDown) return;

    // 運行期崩潰：retries 耗盡的 job 直接 reject；
    // 其餘保留，重啟 READY 後重新送出（retries++），呼叫方無感重試
    const keep: PendingJob[] = [];
    for (const [jobId, p] of this.pending) {
      this.pending.delete(jobId);
      if (p.retries < this.options.maxRetries) {
        keep.push(p);
      } else {
        p.reject(new Error(`worker crashed: ${err.message}`));
      }
    }
    this.start().then(() => {
      for (const p of keep) {
        const retry: PendingJob = { ...p, retries: p.retries + 1 };
        this.pending.set(retry.job.jobId, retry);
        this.worker?.postMessage({ type: 'JOB', job: retry.job });
      }
    }).catch(() => {
      // 重啟失敗（重啟仍失敗 → 主進程錯誤狀態）：保留的 job 維持失敗
      for (const p of keep) {
        p.reject(new Error(`worker restart failed: ${err.message}`));
      }
    });
  }

  private submit(
    kind: WorkerJob['kind'],
    prompt: string,
    config?: GenerationConfig,
  ): Promise<string> {
    if (!this.worker || !this.ready) {
      return Promise.reject(new Error('worker not ready'));
    }
    const def = KIND_DEFAULTS[kind];
    const job: WorkerJob = {
      jobId: randomUUID(),
      kind,
      prompt,
      temperature: config?.temperature ?? def.temperature,
      maxTokens: config?.maxTokens ?? def.maxTokens,
    };
    return new Promise<string>((resolve, reject) => {
      this.pending.set(job.jobId, { job, retries: 0, resolve, reject });
      this.worker?.postMessage({ type: 'JOB', job });
    });
  }

  generate(prompt: string, config?: GenerationConfig): Promise<string> {
    return this.submit('expand', prompt, config).then((t) => t.trim());
  }

  async requestSpeech(playerId: number, prompt: string): Promise<{ text: string }> {
    void playerId;
    const text = await this.submit('speech', prompt);
    return { text: text.trim() };
  }

  async requestVote(playerId: number, prompt: string): Promise<{ targetId: number }> {
    void playerId;
    const text = await this.submit('vote', prompt);
    return { targetId: parseTargetId(text) };
  }

  async requestNightAction(playerId: number, prompt: string): Promise<{ targetId: number }> {
    void playerId;
    const text = await this.submit('night', prompt);
    return { targetId: parseTargetId(text) };
  }

  /** SHUTDOWN + terminate */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    for (const [jobId, p] of this.pending) {
      this.pending.delete(jobId);
      p.reject(new Error('dispatcher shutdown'));
    }
    if (worker) {
      try {
        worker.postMessage({ type: 'SHUTDOWN' });
      } catch { /* 已死 */ }
      await worker.terminate();
    }
  }

  isHealthy(): boolean {
    return this.ready && this.worker !== null;
  }
}
