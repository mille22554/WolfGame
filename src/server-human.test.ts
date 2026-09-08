/**
 * server-human.test.ts — Phase 2 WS 大廳/重連（真人加入 → 開始 → 斷線接管 → 重連拿回）
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

// 確定性 mock dispatcher：夜間/投票回非自指目標，避免 gate 行为干扰大廳測試
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
    async requestSpeech(pid: number) {
      return { text: `P${pid}：「補充發言。」` };
    },
    async requestVote(playerId: number) {
      return { targetId: playerId === 1 ? 2 : 1 };
    },
    async requestNightAction(playerId: number) {
      return { targetId: playerId === 1 ? 2 : 1 };
    },
  };
}

async function boot(overrides: Parameters<typeof startServer>[0] = {}): Promise<ServerHandle> {
  return startServer({
    port: 0,
    playerCount: 6,
    openBrowser: false,
    exitProcess: false,
    speechesPerDay: 1000,
    dispatcherFactory: () => mockDispatcher(),
    ...overrides,
  });
}

interface WSMsg {
  type: string;
  lobby?: { phase: string; expectedPlayerCount: number; started: boolean; seats: { playerId: number; name: string; controlledBy: string }[] };
  snapshot?: { phase: string; you?: { role: string }; players?: { id: number; controlledBy: string }[] };
  gmView?: boolean;
  playerId?: number;
  token?: string;
  reason?: string;
}

interface BufferedWS extends WebSocket {
  __buf?: WSMsg[];
  __waiters?: { pred: (m: WSMsg) => boolean; resolve: (m: WSMsg) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[];
}

function pump(bws: BufferedWS): void {
  const buf = bws.__buf ?? [];
  const waiters = bws.__waiters ?? [];
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    const idx = buf.findIndex((m) => {
      try { return w.pred(m); } catch { return false; }
    });
    if (idx >= 0) {
      const [found] = buf.splice(idx, 1);
      waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(found);
    }
  }
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`) as BufferedWS;
    // 建構當下立即緩衝訊息，避免 LOBBY 在 waitFor 掛上前遺失（競態）
    ws.__buf = [];
    ws.__waiters = [];
    ws.on('message', (data: unknown) => {
      let msg: WSMsg;
      try {
        msg = JSON.parse(String(data)) as WSMsg;
      } catch {
        return;
      }
      if (msg.type === 'PING') {
        try { ws.send(JSON.stringify({ type: 'PONG' })); } catch { /* ignore */ }
        return;
      }
      ws.__buf!.push(msg);
      pump(ws);
    });
    const timer = setTimeout(() => reject(new Error('連線逾時')), 5000);
    ws.on('open', () => {
      clearTimeout(timer);
      // 遊戲頁連線後先發遊戲訊息，觸發 server 延遲啟動 engine
      //（模型管理頁只監聽 MODEL_STATUS 不發訊，故不會誤觸發 sidecar）
      try {
        ws.send(JSON.stringify({ type: 'REQUEST_SNAPSHOT' }));
      } catch { /* ignore */ }
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

/** 等待符合條件的下一則訊息（自動回 PONG；含建構後緩衝） */
function waitFor(ws: WebSocket, pred: (m: WSMsg) => boolean, timeoutMs = 5000): Promise<WSMsg> {
  const bws = ws as BufferedWS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bws.__waiters = (bws.__waiters ?? []).filter((w) => w.resolve !== resolve);
      reject(new Error('等訊息逾時'));
    }, timeoutMs);
    (bws.__waiters ??= []).push({ pred, resolve, reject, timer });
    pump(bws);
  });
}

function send(ws: WebSocket, obj: unknown): void {
  ws.send(JSON.stringify(obj));
}

