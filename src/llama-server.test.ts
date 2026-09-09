/**
 * llama-server.test.ts — LlamaServerManager（fake binary）+ ensureLlamaServer 測試
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import {
  LlamaServerManager, ensureLlamaServer, ensureLlamaServerPair, startLlamaServerWithFallback,
  llamaServerDownloadUrl, llamaServerDirName, pruneOtherVariantDirs, migrateLegacyLlamaDir,
  gpuLayersForVram, reducedGpuLayers, detectVramMB, defaultGpuLayers, defaultThreads, isGpuCrashError,
  readBackendPreference, writeBackendPreference, effectiveBackendPreference,
  FULL_GPU_LAYERS, REDUCED_GPU_LAYERS,
} from './llama-server.js';

const FAKE_SRC = `
import http from 'node:http';
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 3001;
const hostIdx = args.indexOf('--host');
const host = hostIdx >= 0 ? args[hostIdx + 1] : '127.0.0.1';
const mode = process.env.FAKE_MODE ?? 'healthy';
if (mode === 'crash') { console.error('fake crash'); process.exit(1); }
const start = () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
    } else { res.writeHead(404); res.end(); }
  });
  srv.listen(port, host);
};
if (mode === 'slow') setTimeout(start, Number(process.env.FAKE_SLOW_MS ?? '5000'));
else start();
`;

let fakePath = '';
function getFake(): string {
  if (!fakePath) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-llama-'));
    fakePath = path.join(dir, 'fake-llama.mjs');
    fs.writeFileSync(fakePath, FAKE_SRC);
  }
  return fakePath;
}

/** 取一個目前空閒的 port（關閉後回傳，小 race 可接受） */
async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, () => resolve()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

