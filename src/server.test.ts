/**
 * server.test.ts — 靜態檔案 / WS 觀戰 / GM 檢視 / 關閉機制測試
 * （mock 模式，不載入模型；每測試獨立 server 實例）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, type ServerHandle, type ServerLLM } from './server.js';

const origProvider = process.env.LLM_PROVIDER;

before(() => {
  process.env.LLM_PROVIDER = 'mock';
});

after(() => {
  if (origProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = origProvider;
});

// Scripted mock dispatcher：即時確定性回應，不碰模型
function mockDispatcher(): ServerLLM {
  return {
    async start() { /* 立即可用 */ },
    async shutdown() { /* 無事可做 */ },
    async generate(prompt: string) {
      if (prompt.includes('【裁判任務】')) {
        const slots: number[] = [];
        for (const m of prompt.matchAll(/^(\d+)\.\s/gm)) slots.push(parseInt(m[1], 10));
        return slots.map((s) => `${s}: 5`).join('\n');
      }
      if (prompt.includes('【你的預發言草稿】')) return 'P0：「展開後的完整發言。」';
      const m = prompt.match(/你是 P(\d+)/);
      const id = m ? m[1] : '1';
      return `P${id}：「我比較在意大家的發言。」`;
    },
    async requestSpeech(_pid: number, prompt: string) {
      return { text: prompt.slice(0, 20) || '發言' };
    },
    async requestVote(playerId: number) {
      return { targetId: playerId };
    },
    async requestNightAction(playerId: number) {
      return { targetId: playerId };
    },
  };
}

async function boot(overrides: Parameters<typeof startServer>[0] = {}): Promise<ServerHandle> {
  return startServer({
    port: 0,
    playerCount: 6,
    openBrowser: false,
    exitProcess: false,
    dispatcherFactory: () => mockDispatcher(),
    ...overrides,
  });
}

function get(path: string, port: number): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
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
  } finally {
    await h.shutdown('test');
  }
});

test('WS 連線 → 收到 LOBBY（座位全 empty，無角色洩漏）', async () => {
  const h = await boot();
  try {
    const ws = new WebSocket(`ws://localhost:${h.port}`);
    const lobby = await new Promise<{ phase: string; seats: { controlledBy: string }[] }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等 LOBBY 逾時')), 5000);
      // 遊戲頁連線後先發遊戲訊息（觸發延遲啟動；模型管理頁只監聽不發訊，不會誤觸發）
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'REQUEST_SNAPSHOT' }));
      });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(String(data)) as { type: string; lobby?: { phase: string; seats: { controlledBy: string }[] } };
          if (msg.type === 'LOBBY' && msg.lobby) {
            clearTimeout(timer);
            resolve(msg.lobby);
          }
        } catch { /* ignore */ }
      });
      ws.on('error', reject);
    });
    assert.equal(lobby.phase, 'SETUP_WAITING_JOIN');
    assert.equal(lobby.seats.length, 6);
    assert.ok(lobby.seats.every((s) => s.controlledBy === 'empty'));
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});

test('SET_GM_VIEW → 收到含角色的 snapshot（先 JOIN + START_GAME 開局）', async () => {
  const h = await boot();
  try {
    const ws = new WebSocket(`ws://localhost:${h.port}`);
    const gmSnap = await new Promise<{ players: { role: string }[] }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等 GM SNAPSHOT 逾時')), 8000);
      let joined = false;
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'SET_GM_VIEW', enabled: true }));
      });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(String(data)) as {
            type: string; gmView?: boolean; snapshot?: { players?: { role: string }[] };
          };
          if (msg.type === 'PING') {
            ws.send(JSON.stringify({ type: 'PONG' }));
            return;
          }
          if (msg.type === 'LOBBY' && !joined) {
            joined = true;
            ws.send(JSON.stringify({ type: 'JOIN', playerId: 1, name: 'GM' }));
            return;
          }
          if (msg.type === 'JOINED') {
            ws.send(JSON.stringify({ type: 'START_GAME' }));
            return;
          }
          // 開局完成（收到遊戲快照）後再重送 GM 檢視：
          // START_GAME 為非同步（大廳先回），立即重送會打在引擎建立前
          if (msg.type === 'SNAPSHOT' && !msg.gmView && msg.snapshot) {
            ws.send(JSON.stringify({ type: 'SET_GM_VIEW', enabled: true }));
            return;
          }
          // 訊息有序：開局後 gmView 快照即為 GM 視角
          if (msg.type === 'SNAPSHOT' && msg.gmView === true && msg.snapshot?.players) {
            clearTimeout(timer);
            resolve(msg.snapshot as { players: { role: string }[] });
          }
        } catch { /* ignore */ }
      });
      ws.on('error', reject);
    });
    assert.ok(gmSnap.players.length > 0);
    assert.ok(gmSnap.players[0].role);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});