test('WS 連線 → 收到 LOBBY（seats 全 empty）', async () => {
  const h = await boot();
  try {
    const ws = await connect(h.port);
    const msg = await waitFor(ws, (m) => m.type === 'LOBBY');
    assert.equal(msg.lobby!.phase, 'SETUP_WAITING_JOIN');
    assert.equal(msg.lobby!.seats.length, 6);
    assert.ok(msg.lobby!.seats.every((s) => s.controlledBy === 'empty'));
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});

test('JOIN → JOINED → START_GAME → 收到含 you.role 的玩家 snapshot', async () => {
  const h = await boot();
  try {
    const ws = await connect(h.port);
    await waitFor(ws, (m) => m.type === 'LOBBY');
    send(ws, { type: 'JOIN', playerId: 3, name: 'T3' });
    const joined = await waitFor(ws, (m) => m.type === 'JOINED');
    assert.equal(joined.playerId, 3);
    assert.ok(joined.token);
    send(ws, { type: 'START_GAME' });
    const snap = await waitFor(ws, (m) => m.type === 'SNAPSHOT' && !!m.snapshot?.you, 8000);
    assert.ok(snap.snapshot!.you!.role);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});

test('兩 client 搶同一座位 → 第二個 JOIN_REJECTED', async () => {
  const h = await boot();
  try {
    const a = await connect(h.port);
    await waitFor(a, (m) => m.type === 'LOBBY');
    send(a, { type: 'JOIN', playerId: 2 });
    await waitFor(a, (m) => m.type === 'JOINED');
    const b = await connect(h.port);
    // b 可能先收到 LOBBY（含座位 2 human）
    send(b, { type: 'JOIN', playerId: 2 });
    const rej = await waitFor(b, (m) => m.type === 'JOIN_REJECTED');
    assert.ok(rej.reason);
    a.close();
    b.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});

test('斷線 → controlledBy ai → RECONNECT → JOINED 拿回身分', async () => {
  const h = await boot();
  try {
    // GM 觀察者
    const gm = await connect(h.port);
    await waitFor(gm, (m) => m.type === 'LOBBY');
    send(gm, { type: 'SET_GM_VIEW', enabled: true });
    // 真人 A
    const a = await connect(h.port);
    await waitFor(a, (m) => m.type === 'LOBBY');
    send(a, { type: 'JOIN', playerId: 3, name: 'TA' });
    const joined = await waitFor(a, (m) => m.type === 'JOINED');
    const token = joined.token!;
    send(a, { type: 'START_GAME' });
    await waitFor(a, (m) => m.type === 'SNAPSHOT' && !!m.snapshot?.you, 8000);
    // A 斷線 → GM 應看到 P3 變 ai
    a.close();
    const flipped = await waitFor(gm, (m) =>
      m.type === 'SNAPSHOT' && m.gmView === true
      && !!m.snapshot?.players?.some((p) => p.id === 3 && p.controlledBy === 'ai'), 8000);
    assert.ok(flipped.snapshot!.players!.some((p) => p.id === 3 && p.controlledBy === 'ai'));
    // 新連線 RECONNECT → JOINED
    const c = await connect(h.port);
    await waitFor(c, (m) => m.type === 'LOBBY' || m.type === 'SNAPSHOT');
    send(c, { type: 'RECONNECT', token });
    const back = await waitFor(c, (m) => m.type === 'JOINED');
    assert.equal(back.playerId, 3);
    // GM 應看到 P3 變回 human
    const restored = await waitFor(gm, (m) =>
      m.type === 'SNAPSHOT' && m.gmView === true
      && !!m.snapshot?.players?.some((p) => p.id === 3 && p.controlledBy === 'human'), 8000);
    assert.ok(restored.snapshot!.players!.some((p) => p.id === 3 && p.controlledBy === 'human'));
    gm.close();
    c.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});

test('未 JOIN 的 client → 觀戰 snapshot（無 you）', async () => {
  const h = await boot();
  try {
    const a = await connect(h.port);
    await waitFor(a, (m) => m.type === 'LOBBY');
    send(a, { type: 'JOIN', playerId: 1 });
    await waitFor(a, (m) => m.type === 'JOINED');
    send(a, { type: 'START_GAME' });
    await waitFor(a, (m) => m.type === 'SNAPSHOT' && !!m.snapshot?.you, 8000);
    const watcher = await connect(h.port);
    const snap = await waitFor(watcher, (m) => m.type === 'SNAPSHOT' && !m.gmView, 8000);
    assert.ok(!('you' in snap.snapshot!));
    a.close();
    watcher.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});

test('無真人 → LOBBY_TIMEOUT 後自動全 AI 開局', async () => {
  const h = await boot({ lobbyTimeoutMs: 150 });
  try {
    const ws = await connect(h.port);
    await waitFor(ws, (m) => m.type === 'LOBBY');
    // 不 JOIN → 等自動開局（觀戰 snapshot 非 SETUP）
    const snap = await waitFor(ws, (m) =>
      m.type === 'SNAPSHOT' && !!m.snapshot && !['SETUP_WAITING_JOIN', 'SETUP_READY'].includes(m.snapshot.phase), 8000);
    assert.ok(snap.snapshot!.phase);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});

test('遊戲開始後 JOIN → JOIN_REJECTED game started', async () => {
  const h = await boot();
  try {
    const a = await connect(h.port);
    await waitFor(a, (m) => m.type === 'LOBBY');
    send(a, { type: 'JOIN', playerId: 1 });
    await waitFor(a, (m) => m.type === 'JOINED');
    send(a, { type: 'START_GAME' });
    await waitFor(a, (m) => m.type === 'SNAPSHOT' && !!m.snapshot?.you, 8000);
    const b = await connect(h.port);
    await waitFor(b, (m) => m.type === 'SNAPSHOT');
    send(b, { type: 'JOIN', playerId: 2 });
    const rej = await waitFor(b, (m) => m.type === 'JOIN_REJECTED');
    assert.equal(rej.reason, 'game started');
    a.close();
    b.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});
