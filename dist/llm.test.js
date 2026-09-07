/**
 * llm.test.ts — OpenAICompatibleProvider / MockProvider 測試
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { OpenAICompatibleProvider, MockProvider } from './llm.js';
async function withFakeServer(opts = {}) {
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            try {
                opts.onRequest?.(JSON.parse(raw));
            }
            catch {
                /* ignore */
            }
            if (opts.rawBody !== undefined) {
                res.writeHead(opts.status ?? 200, { 'Content-Type': 'text/plain' });
                res.end(opts.rawBody);
                return;
            }
            res.writeHead(opts.status ?? 200, { 'Content-Type': 'application/json' });
            res.end(opts.body ?? JSON.stringify({ choices: [{ message: { content: '你好' } }] }));
        });
    });
    await new Promise((resolve) => server.listen(0, () => resolve()));
    const port = server.address().port;
    return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
test('OpenAICompatibleProvider：200 + choices → 回傳文字', async () => {
    const { port, close } = await withFakeServer();
    try {
        const p = new OpenAICompatibleProvider({ baseURL: `http://localhost:${port}/v1`, model: 'm' });
        assert.equal(await p.chat([{ role: 'user', content: 'hi' }]), '你好');
    }
    finally {
        await close();
    }
});
test('OpenAICompatibleProvider：請求 body 含 model/temperature/max_tokens', async () => {
    let seen = {};
    const { port, close } = await withFakeServer({ onRequest: (b) => { seen = b; } });
    try {
        const p = new OpenAICompatibleProvider({ baseURL: `http://localhost:${port}/v1`, model: 'test-model' });
        await p.chat([{ role: 'user', content: 'hi' }], { temperature: 0.3, maxTokens: 100 });
        assert.equal(seen.model, 'test-model');
        assert.equal(seen.temperature, 0.3);
        assert.equal(seen.max_tokens, 100);
    }
    finally {
        await close();
    }
});
test('OpenAICompatibleProvider：HTTP 500 → throw（含 status）', async () => {
    const { port, close } = await withFakeServer({ status: 500, rawBody: 'boom' });
    try {
        const p = new OpenAICompatibleProvider({ baseURL: `http://localhost:${port}/v1`, model: 'm' });
        await assert.rejects(() => p.chat([{ role: 'user', content: 'hi' }]), /500/);
    }
    finally {
        await close();
    }
});
test('OpenAICompatibleProvider：非 JSON → throw', async () => {
    const { port, close } = await withFakeServer({ rawBody: 'not-json{{{' });
    try {
        const p = new OpenAICompatibleProvider({ baseURL: `http://localhost:${port}/v1`, model: 'm' });
        await assert.rejects(() => p.chat([{ role: 'user', content: 'hi' }]), /JSON/);
    }
    finally {
        await close();
    }
});
test('OpenAICompatibleProvider：缺 content → throw', async () => {
    const { port, close } = await withFakeServer({ body: JSON.stringify({ choices: [] }) });
    try {
        const p = new OpenAICompatibleProvider({ baseURL: `http://localhost:${port}/v1`, model: 'm' });
        await assert.rejects(() => p.chat([{ role: 'user', content: 'hi' }]), /content/);
    }
    finally {
        await close();
    }
});
test('OpenAICompatibleProvider：連線拒絕 → throw「LLM 連線失敗」', async () => {
    // 找一個未 listen 的 port：起後即關
    const tmp = http.createServer();
    await new Promise((resolve) => tmp.listen(0, () => resolve()));
    const port = tmp.address().port;
    await new Promise((resolve) => tmp.close(() => resolve()));
    const p = new OpenAICompatibleProvider({ baseURL: `http://localhost:${port}/v1`, model: 'm' });
    await assert.rejects(() => p.chat([{ role: 'user', content: 'hi' }]), /LLM 連線失敗/);
});
test('MockProvider：投票/夜晚/一般 prompt → 確定性回應', async () => {
    const m = new MockProvider();
    assert.match(await m.chat([{ role: 'user', content: '請投票 P3' }]), /P3/);
    assert.match(await m.chat([{ role: 'user', content: '今晚請選擇 P5' }]), /P5/);
    assert.match(await m.chat([{ role: 'user', content: '夜晚查驗 P2' }]), /P2/);
    assert.match(await m.chat([{ role: 'user', content: '請發言 P7' }]), /P7/);
});
//# sourceMappingURL=llm.test.js.map