test('LEAVE（最後 client）→ shutdown（closed reason leave）', async () => {
  let reason = '';
  const h = await boot({ onShutdown: (r) => { reason = r; } });
  const ws = new WebSocket(`ws://localhost:${h.port}`);
  await new Promise<void>((resolve, reject) => {
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
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('等關閉逾時')), 5000)),
  ]);
  assert.equal(closedReason, 'leave');
  assert.equal(reason, 'leave');
});

test('斷線 → 0 client → 兜底 timer 觸發關閉', async () => {
  let reason = '';
  const h = await boot({ zeroClientShutdownMs: 80, onShutdown: (r) => { reason = r; } });
  const ws = new WebSocket(`ws://localhost:${h.port}`);
  await new Promise<void>((resolve, reject) => {
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
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('等兜底關閉逾時')), 5000)),
  ]);
  assert.equal(closedReason, 'no-clients');
  assert.equal(reason, 'no-clients');
});

test('ping 超時 → 連線被 terminate', async () => {
  const h = await boot({ pingIntervalMs: 30, pingTimeoutMs: 60 });
  try {
    const ws = new WebSocket(`ws://localhost:${h.port}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('連線逾時')), 5000);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on('error', reject);
    });
    // 故意不回 PONG → 應被 terminate
    const closed = await Promise.race([
      new Promise<boolean>((resolve) => {
        ws.on('close', () => resolve(true));
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    assert.equal(closed, true, 'ping 超時應斷開連線');
  } finally {
    await h.shutdown('test');
  }
});

test('llama-server 模式整合（fake binary + 假 gguf，不用 dispatcherFactory）', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // fake healthy binary（node 腳本；LlamaServerManager 以 process.execPath 執行 .mjs）
  const fakeDir = mkdtempSync(join(tmpdir(), 'srv-fake-'));
  const fakeBin = join(fakeDir, 'fake-llama.mjs');
  writeFileSync(
    fakeBin,
    `import http from 'node:http';
const args = process.argv.slice(2);
const pi = args.indexOf('--port');
const port = pi >= 0 ? Number(args[pi + 1]) : 3001;
const hi = args.indexOf('--host');
const host = hi >= 0 ? args[hi + 1] : '127.0.0.1';
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); }
  else { res.writeHead(404); res.end(); }
}).listen(port, host);
`,
  );
  // modelsDir 含假 .gguf（isModelDownloaded 任一 .gguf 即視為已下載，跳過下載）
  const modelsDir = mkdtempSync(join(tmpdir(), 'srv-models-'));
  writeFileSync(join(modelsDir, 'fake.gguf'), 'gguf');

  // sidecar 用獨立 free port（避免撞 web server port；撞上會等滿 healthTimeout）
  const { createServer } = await import('node:net');
  const probeSrv = createServer();
  await new Promise<void>((resolve) => probeSrv.listen(0, () => resolve()));
  const llamaPort = (probeSrv.address() as { port: number }).port;
  await new Promise<void>((resolve) => probeSrv.close(() => resolve()));

  const prev = process.env.LLM_PROVIDER;
  delete process.env.LLM_PROVIDER; // 預設即 llama-server 模式
  let h: ServerHandle | null = null;
  try {
    h = await startServer({
      port: 0,
      playerCount: 6,
      openBrowser: false,
      exitProcess: false,
      modelsDir,
      llamaServerBinPath: fakeBin,
      llamaServerPort: llamaPort,
      // 不提供 dispatcherFactory → 走 sidecar + OpenAICompatibleDispatcher
    });
    // 延遲建立：遊戲頁先發遊戲訊息才啟動 sidecar + 建 engine，再收到 LOBBY
    const ws = new WebSocket(`ws://localhost:${h.port}`);
    try {
      const lobby = await new Promise<{ phase: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等 LOBBY 逾時')), 8000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'REQUEST_SNAPSHOT' }));
        });
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(String(data)) as { type: string; lobby?: { phase: string } };
            if (msg.type === 'PING') {
              ws.send(JSON.stringify({ type: 'PONG' }));
              return;
            }
            if (msg.type === 'LOBBY' && msg.lobby) {
              clearTimeout(timer);
              resolve(msg.lobby);
            }
          } catch { /* ignore */ }
        });
        ws.on('error', reject);
      });
      assert.equal(lobby.phase, 'SETUP_WAITING_JOIN');
    } finally {
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    if (prev === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = prev;
    if (h) await h.shutdown('test');
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(modelsDir, { recursive: true, force: true });
  }
});

