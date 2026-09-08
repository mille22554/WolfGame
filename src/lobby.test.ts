/**
 * lobby.test.ts — LobbyManager 單元測試（等候大廳純記憶體狀態）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager, MIN_PLAYERS, MAX_PLAYERS, CHAT_LIMIT } from './lobby.js';

test('建構：人數驗證 6-15，座位全空', () => {
  const l = new LobbyManager(9);
  assert.equal(l.playerCount, 9);
  const snap = l.snapshot();
  assert.equal(snap.seats.length, 9);
  assert.ok(snap.seats.every((s) => s.controlledBy === 'empty'));
  assert.equal(snap.randomCount, false);
  assert.equal(snap.started, false);
  assert.equal(snap.phase, 'SETUP_WAITING_JOIN');
  assert.deepEqual(snap.engineStatus, { state: 'idle' });
  assert.throws(() => new LobbyManager(5), /6-15/);
  assert.throws(() => new LobbyManager(16), /6-15/);
});

test('join/leave：佔座發 token，離座保留 token（limbo 可拿回）', () => {
  const l = new LobbyManager(6);
  const { token } = l.join(3, 'Alice');
  assert.ok(typeof token === 'string' && token.length > 0);
  assert.equal(l.snapshot().seats[2].controlledBy, 'human');
  assert.equal(l.snapshot().seats[2].name, 'Alice');
  assert.throws(() => l.join(3, 'Bob'), /已有人/);
  assert.throws(() => l.join(0), /座位/);
  assert.throws(() => l.join(7), /座位/);
  l.leave(3);
  assert.equal(l.snapshot().seats[2].controlledBy, 'empty');
  const back = l.reclaim(token);
  assert.deepEqual(back, { playerId: 3 });
  assert.equal(l.snapshot().seats[2].controlledBy, 'human');
  assert.equal(l.snapshot().seats[2].name, 'Alice');
});

test('reclaim：座位被佔後拿不回；未知 token 回 undefined', () => {
  const l = new LobbyManager(6);
  const { token } = l.join(2, 'A');
  l.leave(2);
  l.join(2, 'B'); // 別人佔走
  assert.equal(l.reclaim(token), undefined);
  assert.equal(l.reclaim('nope'), undefined);
});

test('斷線標記：保留座位＋不計入 hasHumanSeats；重連拿回', () => {
  const l = new LobbyManager(6);
  const { token } = l.join(1, 'H');
  assert.equal(l.hasHumanSeats(), true);
  l.markDisconnected(1);
  assert.equal(l.hasHumanSeats(), false);
  assert.equal(l.snapshot().seats[0].disconnected, true);
  assert.equal(l.lookupToken(token), 1);
  const back = l.reclaim(token);
  assert.deepEqual(back, { playerId: 1 });
  assert.equal(l.hasHumanSeats(), true);
});

test('setPlayerCount：擴增保留座位；縮減只砍 AI/empty 尾，真人不足拒絕', () => {
  const l = new LobbyManager(8);
  l.join(1, 'A');
  l.join(7, 'B');
  l.setPlayerCount(10);
  assert.equal(l.playerCount, 10);
  assert.equal(l.snapshot().seats.length, 10);
  assert.equal(l.snapshot().seats[0].name, 'A');
  assert.equal(l.snapshot().seats[6].name, 'B');
  // 縮到 6：尾部人類 B 被截（token 失效→自動觀戰），A 保留
  const r = l.setPlayerCount(6);
  assert.equal(l.playerCount, 6);
  assert.equal(l.snapshot().seats.length, 6);
  assert.equal(l.snapshot().seats[0].controlledBy, 'human');
  assert.equal(r.droppedTokens.length, 1);
  // 7 真人時縮到 6：低於真人數 → 拒絕
  const l2 = new LobbyManager(8);
  for (let id = 1; id <= 7; id++) l2.join(id, `P${id}`);
  assert.throws(() => l2.setPlayerCount(6), /真人座位數/);
  // 範圍外一律拒絕
  assert.throws(() => l.setPlayerCount(5), /6-15/);
  assert.throws(() => l.setPlayerCount(16), /6-15/);
});

test('setRandomCount＋resolveCount：關閉回格數；開啟在 [max(6,真人數), 格數] 內', () => {
  const l = new LobbyManager(10);
  assert.equal(l.resolveCount(), 10);
  l.setRandomCount(true);
  assert.equal(l.randomCount, true);
  for (let i = 0; i < 50; i++) {
    const n = l.resolveCount();
    assert.ok(n >= 6 && n <= 10, `隨機人數 ${n} 應在 6-10`);
  }
  l.join(1, 'A');
  l.join(2, 'B');
  l.join(3, 'C');
  for (let i = 0; i < 50; i++) {
    const n = l.resolveCount();
    assert.ok(n >= 3 && n <= 10, `3 真人時隨機 ${n} 不可低於 3`);
  }
  assert.equal(l.snapshot().randomCount, true);
});

test('resolveCount：真人坐高位（14/15）→ 下限為最大座位號，不被排除', () => {
  const l = new LobbyManager(15);
  l.setRandomCount(true);
  l.join(14, 'A');
  l.join(15, 'B');
  for (let i = 0; i < 30; i++) {
    assert.equal(l.resolveCount(), 15);
  }
});

test('fillAiSeats／fillDisconnectedAsAi／seatsForStart', () => {
  const l = new LobbyManager(6);
  l.join(1, 'A');
  l.join(2, 'B');
  l.markDisconnected(2);
  const dead = l.fillDisconnectedAsAi();
  assert.equal(dead.length, 1);
  l.fillAiSeats();
  const seats = l.seatsForStart();
  assert.equal(seats[0].controlledBy, 'human');
  assert.equal(seats[1].controlledBy, 'ai');
  assert.ok(seats.slice(2).every((s) => s.controlledBy === 'ai'));
});

test('觀戰者：自動命名觀眾N，去重，移除', () => {
  const l = new LobbyManager(6);
  const a = l.addSpectator('c1');
  const b = l.addSpectator('c2');
  assert.equal(a.name, '觀眾1');
  assert.equal(b.name, '觀眾2');
  assert.deepEqual(l.addSpectator('c1'), a);
  assert.equal(l.snapshot().spectators.length, 2);
  l.removeSpectator('c1');
  assert.equal(l.snapshot().spectators.length, 1);
});

test('聊天：上限 50 則、500 字、空訊息拒絕', () => {
  const l = new LobbyManager(6);
  assert.throws(() => l.addChat('A', '   '), /不可為空/);
  assert.throws(() => l.addChat('A', 'x'.repeat(501)), /過長/);
  for (let i = 0; i < 60; i++) l.addChat('A', `m${i}`); // 超過上限不報錯（只留近 50）
  const last = l.addChat('B', 'last');
  assert.equal(last.from, 'B');
  assert.equal(last.text, 'last');
  assert.ok(typeof last.ts === 'number');
});

test('host：設定與清除', () => {
  const l = new LobbyManager(6);
  assert.equal(l.hostClientId, undefined);
  l.setHost('h1');
  assert.equal(l.hostClientId, 'h1');
  assert.equal(l.clearHostIf('other'), false);
  assert.equal(l.clearHostIf('h1'), true);
  assert.equal(l.hostClientId, undefined);
  assert.equal(l.snapshot().hostClientId, undefined);
});

test('engineStatus：寫入即進 snapshot', () => {
  const l = new LobbyManager(6);
  l.setEngineStatus({ state: 'starting', stage: 'llama-server', info: '載入中' });
  assert.deepEqual(l.snapshot().engineStatus, { state: 'starting', stage: 'llama-server', info: '載入中' });
});
