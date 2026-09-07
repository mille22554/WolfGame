/**
 * worker.ts — LLM worker thread 入口（tsc 編譯為 dist/worker.js）
 *
 * - 單一 worker 載入一份模型（node-llama-cpp），context 池有限平行
 * - 與主進程以 postMessage 通訊（協定見 types.ts）
 * - mock 模式（LLM_PROVIDER=mock）：不載入模型，用 MockProvider
 * - 崩潰由主進程（WorkerDispatcher）偵測並重啟
 */

import { parentPort } from 'worker_threads';
import { getLlama, LlamaChatSession, QwenChatWrapper } from 'node-llama-cpp';
import { MockProvider } from './llm.js';
import type { WorkerJob, MainToWorkerMessage, WorkerToMainMessage } from './types.js';

interface ContextSlot {
  session: LlamaChatSession;
  busy: boolean;
}

function post(msg: WorkerToMainMessage): void {
  parentPort?.postMessage(msg);
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'LOG', level, message });
}

let slots: ContextSlot[] = [];
let queue: WorkerJob[] = [];
let mockProvider: MockProvider | null = null;
let running = true;

function pump(): void {
  if (!running) return;
  if (mockProvider) {
    // mock 模式：序列化處理（一次一則，順序完成）
    if (queue.length === 0) return;
    const job = queue.shift()!;
    void runMockJob(job).finally(() => pump());
    return;
  }
  for (const slot of slots) {
    if (queue.length === 0) break;
    if (slot.busy) continue;
    const job = queue.shift()!;
    slot.busy = true;
    void runSlotJob(slot, job)
      .catch((err) => {
        post({
          type: 'RESULT',
          jobId: job.jobId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        slot.busy = false;
        pump();
      });
  }
}

async function runMockJob(job: WorkerJob): Promise<void> {
  try {
    const text = await mockProvider!.chat([{ role: 'user', content: job.prompt }], {
      temperature: job.temperature,
      maxTokens: job.maxTokens,
    });
    post({ type: 'RESULT', jobId: job.jobId, ok: true, text });
  } catch (err) {
    post({
      type: 'RESULT',
      jobId: job.jobId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runSlotJob(slot: ContextSlot, job: WorkerJob): Promise<void> {
  const text = await slot.session.prompt(job.prompt, {
    temperature: job.temperature,
    maxTokens: job.maxTokens,
  });
  post({ type: 'RESULT', jobId: job.jobId, ok: true, text });
}

async function handleInit(modelPath: string, contextSize: number, contextCount: number): Promise<void> {
  if (process.env.LLM_PROVIDER === 'mock') {
    mockProvider = new MockProvider();
    post({ type: 'READY' });
    pump();
    return;
  }
  try {
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    for (let i = 0; i < contextCount; i++) {
      const context = await model.createContext({ contextSize });
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        chatWrapper: new QwenChatWrapper({ variation: '3', thoughts: 'discourage' }),
      });
      slots.push({ session, busy: false });
    }
    post({ type: 'READY' });
    pump();
  } catch (err) {
    log('error', `模型載入失敗（${modelPath}）：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

parentPort?.on('message', (msg: MainToWorkerMessage) => {
  switch (msg.type) {
    case 'INIT':
      void handleInit(msg.modelPath, msg.contextSize, msg.contextCount);
      break;
    case 'JOB':
      queue.push(msg.job);
      pump();
      break;
    case 'SHUTDOWN':
      running = false;
      queue = [];
      process.exit(0);
      break;
  }
});