test('llama-server 模式：啟動過程收到 state starting 的 MODEL_STATUS', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const fakeDir = mkdtempSync(join(tmpdir(), 'srv-starting-'));
  const fakeBin = join(fakeDir, 'fake-llama.mjs');
  writeFileSync(
    fakeBin,
    `import http from 'node:http';
const args = process.argv.slice(2);
const pi = args.indexOf('--port');
const port = pi >= 0 ? Number(args[pi + 1]) : 3001;
const hi = args.indexOf('--host');
const host = hi >= 0 ? args[hi + 1] : '127.0.0.1';
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); }
  else { res.writeHead(404); res.end(); }
}).listen(port, host);
`,
  );
  const modelsDir = mkdtempSync(join(tmpdir(), 'srv-starting-models-'));
  writeFileSync(join(modelsDir, 'fake.gguf'), 'gguf');

  const { createServer } = await import('node:net');
  const probeSrv = createServer();
  await new Promise<void>((resolve) => probeSrv.listen(0, () => resolve()));
  const llamaPort = (probeSrv.address() as { port: number }).port;
  await new Promise<void>((resolve) => probeSrv.close(() => resolve()));

  const prev = process.env.LLM_PROVIDER;
  delete process.env.LLM_PROVIDER;
  let h: ServerHandle | null = null;
  try {
    h = await startServer({
      port: 0,
      playerCount: 6,
      openBrowser: false,
      exitProcess: false,
      modelsDir,
      llamaServerBinPath: fakeBin,
      llamaServerPort: llamaPort,
    });
    const ws = new WebSocket(`ws://localhost:${h.port}`);
    try {
      const states = await new Promise<string[]>((resolve, reject) => {
        const seen: string[] = [];
        const timer = setTimeout(() => reject(new Error('等 ready 逾時')), 15000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'REQUEST_SNAPSHOT' }));
        });
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(String(data)) as { type: string; state?: string; lobby?: unknown };
            if (msg.type === 'PING') {
              ws.send(JSON.stringify({ type: 'PONG' }));
              return;
            }
            if (msg.type === 'MODEL_STATUS' && msg.state) seen.push(msg.state);
            // lobby-first：LOBBY 即時送達，不再作為啟動完成的信號；改等 ready
            if (msg.type === 'MODEL_STATUS' && msg.state === 'ready' && seen.includes('starting')) {
              clearTimeout(timer);
              resolve(seen);
            }
          } catch { /* ignore */ }
        });
        ws.on('error', reject);
      });
      assert.ok(states.includes('starting'), `啟動過程應廣播 starting，實際收到：${JSON.stringify(states)}`);
      assert.ok(states.includes('ready'), `啟動完成應廣播 ready（完整生命週期），實際收到：${JSON.stringify(states)}`);
    } finally {
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    if (prev === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = prev;
    if (h) await h.shutdown('test');
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(modelsDir, { recursive: true, force: true });
  }
});