function withFakeMode(mode: string, extra: Record<string, string> = {}): () => void {
  const prev: Record<string, string | undefined> = {};
  prev.FAKE_MODE = process.env.FAKE_MODE;
  process.env.FAKE_MODE = mode;
  for (const [k, v] of Object.entries(extra)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

async function probe(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === 'ok';
  } catch {
    return false;
  }
}

test('start()：healthy fake → resolve { port, reused: false }', async () => {
  const restore = withFakeMode('healthy');
  const port = await freePort();
  const mgr = new LlamaServerManager({
    binPath: getFake(), modelPath: 'x.gguf', port,
    healthTimeoutMs: 15000, healthIntervalMs: 100,
  });
  try {
    const r = await mgr.start();
    assert.equal(r.port, port);
    assert.equal(r.reused, false);
    assert.equal(mgr.isRunning(), true);
    assert.ok(await probe(port));
  } finally {
    restore();
    await mgr.stop();
  }
});

test('start()：重用既有健康實例 → reused: true（不 spawn）', async () => {
  // 先起一個 healthy fake server
  const restore = withFakeMode('healthy');
  const port = await freePort();
  const holder = new LlamaServerManager({
    binPath: getFake(), modelPath: 'x.gguf', port,
    healthTimeoutMs: 15000, healthIntervalMs: 100,
  });
  const mgr = new LlamaServerManager({
    binPath: getFake(), modelPath: 'x.gguf', port,
    healthTimeoutMs: 15000, healthIntervalMs: 100,
  });
  try {
    await holder.start();
    const r = await mgr.start();
    assert.equal(r.reused, true);
    assert.equal(r.port, port);
    assert.equal(mgr.isRunning(), false); // 重用 → 非本實例 spawn
  } finally {
    restore();
    await mgr.stop(); // no-op
    assert.ok(await probe(port), '重用 stop 不應殺既有實例');
    await holder.stop();
  }
});

test('start()：crash fake → reject（重啟耗盡）', async () => {
  const restore = withFakeMode('crash');
  const port = await freePort();
  const mgr = new LlamaServerManager({
    binPath: getFake(), modelPath: 'x.gguf', port,
    healthTimeoutMs: 5000, healthIntervalMs: 100, maxRestarts: 1,
  });
  try {
    await assert.rejects(() => mgr.start());
  } finally {
    restore();
    await mgr.stop();
  }
});

test('start()：slow fake → 輪詢等待後 resolve', async () => {
  const restore = withFakeMode('slow', { FAKE_SLOW_MS: '1500' });
  const port = await freePort();
  const mgr = new LlamaServerManager({
    binPath: getFake(), modelPath: 'x.gguf', port,
    healthTimeoutMs: 15000, healthIntervalMs: 100,
  });
  try {
    const r = await mgr.start();
    assert.equal(r.reused, false);
    assert.ok(await probe(port));
  } finally {
    restore();
    await mgr.stop();
  }
});

test('start()：首次 crash → 重啟迴圈廣播 starting（含重啟次數）→ 再次 spawn 即 ready', async () => {
  // crash 一次後轉 healthy 的 fake（以檔案計數跨進程狀態；刪掉 tryPort 內重啟 onStatus 即失敗）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-restart-'));
  const bin = path.join(dir, 'fake-restart.mjs');
  const stateFile = path.join(dir, 'count.txt');
  fs.writeFileSync(bin, `
import fs from 'node:fs';
import http from 'node:http';
const file = process.env.FAKE_RESTART_STATE;
const crashes = Number(process.env.FAKE_RESTART_CRASHES ?? '1');
let n = 0;
try { n = Number(fs.readFileSync(file, 'utf-8') || '0'); } catch {}
fs.writeFileSync(file, String(n + 1));
if (n < crashes) { console.error('fake crash for restart test'); process.exit(1); }
const args = process.argv.slice(2);
const pi = args.indexOf('--port');
const port = pi >= 0 ? Number(args[pi + 1]) : 3001;
const hi = args.indexOf('--host');
const host = hi >= 0 ? args[hi + 1] : '127.0.0.1';
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); }
  else { res.writeHead(404); res.end(); }
}).listen(port, host);
`);
  const port = await freePort();
  const events: { status: string; info?: string }[] = [];
  const prevState = process.env.FAKE_RESTART_STATE;
  const prevTimes = process.env.FAKE_RESTART_CRASHES;
  process.env.FAKE_RESTART_STATE = stateFile;
  process.env.FAKE_RESTART_CRASHES = '1';
  const mgr = new LlamaServerManager({
    binPath: bin, modelPath: 'x.gguf', port,
    healthTimeoutMs: 15000, healthIntervalMs: 100, maxRestarts: 3,
    onStatus: (status, info) => { events.push({ status, info }); },
  });
  try {
    const r = await mgr.start();
    assert.equal(r.reused, false);
    // start() 進入即 starting → 重啟迴圈再一次 starting（重啟中）→ healthy 後 ready
    assert.deepEqual(events.map((e) => e.status), ['starting', 'starting', 'ready']);
    assert.match(events[1].info ?? '', /重啟中/);
    assert.equal(mgr.isRunning(), true);
  } finally {
    if (prevState === undefined) delete process.env.FAKE_RESTART_STATE;
    else process.env.FAKE_RESTART_STATE = prevState;
    if (prevTimes === undefined) delete process.env.FAKE_RESTART_CRASHES;
    else process.env.FAKE_RESTART_CRASHES = prevTimes;
    await mgr.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stop()：spawn 實例 → child 被殺；reused → no-op', async () => {
  const restore = withFakeMode('healthy');
  const port = await freePort();
  const mgr = new LlamaServerManager({
    binPath: getFake(), modelPath: 'x.gguf', port,
    healthTimeoutMs: 15000, healthIntervalMs: 100,
  });
  try {
    await mgr.start();
    assert.equal(mgr.isRunning(), true);
    await mgr.stop();
    assert.equal(mgr.isRunning(), false);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await probe(port), false);
  } finally {
    restore();
  }
});

test('stop()：啟動飛行中呼叫 → 丟掉 child 並快速報停（不留孤兒進程）', async () => {
  // slow fake：120 秒後才 listen，保證 stop() 時還在 waitReady 輪詢中；
  // healthTimeout 設 60 秒：無修復會等滿 deadline（＋重啟 loop 數分鐘），有修復數秒內報停
  const restore = withFakeMode('slow', { FAKE_SLOW_MS: '120000' });
  const port = await freePort();
  const mgr = new LlamaServerManager({
    binPath: getFake(), modelPath: 'x.gguf', port,
    healthTimeoutMs: 60000, healthIntervalMs: 100, maxRestarts: 3,
  });
  const t0 = Date.now();
  try {
    const p = mgr.start();
    await new Promise((r) => setTimeout(r, 500)); // 等 spawn＋進入 waitReady
    await mgr.stop();
    await assert.rejects(p, /stopped/);
    assert.equal(mgr.isRunning(), false);
    assert.ok(Date.now() - t0 < 15000, '應在數秒內報停，而非等滿 60s deadline');
    assert.equal(await probe(port), false);
  } finally {
    restore();
  }
});

test('start()：spawn 參數不含 b10361 不支援的 flag（--idle-timeout 回歸）', async () => {
  // strict fake：argv 出現 --idle-timeout 即秒退；start() 成功＝我們的參數被接受
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-strict-'));
  const bin = path.join(dir, 'fake-strict.mjs');
  fs.writeFileSync(bin, `
import http from 'node:http';
const args = process.argv.slice(2);
if (args.includes('--idle-timeout')) { console.error('unsupported flag: --idle-timeout'); process.exit(1); }
const pi = args.indexOf('--port');
const port = pi >= 0 ? Number(args[pi + 1]) : 3001;
const hi = args.indexOf('--host');
const host = hi >= 0 ? args[hi + 1] : '127.0.0.1';
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); }
  else { res.writeHead(404); res.end(); }
}).listen(port, host);
`);
  const port = await freePort();
  const mgr = new LlamaServerManager({
    binPath: bin, modelPath: 'x.gguf', port,
    healthTimeoutMs: 15000, healthIntervalMs: 100, maxRestarts: 0,
  });
  try {
    const r = await mgr.start();
    assert.equal(r.reused, false);
    assert.equal(mgr.isRunning(), true);
  } finally {
    await mgr.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('start()：重啟耗盡的錯誤訊息包含最後輸出（不清空診斷）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-boom-'));
  const bin = path.join(dir, 'fake-boom.mjs');
  fs.writeFileSync(bin, `console.error('boom-xyz-diagnostic'); process.exit(1);\n`);
  const port = await freePort();
  const mgr = new LlamaServerManager({
    binPath: bin, modelPath: 'x.gguf', port,
    healthTimeoutMs: 5000, healthIntervalMs: 100, maxRestarts: 0,
  });
  try {
    await assert.rejects(mgr.start(), /boom-xyz-diagnostic/);
  } finally {
    await mgr.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('port 被非 llama 程序佔用 → 依序試下一個 port', async () => {
  const restore = withFakeMode('healthy');
  const port = await freePort();
  // 佔用 base port：/health 回 404（非健康）；綁定 127.0.0.1 與 manager 探測目標一致，
  // fake 才能取到真正的 EADDRINUSE（Windows 上 :: 與 127.0.0.1 可共存，需同 host 才互斥）
  const blocker = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()));
  const mgr = new LlamaServerManager({
    binPath: getFake(), modelPath: 'x.gguf', port,
    healthTimeoutMs: 15000, healthIntervalMs: 100, maxRestarts: 0,
  });
  try {
    const r = await mgr.start();
    assert.equal(r.reused, false);
    assert.equal(r.port, port + 1);
    assert.ok(await probe(port + 1));
  } finally {
    restore();
    await mgr.stop();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    // 下一個 port 的 fake 也應被 stop 清掉（若 spawn 在 port+1）
    await new Promise((r) => setTimeout(r, 300));
  }
});

test('ensureLlamaServer：下載 → 解壓 → 回傳 exe 路徑', async () => {
  const zip = new AdmZip();
  zip.addFile('llama-server.exe', Buffer.from('fake-exe'));
  zip.addFile('ggml.dll', Buffer.from('fake-dll'));
  const buf = zip.toBuffer();
  const fetchImpl = (async (): Promise<Response> =>
    new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } })) as typeof fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindl-'));
  try {
    let prog = { d: 0, t: 0 };
    const p = await ensureLlamaServer({
      binDir: dir, release: 'b10361', fetchImpl,
      onProgress: (d, t) => { prog = { d, t }; },
    });
    assert.equal(p, path.join(dir, 'llama-b10361-cpu', 'llama-server.exe'));
    assert.equal(fs.readFileSync(p, 'utf-8'), 'fake-exe');
    assert.ok(fs.existsSync(path.join(dir, 'llama-b10361-cpu', 'ggml.dll')));
    assert.ok(prog.d > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureLlamaServer：已存在 → 跳過下載', async () => {
  let hits = 0;
  const fetchImpl = (async (): Promise<Response> => {
    hits++;
    return new Response('x', { status: 200 });
  }) as typeof fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binex-'));
  try {
    fs.mkdirSync(path.join(dir, 'llama-b10361-cpu'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'llama-b10361-cpu', 'llama-server.exe'), 'pre');
    const p = await ensureLlamaServer({ binDir: dir, release: 'b10361', fetchImpl });
    assert.ok(p.endsWith('llama-server.exe'));
    assert.equal(hits, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureLlamaServer：404 → throw', async () => {
  const fetchImpl = (async (): Promise<Response> =>
    new Response('no', { status: 404 })) as typeof fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bin404-'));
  try {
    await assert.rejects(() => ensureLlamaServer({ binDir: dir, fetchImpl }), /404/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================
// Vulkan GPU 後端：變體／regex／回退／覆寫／顯存分級
// ============================================

test('下載 URL 變體＋目錄名純函數', () => {
  // cpu 維持現行資產名
  assert.equal(
    llamaServerDownloadUrl('b10361', 'cpu'),
    'https://github.com/ggml-org/llama.cpp/releases/download/b10361/llama-b10361-bin-win-cpu-x64.zip',
  );
  assert.equal(
    llamaServerDownloadUrl('b10361'),
    'https://github.com/ggml-org/llama.cpp/releases/download/b10361/llama-b10361-bin-win-cpu-x64.zip',
  );
  // vulkan 變體
  assert.equal(
    llamaServerDownloadUrl('b10361', 'vulkan'),
    'https://github.com/ggml-org/llama.cpp/releases/download/b10361/llama-b10361-bin-win-vulkan-x64.zip',
  );
  assert.equal(llamaServerDirName('b10361', 'cpu'), 'llama-b10361-cpu');
  assert.equal(llamaServerDirName('b10361'), 'llama-b10361-cpu');
  assert.equal(llamaServerDirName('b10361', 'vulkan'), 'llama-b10361-vulkan');
});

test('GPU 錯誤 regex：命中 Vulkan 無裝置／OOM／驅動不足，排除一般 crash', () => {
  const gpuCases = [
    'no vulkan device found',
    'NO VULKAN support',
    'vk_error_device_lost',
    'vk_error_out_of_device_memory',
    'vk_error_out_of_host_memory',
    'vk_error_incompatible_driver',
    'vk_error_initialization_failed',
    'vulkan: no devices found',
    'vulkan not supported on this device',
    'vulkan initialization failed',
    'vulkan error: unavailable',
    'out of device memory',
    'out of video memory',
    'out of vram memory',
    'GPU out of memory',
    'device out of memory, try reducing layers',
    'VRAM out of memory',
    'driver too old, please update',
    'driver insufficient for vulkan',
    'incompatible driver version',
    'missing driver for GPU',
  ];
  for (const s of gpuCases) assert.equal(isGpuCrashError(s), true, `應命中：${s}`);
  const generalCases = [
    'fake crash',
    'boom-xyz-diagnostic',
    'address already in use',
    'listen EADDRINUSE',
    'invalid argument',
    'model file not found',
    '',
  ];
  for (const s of generalCases) assert.equal(isGpuCrashError(s), false, `不應命中：${s}`);
});

test('GPU 錯誤 regex：fake binary 印 GPU 字串秒崩 → 錯誤訊息為 GPU 診斷', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gpuerr-'));
  const bin = path.join(dir, 'fake-gpuerr.mjs');
  fs.writeFileSync(bin, `console.error('vk_error_device_lost: no vulkan device'); process.exit(1);\n`);
  const port = await freePort();
  const mgr = new LlamaServerManager({
    binPath: bin, modelPath: 'x.gguf', port,
    healthTimeoutMs: 5000, healthIntervalMs: 100, maxRestarts: 0,
  });
  try {
    await assert.rejects(mgr.start(), /GPU 錯誤/);
    assert.equal(isGpuCrashError(mgr.getLogTail()), true);
  } finally {
    await mgr.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('顯存到層數映射純函數', () => {
  // ≥6GB 全層 99
  assert.equal(gpuLayersForVram(6 * 1024), FULL_GPU_LAYERS);
  assert.equal(gpuLayersForVram(8 * 1024), FULL_GPU_LAYERS);
  assert.equal(gpuLayersForVram(16 * 1024), FULL_GPU_LAYERS);
  // ≥4GB 約 20 層
  assert.equal(gpuLayersForVram(4 * 1024), REDUCED_GPU_LAYERS);
  assert.equal(gpuLayersForVram(5 * 1024), REDUCED_GPU_LAYERS);
  assert.equal(gpuLayersForVram(4096 + 1024), REDUCED_GPU_LAYERS);
  // ＜4GB 走 CPU
  assert.equal(gpuLayersForVram(3 * 1024), 0);
  assert.equal(gpuLayersForVram(0), 0);
  // 內顯走 CPU（不論顯存數字）
  assert.equal(gpuLayersForVram(16 * 1024, true), 0);
  assert.equal(gpuLayersForVram(undefined, true), 0);
  // 未知保守 20
  assert.equal(gpuLayersForVram(undefined), REDUCED_GPU_LAYERS);
  assert.equal(gpuLayersForVram(NaN), REDUCED_GPU_LAYERS);
  // 自動降層：高層→20，20 以下→0（改走 CPU）
  assert.equal(reducedGpuLayers(99), 20);
  assert.equal(reducedGpuLayers(33), 20);
  assert.equal(reducedGpuLayers(20), 0);
  assert.equal(reducedGpuLayers(0), 0);
  // 預設層數：env 強制覆寫 ＞ 分級；內顯→0
  assert.equal(defaultGpuLayers({ LLAMA_GPU_LAYERS: '0' }), 0);
  assert.equal(defaultGpuLayers({ LLAMA_GPU_LAYERS: '35' }), 35);
  assert.equal(defaultGpuLayers({ LLAMA_VRAM_MB: String(8 * 1024) }), 99);
  assert.equal(defaultGpuLayers({ LLAMA_INTEGRATED_GPU: '1' }), 0);
  assert.equal(defaultGpuLayers({}), 20);
});

test('手動覆寫讀寫＋優先序（選項 hook ＞ 持久化手動 ＞ env ＞ auto）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-pref-'));
  try {
    // 預設 auto（無檔案）
    assert.equal(readBackendPreference(dir), 'auto');
    writeBackendPreference('gpu', dir);
    assert.equal(readBackendPreference(dir), 'gpu');
    writeBackendPreference('cpu', dir);
    assert.equal(readBackendPreference(dir), 'cpu');
    writeBackendPreference('auto', dir);
    assert.equal(readBackendPreference(dir), 'auto');
    // 髒資料 → auto
    fs.writeFileSync(path.join(dir, 'backend.json'), '{"backend":"cuda"}');
    assert.equal(readBackendPreference(dir), 'auto');
    fs.writeFileSync(path.join(dir, 'backend.json'), 'not-json{');
    assert.equal(readBackendPreference(dir), 'auto');

    // 優先序
    assert.equal(effectiveBackendPreference({ option: 'cpu', stored: 'gpu', env: { LLAMA_BACKEND: 'gpu' } }), 'cpu');
    assert.equal(effectiveBackendPreference({ stored: 'gpu', env: { LLAMA_BACKEND: 'cpu' } }), 'gpu');
    assert.equal(effectiveBackendPreference({ stored: 'auto', env: { LLAMA_BACKEND: 'cpu' } }), 'cpu');
    assert.equal(effectiveBackendPreference({ env: { LLAMA_BACKEND: 'gpu' } }), 'gpu');
    assert.equal(effectiveBackendPreference({}), 'auto');
    assert.equal(effectiveBackendPreference({ env: { LLAMA_BACKEND: 'nope' } }), 'auto');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('變體分目錄：prune 清殘留／legacy 搬家', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vardir-'));
  try {
    fs.mkdirSync(path.join(dir, 'llama-b10361-cpu'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'llama-b10361-vulkan'), { recursive: true });
    const removed = pruneOtherVariantDirs(dir, 'b10361', 'cpu');
    assert.equal(removed.length, 1);
    assert.ok(removed[0].endsWith('llama-b10361-vulkan'));
    assert.ok(!fs.existsSync(path.join(dir, 'llama-b10361-vulkan')));
    assert.ok(fs.existsSync(path.join(dir, 'llama-b10361-cpu')));

    // legacy 無後綴 → 搬為 cpu（cpu 缺 exe 時）
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    try {
      fs.mkdirSync(path.join(dir2, 'llama-b10361'), { recursive: true });
      fs.writeFileSync(path.join(dir2, 'llama-b10361', 'llama-server.exe'), 'old');
      migrateLegacyLlamaDir(dir2, 'b10361');
      assert.ok(fs.existsSync(path.join(dir2, 'llama-b10361-cpu', 'llama-server.exe')));
      assert.ok(!fs.existsSync(path.join(dir2, 'llama-b10361')));
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureLlamaServer 變體分目錄：cpu／vulkan 各就其位', async () => {
  const mkFetch = (marker: string) => {
    const zip = new AdmZip();
    zip.addFile('llama-server.exe', Buffer.from(marker));
    const buf = zip.toBuffer();
    return (async (): Promise<Response> =>
      new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } })) as typeof fetch;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binvar-'));
  try {
    const cpu = await ensureLlamaServer({ binDir: dir, release: 'b10361', variant: 'cpu', fetchImpl: mkFetch('cpu-exe') });
    assert.equal(cpu, path.join(dir, 'llama-b10361-cpu', 'llama-server.exe'));
    const vk = await ensureLlamaServer({ binDir: dir, release: 'b10361', variant: 'vulkan', fetchImpl: mkFetch('vk-exe') });
    assert.equal(vk, path.join(dir, 'llama-b10361-vulkan', 'llama-server.exe'));
    assert.equal(fs.readFileSync(cpu, 'utf-8'), 'cpu-exe');
    assert.equal(fs.readFileSync(vk, 'utf-8'), 'vk-exe');
    // 手動單變體 prune：留 vulkan 清 cpu
    const removed = pruneOtherVariantDirs(dir, 'b10361', 'vulkan');
    assert.ok(removed[0].endsWith('llama-b10361-cpu'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureLlamaServerPair：先 CPU 再 Vulkan（各下載一次）', async () => {
  const order: string[] = [];
  const fetchImpl = (async (url: unknown): Promise<Response> => {
    const u = String(url);
    order.push(u.includes('vulkan') ? 'vulkan' : 'cpu');
    const zip = new AdmZip();
    zip.addFile('llama-server.exe', Buffer.from('exe'));
    const buf = zip.toBuffer();
    return new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } });
  }) as typeof fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binpair-'));
  try {
    const { cpuPath, vulkanPath } = await ensureLlamaServerPair({ binDir: dir, release: 'b10361', fetchImpl });
    assert.deepEqual(order, ['cpu', 'vulkan']);
    assert.equal(cpuPath, path.join(dir, 'llama-b10361-cpu', 'llama-server.exe'));
    assert.equal(vulkanPath, path.join(dir, 'llama-b10361-vulkan', 'llama-server.exe'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('回退狀態機：Vulkan-fake 秒崩（GPU 錯）→ 降層一次 → 換碟上 CPU 包，無二次下載', async () => {
  // Vulkan-fake：印 GPU 錯誤秒崩；CPU-fake：健康
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-'));
  const vulkanFake = path.join(dir, 'vulkan-fake.mjs');
  const cpuFake = path.join(dir, 'cpu-fake.mjs');
  fs.writeFileSync(vulkanFake, `console.error('vk_error_device_lost: no vulkan device'); process.exit(1);\n`);
  fs.writeFileSync(cpuFake, `
import http from 'node:http';
const args = process.argv.slice(2);
const pi = args.indexOf('--port');
const port = pi >= 0 ? Number(args[pi + 1]) : 3001;
const hi = args.indexOf('--host');
const host = hi >= 0 ? args[hi + 1] : '127.0.0.1';
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); }
  else { res.writeHead(404); res.end(); }
}).listen(port, host);
`);
  // 無二次下載驗證：回退期只吃碟上包，目錄不得新增下載產物
  const beforeFiles = fs.readdirSync(dir).sort();
  const port = await freePort();
  const events: { status: string; info?: string }[] = [];
  const gpuLayersSeen: number[] = [];
  const { startLlamaServerWithFallback: start } = await import('./llama-server.js');
  const result = await start({
    cpuBinPath: cpuFake,
    vulkanBinPath: vulkanFake,
    modelPath: 'x.gguf',
    port,
    gpuLayers: 99,
    healthTimeoutMs: 8000,
    healthIntervalMs: 100,
    maxRestarts: 0,
    onStatus: (status, info) => { events.push({ status, info }); },
    createManager: (o) => {
      if (o.binPath === vulkanFake) gpuLayersSeen.push(o.gpuLayers ?? 0);
      return new LlamaServerManager(o);
    },
  });
  try {
    // 換包重啟：最終 CPU 生效
    assert.equal(result.backend, 'cpu');
    assert.equal(result.gpuLayers, 0);
    assert.equal(result.manager.isRunning(), true);
    assert.ok(await probe(port));
    // 降層重試一次：同包先 99 後 20
    assert.deepEqual(gpuLayersSeen, [99, 20]);
    // 狀態廣播：降層＋切 CPU 都有 starting 訊息，最終 ready
    const infos = events.map((e) => `${e.status}:${e.info ?? ''}`).join('\n');
    assert.match(infos, /降層/);
    assert.match(infos, /CPU/);
    assert.equal(events[events.length - 1].status, 'ready');
    // 無二次下載：目錄無新增下載產物
    assert.deepEqual(fs.readdirSync(dir).sort(), beforeFiles);
  } finally {
    await result.manager.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('回退狀態機：一般 crash 不走回退（直接丟原錯）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-general-'));
  const vulkanFake = path.join(dir, 'vulkan-fake.mjs');
  const cpuFake = path.join(dir, 'cpu-fake.mjs');
  fs.writeFileSync(vulkanFake, `console.error('boom-xyz-general'); process.exit(1);\n`);
  fs.writeFileSync(cpuFake, `console.error('should-never-start'); process.exit(1);\n`);
  const port = await freePort();
  let cpuStarted = false;
  try {
    await assert.rejects(
      startLlamaServerWithFallback({
        cpuBinPath: cpuFake,
        vulkanBinPath: vulkanFake,
        modelPath: 'x.gguf',
        port,
        gpuLayers: 99,
        healthTimeoutMs: 5000,
        healthIntervalMs: 100,
        maxRestarts: 0,
        createManager: (o) => {
          if (o.binPath === cpuFake) cpuStarted = true;
          return new LlamaServerManager(o);
        },
      }),
      /boom-xyz-general/,
    );
    assert.equal(cpuStarted, false, '一般 crash 不應換 CPU 包');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Vulkan 啟動參數：gpuLayers > 0 才帶 --n-gpu-layers＋砍半 KV', async () => {
  // argv 回顯 fake：把收到的 args 寫檔，manager ready 後讀檔驗證
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpuargs-'));
  const bin = path.join(dir, 'echo-args.mjs');
  const outFile = path.join(dir, 'args.json');
  fs.writeFileSync(bin, `
import fs from 'node:fs';
import http from 'node:http';
fs.writeFileSync(process.env.FAKE_ARGS_OUT, JSON.stringify(process.argv.slice(2)));
const args = process.argv.slice(2);
const pi = args.indexOf('--port');
const port = pi >= 0 ? Number(args[pi + 1]) : 3001;
const hi = args.indexOf('--host');
const host = hi >= 0 ? args[hi + 1] : '127.0.0.1';
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); }
  else { res.writeHead(404); res.end(); }
}).listen(port, host);
`);
  const prev = process.env.FAKE_ARGS_OUT;
  process.env.FAKE_ARGS_OUT = outFile;
  const port = await freePort();
  const mgr = new LlamaServerManager({
    binPath: bin, modelPath: 'x.gguf', port, gpuLayers: 99,
    healthTimeoutMs: 15000, healthIntervalMs: 100,
  });
  try {
    await mgr.start();
    const args = JSON.parse(fs.readFileSync(outFile, 'utf-8')) as string[];
    assert.ok(args.includes('--n-gpu-layers') && args.includes('99'));
    assert.ok(args.includes('--cache-type-k') && args.includes('q8_0'));
    assert.ok(args.includes('--cache-type-v') && args.includes('q8_0'));
  } finally {
    if (prev === undefined) delete process.env.FAKE_ARGS_OUT;
    else process.env.FAKE_ARGS_OUT = prev;
    await mgr.stop();
  }
  // CPU（0 層）不帶 GPU flags
  const outFile2 = path.join(dir, 'args2.json');
  process.env.FAKE_ARGS_OUT = outFile2;
  const port2 = await freePort();
  const mgr2 = new LlamaServerManager({
    binPath: bin, modelPath: 'x.gguf', port: port2, gpuLayers: 0,
    healthTimeoutMs: 15000, healthIntervalMs: 100,
  });
  try {
    await mgr2.start();
    const args = JSON.parse(fs.readFileSync(outFile2, 'utf-8')) as string[];
    assert.ok(!args.includes('--n-gpu-layers'));
    assert.ok(!args.includes('--cache-type-k'));
  } finally {
    if (prev === undefined) delete process.env.FAKE_ARGS_OUT;
    else process.env.FAKE_ARGS_OUT = prev;
    await mgr2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultThreads：實體核啟發式（邏輯核一半，上限 8，下限 1）', () => {
  assert.equal(defaultThreads(1), 1);
  assert.equal(defaultThreads(2), 1);
  assert.equal(defaultThreads(4), 2);
  assert.equal(defaultThreads(8), 4);    // 目標機器 i3-14100：8 線程→4，不再超訂
  assert.equal(defaultThreads(12), 6);
  assert.equal(defaultThreads(16), 8);
  assert.equal(defaultThreads(32), 8);   // 多核機器不傷：封頂 8
  assert.equal(defaultThreads(0), 1);
});

test('LlamaServerManager：未指定 threads 用啟發式預設；顯式指定照用', () => {
  const heuristic = defaultThreads();
  assert.ok(heuristic >= 1 && heuristic <= 8);
  const a = new LlamaServerManager({ binPath: 'x.exe', modelPath: 'm.gguf' });
  assert.equal((a as unknown as { options: { threads: number } }).options.threads, heuristic);
  const b = new LlamaServerManager({ binPath: 'x.exe', modelPath: 'm.gguf', threads: 2 });
  assert.equal((b as unknown as { options: { threads: number } }).options.threads, 2);
});

test('整合：真實 llama-server.exe（不存在時 skip）', async (t) => {
  const { getDefaultBinDir } = await import('./llama-server.js');
  const candidates = [
    path.join(getDefaultBinDir(), 'llama-b10361-cpu', 'llama-server.exe'),
    path.join(getDefaultBinDir(), 'llama-b10361-vulkan', 'llama-server.exe'),
    path.join(getDefaultBinDir(), 'llama-b10361', 'llama-server.exe'),
    path.join(getDefaultBinDir(), 'llama-server.exe'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    t.skip('真實 llama-server.exe 不存在，跳過');
    return;
  }
  const modelsDir = path.join(os.tmpdir(), 'realmodel-');
  const mgr = new LlamaServerManager({ binPath: found, modelPath: path.join(modelsDir, 'x.gguf'), port: 3001 });
  const r = await mgr.start();
  assert.ok(r.port >= 3001);
  await mgr.stop();
});
