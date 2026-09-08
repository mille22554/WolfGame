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
import { LlamaServerManager, ensureLlamaServer } from './llama-server.js';
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
function getFake() {
    if (!fakePath) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-llama-'));
        fakePath = path.join(dir, 'fake-llama.mjs');
        fs.writeFileSync(fakePath, FAKE_SRC);
    }
    return fakePath;
}
/** 取一個目前空閒的 port（關閉後回傳，小 race 可接受） */
async function freePort() {
    const s = http.createServer();
    await new Promise((resolve) => s.listen(0, () => resolve()));
    const port = s.address().port;
    await new Promise((resolve) => s.close(() => resolve()));
    return port;
}
function withFakeMode(mode, extra = {}) {
    const prev = {};
    prev.FAKE_MODE = process.env.FAKE_MODE;
    process.env.FAKE_MODE = mode;
    for (const [k, v] of Object.entries(extra)) {
        prev[k] = process.env[k];
        process.env[k] = v;
    }
    return () => {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined)
                delete process.env[k];
            else
                process.env[k] = v;
        }
    };
}
async function probe(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (!res.ok)
            return false;
        const body = (await res.json());
        return body.status === 'ok';
    }
    catch {
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
    }
    finally {
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
    }
    finally {
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
    }
    finally {
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
    }
    finally {
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
    const events = [];
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
    }
    finally {
        if (prevState === undefined)
            delete process.env.FAKE_RESTART_STATE;
        else
            process.env.FAKE_RESTART_STATE = prevState;
        if (prevTimes === undefined)
            delete process.env.FAKE_RESTART_CRASHES;
        else
            process.env.FAKE_RESTART_CRASHES = prevTimes;
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
    }
    finally {
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
    }
    finally {
        restore();
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
    await new Promise((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()));
    const mgr = new LlamaServerManager({
        binPath: getFake(), modelPath: 'x.gguf', port,
        healthTimeoutMs: 15000, healthIntervalMs: 100, maxRestarts: 0,
    });
    try {
        const r = await mgr.start();
        assert.equal(r.reused, false);
        assert.equal(r.port, port + 1);
        assert.ok(await probe(port + 1));
    }
    finally {
        restore();
        await mgr.stop();
        await new Promise((resolve) => blocker.close(() => resolve()));
        // 下一個 port 的 fake 也應被 stop 清掉（若 spawn 在 port+1）
        await new Promise((r) => setTimeout(r, 300));
    }
});
test('ensureLlamaServer：下載 → 解壓 → 回傳 exe 路徑', async () => {
    const zip = new AdmZip();
    zip.addFile('llama-server.exe', Buffer.from('fake-exe'));
    zip.addFile('ggml.dll', Buffer.from('fake-dll'));
    const buf = zip.toBuffer();
    const fetchImpl = (async () => new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindl-'));
    try {
        let prog = { d: 0, t: 0 };
        const p = await ensureLlamaServer({
            binDir: dir, release: 'b10361', fetchImpl,
            onProgress: (d, t) => { prog = { d, t }; },
        });
        assert.equal(p, path.join(dir, 'llama-b10361', 'llama-server.exe'));
        assert.equal(fs.readFileSync(p, 'utf-8'), 'fake-exe');
        assert.ok(fs.existsSync(path.join(dir, 'llama-b10361', 'ggml.dll')));
        assert.ok(prog.d > 0);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('ensureLlamaServer：已存在 → 跳過下載', async () => {
    let hits = 0;
    const fetchImpl = (async () => {
        hits++;
        return new Response('x', { status: 200 });
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binex-'));
    try {
        fs.mkdirSync(path.join(dir, 'llama-b10361'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'llama-b10361', 'llama-server.exe'), 'pre');
        const p = await ensureLlamaServer({ binDir: dir, release: 'b10361', fetchImpl });
        assert.ok(p.endsWith('llama-server.exe'));
        assert.equal(hits, 0);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('ensureLlamaServer：404 → throw', async () => {
    const fetchImpl = (async () => new Response('no', { status: 404 }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bin404-'));
    try {
        await assert.rejects(() => ensureLlamaServer({ binDir: dir, fetchImpl }), /404/);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('整合：真實 llama-server.exe（不存在時 skip）', async (t) => {
    const { getDefaultBinDir } = await import('./llama-server.js');
    const candidates = [
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
//# sourceMappingURL=llama-server.test.js.map