test('啟動 armed：完全不連線（主選單不開 WS）→ zeroTimer 觸發 no-clients 關閉', async () => {
  let reason = '';
  const h = await boot({ zeroClientShutdownMs: 50, onShutdown: (r) => { reason = r; } });
  const closedReason = await Promise.race([
    h.closed,
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('等啟動 armed 關閉逾時')), 5000)),
  ]);
  assert.equal(closedReason, 'no-clients');
  assert.equal(reason, 'no-clients');
});

test('zeroClientShutdownMs: 0 → 停用自動退出（含斷開路徑；150ms 內不關閉）', async () => {
  let shut = false;
  const h = await boot({ zeroClientShutdownMs: 0, onShutdown: () => { shut = true; } });
  try {
    // 斷開路徑：連線後立刻斷開，armed 應被逃生口擋下
    const ws = new WebSocket(`ws://localhost:${h.port}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('連線逾時')), 5000);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on('error', reject);
    });
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    // 啟動 armed 路徑：從頭 0 連線也不應觸發
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(shut, false);
  } finally {
    await h.shutdown('test');
  }
});

// ---------- 遊戲結束自動回大廳 ----------

interface ReturnMsg {
  type: string;
  lobby?: { started: boolean; seats: { playerId: number; name: string; controlledBy: string }[] };
  snapshot?: {
    phase?: string; gameOver?: boolean; day?: number;
    alivePlayers?: { id: number }[]; you?: { canAct: boolean };
  };
}

// 輪詢等待（訊息先緩衝，避免 LOBBY 在 waiter 掛上前遺失的競態）
async function waitForCond(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(what);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// 決策型 mock：預發言帶 decided flag 快速收斂；投票/夜間選最低存活（解析 prompt 公開知識）
function parseAliveIds(prompt: string): number[] {
  const m = prompt.match(/存活玩家：([^；。\n]+)/);
  if (!m) return [];
  return [...m[1].matchAll(/P(\d+)/g)].map((x) => parseInt(x[1], 10));
}

function lowestExcept(ids: number[], exclude: number): number {
  const sorted = ids.filter((id) => id !== exclude).sort((a, b) => a - b);
  return sorted[0] ?? exclude;
}

function decidingMockDispatcher(): ServerLLM {
  return {
    async start() { /* 立即可用 */ },
    async shutdown() { /* 無事可做 */ },
    async generate(prompt: string) {
      if (prompt.includes('【裁判任務】')) {
        const slots: number[] = [];
        for (const m of prompt.matchAll(/^(\d+)\.\s/gm)) slots.push(parseInt(m[1], 10));
        return slots.map((s, i) => `${s}: ${8 - (i % 8)}`).join('\n');
      }
      if (prompt.includes('【你的預發言草稿】')) return 'P0：「聽完發言，我會審慎投票。」';
      const m = prompt.match(/你是 P(\d+)/);
      const id = m ? parseInt(m[1], 10) : 1;
      const target = lowestExcept(parseAliveIds(prompt), id);
      return `P${id}：「我在意 P${target} 的發言。」\n[決定:投P${target}]`;
    },
    async requestSpeech(pid: number) {
      return { text: `P${pid}：「補充發言。」` };
    },
    async requestVote(playerId: number, prompt: string) {
      return { targetId: lowestExcept(parseAliveIds(prompt), playerId) };
    },
    async requestNightAction(playerId: number, prompt: string) {
      return { targetId: lowestExcept(parseAliveIds(prompt), playerId) };
    },
  };
}

test('遊戲結束 → 延遲後自動回大廳（座位保留、可再開一局）', async () => {
  const prevCd = process.env.SPEECH_CD_MS;
  process.env.SPEECH_CD_MS = '30'; // 真人局加速 scheduler 節奏（純 AI 局本就 CD=0）
  const h = await boot({ gameOverReturnMs: 100, dispatcherFactory: () => decidingMockDispatcher() });
  try {
    const ws = new WebSocket(`ws://localhost:${h.port}`);
    const seen: ReturnMsg[] = [];
    let joined = false;
    let speakDay = 0;
    const lowestAlive = (alive: { id: number }[] | undefined, self: number): number => {
      const sorted = (alive ?? []).map((p) => p.id).filter((id) => id !== self).sort((a, b) => a - b);
      return sorted[0] ?? self;
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'REQUEST_SNAPSHOT' })));
    ws.on('message', (data) => {
      let msg: ReturnMsg;
      try {
        msg = JSON.parse(String(data)) as ReturnMsg;
      } catch {
        return;
      }
      if (msg.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG' }));
        return;
      }
      seen.push(msg);
      // 真人入座開局（座位保留驗證需要 human 座位；純 AI 局大廳座位本就全 empty）
      if (msg.type === 'LOBBY' && !joined) {
        joined = true;
        ws.send(JSON.stringify({ type: 'JOIN', playerId: 1, name: 'H1' }));
        return;
      }
      if (msg.type === 'JOINED') {
        ws.send(JSON.stringify({ type: 'START_GAME' }));
        return;
      }
      // 駕駛真人座位：夜間/投票行動、討論發言＋準備（防掛機接管、避免 gate 卡 timeout）
      const snap = msg.type === 'SNAPSHOT' ? msg.snapshot : undefined;
      if (!snap?.you || !snap.alivePlayers?.some((p) => p.id === 1)) return;
      if (snap.phase === 'DAY_DISCUSSION_OPEN') {
        if (snap.day !== undefined && snap.day !== speakDay) {
          speakDay = snap.day;
          ws.send(JSON.stringify({ type: 'HUMAN_SPEAK', text: `P1：第${snap.day}天多聽發言。` }));
        }
        ws.send(JSON.stringify({ type: 'HUMAN_READY_VOTE' }));
      } else if (snap.you.canAct && (snap.phase === 'NIGHT_COLLECTING' || snap.phase === 'DAY_VOTING_COLLECTING')) {
        const kind = snap.phase === 'NIGHT_COLLECTING' ? 'HUMAN_NIGHT_ACTION' : 'HUMAN_VOTE';
        ws.send(JSON.stringify({ type: kind, targetId: lowestAlive(snap.alivePlayers, 1) }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('連線逾時')), 5000);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on('error', reject);
    });
    // 1 真人＋5 AI 跑到遊戲結束
    await waitForCond(
      () => seen.some((m) => m.type === 'SNAPSHOT' && m.snapshot?.phase === 'GAME_OVER_FINAL'),
      90000, '等遊戲結束逾時',
    );
    const overIdx = seen.findIndex((m) => m.type === 'SNAPSHOT' && m.snapshot?.phase === 'GAME_OVER_FINAL');
    // 延遲後自動回大廳：started=false、真人座位保留
    await waitForCond(
      () => seen.some((m, i) => i > overIdx && m.type === 'LOBBY'),
      5000, '等自動回大廳逾時',
    );
    const back = seen.find((m, i) => i > overIdx && m.type === 'LOBBY')!;
    assert.equal(back.lobby!.started, false);
    assert.equal(back.lobby!.seats.length, 6);
    const seat1 = back.lobby!.seats.find((s) => s.playerId === 1)!;
    assert.equal(seat1.controlledBy, 'human', '真人座位保留');
    assert.equal(seat1.name, 'H1');
    // 可再開一局：START_GAME → 回到夜晚（server 已重置，不再拒絕）
    const mark = seen.length;
    ws.send(JSON.stringify({ type: 'START_GAME' }));
    await waitForCond(
      () => seen.some((m, i) => i >= mark && m.type === 'SNAPSHOT' && m.snapshot?.phase === 'NIGHT_COLLECTING'),
      15000, '等再開局逾時',
    );
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    if (prevCd === undefined) delete process.env.SPEECH_CD_MS;
    else process.env.SPEECH_CD_MS = prevCd;
    await h.shutdown('test');
  }
});
