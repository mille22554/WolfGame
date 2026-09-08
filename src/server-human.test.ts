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
  lobby?: { phase: string; expectedPlayerCount: number; started: boolean; seats: { playerId: number; name: string; controlledBy: string }[]; playerCount?: number; randomCount?: boolean; engineStatus?: { state: string }; spectators?: { clientId: string; name: string }[] };
  snapshot?: { phase: string; you?: { role: string }; players?: { id: number; controlledBy: string }[] };
  gmView?: boolean;
  playerId?: number;
  token?: string;
  reason?: string;
  from?: string;
  text?: string;
  ts?: number;
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
    // host 規則：首連線（gm 觀察者）才是 host，由 host 按開始
    send(gm, { type: 'START_GAME' });
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

test('純 AI 局：無人入座，host 按開始遊戲 → 全 AI 開局（無自動開局）', async () => {
  const h = await boot();
  try {
    const ws = await connect(h.port); // 首連線＝host；connect 自動送 REQUEST_SNAPSHOT
    await waitFor(ws, (m) => m.type === 'LOBBY');
    await new Promise((r) => setTimeout(r, 400)); // 不按開始 → 不開局
    const buf = (ws as BufferedWS).__buf ?? [];
    assert.ok(!buf.some((m) => m.type === 'SNAPSHOT'), '未按開始前不該收到 SNAPSHOT');
    send(ws, { type: 'START_GAME' });
    const snap = await waitFor(ws, (m) =>
      m.type === 'SNAPSHOT' && !!m.snapshot && !['SETUP_WAITING_JOIN', 'SETUP_READY'].includes(m.snapshot.phase), 8000);
    assert.ok(snap.snapshot!.phase);
    assert.ok(!('you' in snap.snapshot!)); // 純 AI：觀戰視角無 you
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

test('SPECTATE 往返：離座→空位＋觀戰者，再 JOIN 回來', async () => {
  const h = await boot();
  try {
    const ws = await connect(h.port);
    await waitFor(ws, (m) => m.type === 'LOBBY');
    send(ws, { type: 'JOIN', playerId: 1, name: 'S1' });
    await waitFor(ws, (m) => m.type === 'JOINED');
    send(ws, { type: 'SPECTATE' });
    const lobby = await waitFor(ws, (m) =>
      m.type === 'LOBBY' && m.lobby!.seats[0].controlledBy === 'empty');
    assert.equal(lobby.lobby!.seats[0].controlledBy, 'empty');
    send(ws, { type: 'JOIN', playerId: 1, name: 'S1' });
    const back = await waitFor(ws, (m) => m.type === 'JOINED');
    assert.equal(back.playerId, 1);
    assert.ok(back.token);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});

test('host 權限：非 host 改人數 → ACTION_REJECTED only host；host 改 → LOBBY 更新', async () => {
  const h = await boot();
  try {
    const a = await connect(h.port); // 首連線＝host
    await waitFor(a, (m) => m.type === 'LOBBY');
    const b = await connect(h.port);
    await waitFor(b, (m) => m.type === 'LOBBY');
    send(b, { type: 'SET_PLAYER_COUNT', count: 8 });
    const rej = await waitFor(b, (m) => m.type === 'ACTION_REJECTED');
    assert.equal(rej.reason, 'only host');
    send(a, { type: 'SET_PLAYER_COUNT', count: 8 });
    const lobby = await waitFor(a, (m) => m.type === 'LOBBY' && m.lobby!.playerCount === 8);
    assert.equal(lobby.lobby!.seats.length, 8);
    send(a, { type: 'SET_PLAYER_COUNT', count: 5 });
    const rej2 = await waitFor(a, (m) => m.type === 'ACTION_REJECTED');
    assert.ok(rej2.reason);
    a.close();
    b.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});

test('隨機旗標＋LOBBY 含 engineStatus（mock 為 idle）', async () => {
  const h = await boot();
  try {
    const ws = await connect(h.port);
    const first = await waitFor(ws, (m) => m.type === 'LOBBY');
    assert.equal(first.lobby!.engineStatus!.state, 'idle');
    send(ws, { type: 'SET_RANDOM_COUNT', enabled: true });
    const lobby = await waitFor(ws, (m) => m.type === 'LOBBY' && m.lobby!.randomCount === true);
    assert.equal(lobby.lobby!.randomCount, true);
    send(ws, { type: 'JOIN', playerId: 1, name: 'R1' });
    await waitFor(ws, (m) => m.type === 'JOINED');
    send(ws, { type: 'START_GAME' });
    const snap = await waitFor(ws, (m) => m.type === 'SNAPSHOT' && !!m.snapshot?.you, 8000);
    assert.ok(snap.snapshot!.you!.role);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});

test('大廳內斷線 → 同 token 重連拿回座位', async () => {
  const h = await boot();
  try {
    const a = await connect(h.port);
    await waitFor(a, (m) => m.type === 'LOBBY');
    send(a, { type: 'JOIN', playerId: 2, name: 'RC' });
    const joined = await waitFor(a, (m) => m.type === 'JOINED');
    const token = joined.token!;
    a.close(); // 未開局斷線 → 座位保留
    await new Promise((r) => setTimeout(r, 100));
    const c = await connect(h.port);
    await waitFor(c, (m) => m.type === 'LOBBY');
    send(c, { type: 'RECONNECT', token });
    const back = await waitFor(c, (m) => m.type === 'JOINED');
    assert.equal(back.playerId, 2);
    c.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});

test('大廳聊天：CHAT_SEND → 雙方收到 CHAT_MESSAGE', async () => {
  const h = await boot();
  try {
    const a = await connect(h.port);
    await waitFor(a, (m) => m.type === 'LOBBY');
    send(a, { type: 'JOIN', playerId: 1, name: 'CA' });
    await waitFor(a, (m) => m.type === 'JOINED');
    const b = await connect(h.port);
    await waitFor(b, (m) => m.type === 'LOBBY');
    send(b, { type: 'CHAT_SEND', text: 'hi' });
    const gotA = await waitFor(a, (m) => m.type === 'CHAT_MESSAGE' && m.text === 'hi');
    assert.ok(gotA.from);
    assert.ok(typeof gotA.ts === 'number');
    send(a, { type: 'CHAT_SEND', text: 'yo' });
    const gotB = await waitFor(b, (m) => m.type === 'CHAT_MESSAGE' && m.text === 'yo');
    assert.equal(gotB.from, 'CA');
    a.close();
    b.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});

test('開局時斷線未歸 → 座位轉 AI（不斷真人 gate）', async () => {
  const h = await boot();
  try {
    const a = await connect(h.port);
    await waitFor(a, (m) => m.type === 'LOBBY');
    send(a, { type: 'JOIN', playerId: 1, name: 'DA' });
    await waitFor(a, (m) => m.type === 'JOINED');
    a.close(); // 未開局斷線 → 座位保留＋AI 託管
    await new Promise((r) => setTimeout(r, 100));
    const b = await connect(h.port); // 後進＝host（a 已離開）
    await waitFor(b, (m) => m.type === 'LOBBY');
    send(b, { type: 'START_GAME' });
    // b 未入座 → 開局後拿觀戰 snapshot
    await waitFor(b, (m) => m.type === 'SNAPSHOT' && !!m.snapshot && !['SETUP_WAITING_JOIN', 'SETUP_READY'].includes(m.snapshot.phase), 8000);
    send(b, { type: 'SET_GM_VIEW', enabled: true });
    const gm = await waitFor(b, (m) =>
      m.type === 'SNAPSHOT' && m.gmView === true
      && !!m.snapshot?.players?.some((p) => p.id === 1 && p.controlledBy === 'ai'), 8000);
    assert.ok(gm.snapshot!.players!.some((p) => p.id === 1 && p.controlledBy === 'ai'));
    b.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});

test('timer/host 只認遊戲頁訊號：純 WS 連線無 host、無開局', async () => {
  const h = await boot();
  try {
    // 原始連線：不發任何遊戲訊息（模擬模型管理頁只監聽）
    // 建構當下立即掛訊息監聽，避免連線 LOBBY 在 open 前遺失
    const raw = new WebSocket(`ws://localhost:${h.port}`);
    const seen: WSMsg[] = [];
    raw.on('message', (data: unknown) => {
      try {
        const msg = JSON.parse(String(data)) as WSMsg;
        if (msg.type === 'PING') {
          try { raw.send(JSON.stringify({ type: 'PONG' })); } catch { /* ignore */ }
          return;
        }
        seen.push(msg);
      } catch { /* ignore */ }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('連線逾時')), 5000);
      raw.on('open', () => { clearTimeout(timer); resolve(); });
      raw.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(seen.length > 0, '應收到連線 LOBBY');
    assert.ok(seen.every((m) => m.type === 'LOBBY'), '純連線不應觸發開局（只該有 LOBBY）');
    // 首個遊戲訊號決定 host（raw）→ host 按開始 → 全 AI 開局（無自動開局）
    raw.send(JSON.stringify({ type: 'START_GAME' }));
    const snap = await new Promise<WSMsg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等開局逾時')), 8000);
      const onMsg = (data: unknown): void => {
        try {
          const msg = JSON.parse(String(data)) as WSMsg;
          if (msg.type === 'SNAPSHOT' && !!msg.snapshot && !['SETUP_WAITING_JOIN', 'SETUP_READY'].includes(msg.snapshot.phase)) {
            clearTimeout(timer);
            raw.off('message', onMsg);
            resolve(msg);
          }
        } catch { /* ignore */ }
      };
      raw.on('message', onMsg);
    });
    assert.ok(snap.snapshot!.phase);
    raw.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.shutdown('test');
  }
});
