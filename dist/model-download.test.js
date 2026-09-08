/**
 * model-download.test.ts — parseModelUri / downloadModelFile 測試
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseModelUri, downloadModelFile } from './model-download.js';
test('parseModelUri：hf URI → HF resolve URL + fileName', () => {
    const r = parseModelUri('hf:Qwen/Qwen3-4B-GGUF:Qwen3-4B-Q4_K_M.gguf');
    assert.equal(r.url, 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf');
    assert.equal(r.fileName, 'Qwen3-4B-Q4_K_M.gguf');
});
test('parseModelUri：https 直通', () => {
    const r = parseModelUri('https://example.com/models/foo.gguf');
    assert.equal(r.url, 'https://example.com/models/foo.gguf');
    assert.equal(r.fileName, 'foo.gguf');
});
test('parseModelUri：非法 URI → throw', () => {
    assert.throws(() => parseModelUri('hf:bad-no-colon'), /無效 hf URI/);
    assert.throws(() => parseModelUri('ftp://x/y.gguf'), /不支援/);
});
function mkTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mdl-'));
}
async function withServer(handler) {
    let hits = 0;
    const server = http.createServer((req, res) => {
        hits++;
        handler(req, res);
    });
    await new Promise((resolve) => server.listen(0, () => resolve()));
    const port = server.address().port;
    return { server, port, hits: () => hits };
}
test('downloadModelFile：下載寫入正確內容 + onProgress 最終 downloaded===total', async () => {
    const payload = Buffer.from('fake-gguf-bytes-12345');
    const { server, port } = await withServer((_req, res) => {
        res.writeHead(200, { 'Content-Length': String(payload.length) });
        res.end(payload);
    });
    const dir = mkTempDir();
    try {
        let last = { d: 0, t: 0 };
        let calls = 0;
        const p = await downloadModelFile(`http://localhost:${port}/m.gguf`, dir, (d, t) => {
            calls++;
            last = { d, t };
        });
        assert.equal(p, path.join(dir, 'm.gguf'));
        assert.deepEqual(fs.readFileSync(p), payload);
        assert.ok(calls > 0);
        assert.equal(last.d, payload.length);
        assert.equal(last.t, payload.length);
        assert.ok(!fs.existsSync(p + '.tmp'));
    }
    finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('downloadModelFile：已存在精確檔名 → 跳過（server hit 0）', async () => {
    const { server, port, hits } = await withServer((_req, res) => {
        res.writeHead(200, { 'Content-Length': '3' });
        res.end('abc');
    });
    const dir = mkTempDir();
    try {
        fs.writeFileSync(path.join(dir, 'm.gguf'), 'existing');
        const p = await downloadModelFile(`http://localhost:${port}/m.gguf`, dir);
        assert.equal(p, path.join(dir, 'm.gguf'));
        assert.equal(fs.readFileSync(p, 'utf-8'), 'existing');
        assert.equal(hits(), 0);
    }
    finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('downloadModelFile：modelsDir 有任一 .gguf → 跳過', async () => {
    const { server, port, hits } = await withServer((_req, res) => {
        res.writeHead(200, { 'Content-Length': '3' });
        res.end('abc');
    });
    const dir = mkTempDir();
    try {
        fs.writeFileSync(path.join(dir, 'hf_Qwen_Qwen3-4B.QWEN3-4B-Q4_K_M.GGUF.gguf'), 'legacy');
        const p = await downloadModelFile('hf:Qwen/Qwen3-4B-GGUF:Qwen3-4B-Q4_K_M.gguf', dir);
        assert.equal(p, path.join(dir, 'hf_Qwen_Qwen3-4B.QWEN3-4B-Q4_K_M.GGUF.gguf'));
        assert.equal(hits(), 0);
    }
    finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('downloadModelFile：HTTP 404 → throw + tmp 清理', async () => {
    const { server, port } = await withServer((_req, res) => {
        res.writeHead(404);
        res.end('no');
    });
    const dir = mkTempDir();
    try {
        await assert.rejects(() => downloadModelFile(`http://localhost:${port}/missing.gguf`, dir), /404/);
        assert.ok(!fs.existsSync(path.join(dir, 'missing.gguf.tmp')));
        assert.ok(!fs.existsSync(path.join(dir, 'missing.gguf')));
    }
    finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('downloadModelFile：中斷（server 中途斷線）→ throw + tmp 清理', async () => {
    const { server, port } = await withServer((_req, res) => {
        res.writeHead(200, { 'Content-Length': '100000' });
        res.write('partial');
        // 中途銷毀連線
        setTimeout(() => res.destroy(), 20);
    });
    const dir = mkTempDir();
    try {
        await assert.rejects(() => downloadModelFile(`http://localhost:${port}/cut.gguf`, dir));
        assert.ok(!fs.existsSync(path.join(dir, 'cut.gguf.tmp')));
        assert.ok(!fs.existsSync(path.join(dir, 'cut.gguf')));
    }
    finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('downloadModelFile：停滯（連上無資料）→ 下載停滯超時 abort + tmp 清理', async (t) => {
    const prev = process.env.DOWNLOAD_STALL_TIMEOUT_MS;
    process.env.DOWNLOAD_STALL_TIMEOUT_MS = '50';
    t.after(() => {
        if (prev === undefined)
            delete process.env.DOWNLOAD_STALL_TIMEOUT_MS;
        else
            process.env.DOWNLOAD_STALL_TIMEOUT_MS = prev;
    });
    // 連上但永不回應任何 bytes
    const { server, port } = await withServer((_req, _res) => { });
    const dir = mkTempDir();
    try {
        await assert.rejects(() => downloadModelFile(`http://localhost:${port}/stall.gguf`, dir), /下載停滯超時/);
        assert.ok(!fs.existsSync(path.join(dir, 'stall.gguf.tmp')));
        assert.ok(!fs.existsSync(path.join(dir, 'stall.gguf')));
    }
    finally {
        server.closeAllConnections?.();
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('downloadModelFile：極慢但持續有資料 → 成功（每 chunk 重置停滯計時）', async (t) => {
    const prev = process.env.DOWNLOAD_STALL_TIMEOUT_MS;
    process.env.DOWNLOAD_STALL_TIMEOUT_MS = '200';
    t.after(() => {
        if (prev === undefined)
            delete process.env.DOWNLOAD_STALL_TIMEOUT_MS;
        else
            process.env.DOWNLOAD_STALL_TIMEOUT_MS = prev;
    });
    // 每 50ms 吐 1 byte，共 6 bytes（總耗時 > 單次停滯上限，但每 chunk 重置故不應超時）
    const { server, port } = await withServer((_req, res) => {
        res.writeHead(200);
        let n = 0;
        const timer = setInterval(() => {
            n++;
            res.write('x');
            if (n >= 6) {
                clearInterval(timer);
                res.end();
            }
        }, 50);
    });
    const dir = mkTempDir();
    try {
        const p = await downloadModelFile(`http://localhost:${port}/slow.gguf`, dir);
        assert.equal(fs.readFileSync(p, 'utf-8'), 'xxxxxx');
        assert.ok(!fs.existsSync(p + '.tmp'));
    }
    finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=model-download.test.js.map