/**
 * worker.test.ts — worker 通訊測試（mock 模式，不載入模型）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'worker_threads';
import { WorkerDispatcher } from './worker-dispatcher.js';
import type { WorkerToMainMessage } from './types.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);
const MOCK_ENV = { ...process.env, LLM_PROVIDER: 'mock' };

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`逾時：${label}`)), ms);
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer!));
}

test('worker 協定：INIT → READY；JOB → RESULT；SHUTDOWN → exit 0', async () => {
  const worker = new Worker(WORKER_URL, { env: MOCK_ENV });
  try {
    const ready = new Promise<void>((resolve, reject) => {
      worker.on('message', (msg: WorkerToMainMessage) => {
        if (msg.type === 'READY') resolve();
        else if (msg.type === 'LOG' && msg.level === 'error') reject(new Error(msg.message));
      });
      worker.on('error', reject);
    });
    worker.postMessage({ type: 'INIT', modelPath: 'mock', contextSize: 8192, contextCount: 1 });
    await withTimeout(ready, 10000, 'READY');

    const result = new Promise<string>((resolve, reject) => {
      worker.on('message', (msg: WorkerToMainMessage) => {
        if (msg.type === 'RESULT' && msg.jobId === 'j1') {
          if (msg.ok) resolve(msg.text);
          else reject(new Error(msg.error));
        }
      });
    });
    worker.postMessage({
      type: 'JOB',
      job: { jobId: 'j1', kind: 'speech', prompt: '請發言，今天的局勢如何？' },
    });
    const text = await withTimeout(result, 10000, 'RESULT');
    assert.ok(text.trim().length > 0);

    const exitCode = await new Promise<number>((resolve) => {
      worker.on('exit', resolve);
      worker.postMessage({ type: 'SHUTDOWN' });
    });
    assert.equal(exitCode, 0);
  } finally {
    await worker.terminate().catch(() => undefined);
  }
});

test('worker：多個 JOB 全部完成（序列化）', async () => {
  const worker = new Worker(WORKER_URL, { env: MOCK_ENV });
  try {
    const ready = new Promise<void>((resolve) => {
      worker.on('message', (msg: WorkerToMainMessage) => {
        if (msg.type === 'READY') resolve();
      });
    });
    worker.postMessage({ type: 'INIT', modelPath: 'mock', contextSize: 8192, contextCount: 1 });
    await withTimeout(ready, 10000, 'READY');

    const ids = ['a', 'b', 'c', 'd', 'e'];
    const done = new Map<string, string>();
    const all = new Promise<void>((resolve, reject) => {
      worker.on('message', (msg: WorkerToMainMessage) => {
        if (msg.type === 'RESULT') {
          if (!msg.ok) {
            reject(new Error(msg.error));
            return;
          }
          done.set(msg.jobId, msg.text);
          if (done.size === ids.length) resolve();
        }
      });
    });
    for (const id of ids) {
      worker.postMessage({ type: 'JOB', job: { jobId: id, kind: 'speech', prompt: `請發言 ${id}` } });
    }
    await withTimeout(all, 15000, '多 JOB 完成');
    assert.equal(done.size, ids.length);
    for (const id of ids) assert.ok(done.get(id)!.trim().length > 0);
  } finally {
    await worker.terminate().catch(() => undefined);
  }
});

test('dispatcher：start → generate/requestVote/requestNightAction → shutdown', async () => {
  const d = new WorkerDispatcher({ modelPath: 'mock' });
  await withTimeout(d.start(), 15000, 'dispatcher start');
  assert.equal(d.isHealthy(), true);
  const text = await withTimeout(d.generate('請發言，今天值得注意誰？'), 10000, 'generate');
  assert.ok(text.trim().length > 0);
  const vote = await withTimeout(d.requestVote(1, '請投票，選出最可疑的一人'), 10000, 'vote');
  assert.ok(Number.isInteger(vote.targetId));
  const night = await withTimeout(
    d.requestNightAction(2, '請選擇今晚行動的目標'),
    10000,
    'night',
  );
  assert.ok(Number.isInteger(night.targetId));
  await d.shutdown();
  assert.equal(d.isHealthy(), false);
});

test('dispatcher 崩潰：maxRetries=0 時 pending reject；重啟後重試成功', async () => {
  const d = new WorkerDispatcher({ modelPath: 'mock', maxRetries: 0 });
  try {
    await withTimeout(d.start(), 15000, 'start');
    const p = d.generate('崩潰測試發言');
    // 白盒觸發崩潰路徑（等同 worker 進程死亡）
    (d as unknown as { onCrash(err: Error): void }).onCrash(new Error('test crash'));
    await assert.rejects(p, /worker crashed/);
    // 等待自動重啟（mock READY 很快）
    const deadline = Date.now() + 10000;
    while (!d.isHealthy() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(d.isHealthy(), true);
    const retry = await withTimeout(d.generate('重啟後重試'), 10000, '重試');
    assert.ok(retry.trim().length > 0);
  } finally {
    await d.shutdown().catch(() => undefined);
  }
});

test('dispatcher 崩潰：預設重試下進行中 job 透明重試成功', async () => {
  const d = new WorkerDispatcher({ modelPath: 'mock' });
  try {
    await withTimeout(d.start(), 15000, 'start');
    const p = d.generate('透明重試測試');
    (d as unknown as { onCrash(err: Error): void }).onCrash(new Error('test crash'));
    // retries 未耗盡 → 呼叫方無感，重啟後成功
    const text = await withTimeout(p, 15000, '透明重試');
    assert.ok(text.trim().length > 0);
  } finally {
    await d.shutdown().catch(() => undefined);
  }
});

before(() => {
  process.env.LLM_PROVIDER = 'mock';
});

after(() => {
  // 還原（若原本非 mock）
});
