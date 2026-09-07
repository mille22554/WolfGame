/**
 * server.test.ts — 靜態檔案 / WS 觀戰 / GM 檢視 / 關閉機制測試
 * （mock 模式，不載入模型；每測試獨立 server 實例）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from './server.js';
const origProvider = process.env.LLM_PROVIDER;
before(() => {
    process.env.LLM_PROVIDER = 'mock';
});
after(() => {
    if (origProvider === undefined)
        delete process.env.LLM_PROVIDER;
    else
        process.env.LLM_PROVIDER = origProvider;
});
// Scripted mock dispatcher：即時確定性回應，不碰模型
function mockDispatcher() {
    return {
        async start() { },
        async shutdown() { },
        async generate(prompt) {
            if (prompt.includes('【裁判任務】')) {
                const slots = [];
                for (const m of prompt.matchAll(/^(\d+)\.\s/gm))
                    slots.push(parseInt(m[1], 10));
                return slots.map((s) => `${s}: 5`).join('\n');
            }
            if (prompt.includes('【你的預發言草稿】'))
                return 'P0：「展開後的完整發言。」';
            const m = prompt.match(/你是 P(\d+)/);
            const id = m ? m[1] : '1';
            return `P${id}：「我比較在意大家的發言。」`;
        },
        async requestSpeech(_pid, prompt) {
            return { text: prompt.slice(0, 20) || '發言' };
        },
        async requestVote(playerId) {
            return { targetId: playerId };
        },
        async requestNightAction(playerId) {
            return { targetId: playerId };
        },
    };
}
async function boot(overrides = {}) {
    return startServer({
        port: 0,
        playerCount: 6,
        openBrowser: false,
        exitProcess: false,
        speechesPerDay: 1000, // 測試期間不自動關閉討論
        dispatcherFactory: () => mockDispatcher(),
        ...overrides,
    });
}
function get(path, port) {
    return new Promise((resolve, reject) => {
        import('http').then(({ default: http }) => {
            http.get({ host: 'localhost', port, path }, (res) => {
                if (res.statusCode === 302) {
                    resolve({ status: 302, body: '', headers: res.headers });
                    res.resume();
                    return;
                }
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
            }).on('error', reject);
        });
    });
}
test('靜態檔案：GET / → 200；CSS → 200；路徑穿越 → 404', async () => {
    const h = await boot();
    try {
        const index = await get('/', h.port);
        assert.equal(index.status, 200);
        assert.ok(index.body.includes('人狼遊戲'));
        const css = await get('/css/style.css', h.port);
        assert.equal(css.status, 200);
        assert.ok(String(css.headers['content-type']).includes('text/css'));
        const evil = await get('/%2e%2e/%2e%2e/package.json', h.port);
        assert.equal(evil.status, 404);
        const missing = await get('/nope.html', h.port);
        assert.equal(missing.status, 404);
    }
    finally {
        await h.shutdown('test');
    }
});
test('WS 連線 → 收到 SNAPSHOT（觀戰視角，無角色洩漏）', async () => {
    const h = await boot();
    try {
        const ws = new WebSocket(`ws://localhost:${h.port}`);
        const snap = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('等 SNAPSHOT 逾時')), 5000);
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(String(data));
                    if (msg.type === 'SNAPSHOT' && msg.snapshot) {
                        clearTimeout(timer);
                        resolve(msg);
                    }
                }
                catch { /* ignore */ }
            });
            ws.on('error', reject);
        });
        assert.ok(snap.snapshot.phase);
        assert.ok(Array.isArray(snap.snapshot.alivePlayers));
        ws.close();
        await new Promise((r) => setTimeout(r, 50));
    }
    finally {
        await h.shutdown('test');
    }
});
test('SET_GM_VIEW → 收到含角色的 snapshot', async () => {
    const h = await boot();
    try {
        const ws = new WebSocket(`ws://localhost:${h.port}`);
        const gmSnap = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('等 GM SNAPSHOT 逾時')), 5000);
            ws.on('open', () => {
                ws.send(JSON.stringify({ type: 'SET_GM_VIEW', enabled: true }));
            });
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(String(data));
                    if (msg.type === 'PING') {
                        ws.send(JSON.stringify({ type: 'PONG' }));
                        return;
                    }
                    // 訊息有序：SET_GM_VIEW 之後的 gmView 快照即為 GM 視角
                    if (msg.type === 'SNAPSHOT' && msg.gmView === true && msg.snapshot?.players) {
                        clearTimeout(timer);
                        resolve(msg.snapshot);
                    }
                }
                catch { /* ignore */ }
            });
            ws.on('error', reject);
        });
        assert.ok(gmSnap.players.length > 0);
        assert.ok(gmSnap.players[0].role);
        ws.close();
        await new Promise((r) => setTimeout(r, 50));
    }
    finally {
        await h.shutdown('test');
    }
});
test('LEAVE（最後 client）→ shutdown（closed reason leave）', async () => {
    let reason = '';
    const h = await boot({ onShutdown: (r) => { reason = r; } });
    const ws = new WebSocket(`ws://localhost:${h.port}`);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('連線逾時')), 5000);
        ws.on('open', () => {
            clearTimeout(timer);
            resolve();
        });
        ws.on('error', reject);
    });
    ws.send(JSON.stringify({ type: 'LEAVE' }));
    const closedReason = await Promise.race([
        h.closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('等關閉逾時')), 5000)),
    ]);
    assert.equal(closedReason, 'leave');
    assert.equal(reason, 'leave');
});
test('斷線 → 0 client → 兜底 timer 觸發關閉', async () => {
    let reason = '';
    const h = await boot({ zeroClientShutdownMs: 80, onShutdown: (r) => { reason = r; } });
    const ws = new WebSocket(`ws://localhost:${h.port}`);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('連線逾時')), 5000);
        ws.on('open', () => {
            clearTimeout(timer);
            resolve();
        });
        ws.on('error', reject);
    });
    ws.close(); // 非 LEAVE 斷線 → 兜底 timer
    const closedReason = await Promise.race([
        h.closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('等兜底關閉逾時')), 5000)),
    ]);
    assert.equal(closedReason, 'no-clients');
    assert.equal(reason, 'no-clients');
});
test('ping 超時 → 連線被 terminate', async () => {
    const h = await boot({ pingIntervalMs: 30, pingTimeoutMs: 60 });
    try {
        const ws = new WebSocket(`ws://localhost:${h.port}`);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('連線逾時')), 5000);
            ws.on('open', () => {
                clearTimeout(timer);
                resolve();
            });
            ws.on('error', reject);
        });
        // 故意不回 PONG → 應被 terminate
        const closed = await Promise.race([
            new Promise((resolve) => {
                ws.on('close', () => resolve(true));
            }),
            new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
        ]);
        assert.equal(closed, true, 'ping 超時應斷開連線');
    }
    finally {
        await h.shutdown('test');
    }
});
//# sourceMappingURL=server.test.js.map