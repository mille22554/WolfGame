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

test('leaveLobbySeat：乾淨離開釋放座位＋清 limbo（同 token 重連拿不回）', () => {
  const l = new LobbyManager(6);
  const { token } = l.join(2, 'A');
  l.leaveLobbySeat(2, token);
  assert.equal(l.snapshot().seats[1].controlledBy, 'empty');
  assert.equal(l.reclaim(token), undefined);
  // 對比：一般 leave() 保留 limbo，可拿回
  const l2 = new LobbyManager(6);
  const r2 = l2.join(2, 'B');
  l2.leave(2);
  assert.deepEqual(l2.reclaim(r2.token), { playerId: 2 });
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
    assert.ok(n >= 6 && n <= 10, `3 真人時隨機 ${n} 不可低於 6`);
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

test('回歸：隨機開啟時下拉值僅為上限（不固定人數決議），改上限後區間跟著走', () => {
  const l = new LobbyManager(15);
  l.setRandomCount(true);
  // 上限 15：每次決議落在 [6, 15]，不恆等於下拉值（上限語義，後端不變）
  for (let i = 0; i < 30; i++) {
    const n = l.resolveCount();
    assert.ok(n >= MIN_PLAYERS && n <= 15, `隨機人數 ${n} 應在 6-15`);
  }
  // 縮小下拉（上限）→ 決議區間跟著收斂到 [6, 8]，仍不固定等於 8
  l.setPlayerCount(8);
  assert.equal(l.playerCount, 8);
  for (let i = 0; i < 30; i++) {
    const n = l.resolveCount();
    assert.ok(n >= MIN_PLAYERS && n <= 8, `上限改 8 後隨機 ${n} 應在 6-8`);
  }
  // 關閉隨機 → 回到下拉定值（開局邏輯不變）
  l.setRandomCount(false);
  assert.equal(l.resolveCount(), 8);
});

test('回歸：快照同步隨機旗標＋人數（開關一致，所有人看到一致）', () => {
  const l = new LobbyManager(9);
  assert.equal(l.snapshot().randomCount, false);
  assert.equal(l.snapshot().playerCount, 9);
  l.setRandomCount(true);
  let snap = l.snapshot();
  assert.equal(snap.randomCount, true);
  assert.equal(snap.playerCount, 9); // 隨機開啟不動格數，下拉值保留為上限
  l.setPlayerCount(12);
  snap = l.snapshot();
  assert.equal(snap.randomCount, true);
  assert.equal(snap.playerCount, 12);
  l.setRandomCount(false);
  snap = l.snapshot();
  assert.equal(snap.randomCount, false);
  assert.equal(snap.playerCount, 12);
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

test('觀眾編號 token 綁定：參戰→離席回原編號，不遞增', () => {
  const l = new LobbyManager(6);
  const a = l.addSpectator('c1');
  assert.equal(a.name, '觀眾1');
  const { token } = l.join(1, 'A');
  l.adoptSpectatorIdentity('c1', undefined, token);
  l.removeSpectator('c1');
  l.leave(1);
  const back = l.addSpectator('c1', token);
  assert.equal(back.name, '觀眾1'); //  regression：曾是觀眾2（specSeq 重加遞增）
});

test('具名觀眾參戰→離席：沿用同一編號＋原名', () => {
  const l = new LobbyManager(6);
  const named = l.setName('c1', { name: '小明' });
  assert.equal(named.name, '小明');
  const first = l.snapshot().spectators.find((s) => s.clientId === 'c1')!;
  assert.equal(first.name, '小明');
  const { token: seatToken } = l.join(2, '小明', 'c1');
  l.adoptSpectatorIdentity('c1', named.token, seatToken);
  l.removeSpectator('c1');
  assert.equal(l.snapshot().spectators.length, 0);
  l.leave(2);
  const back = l.addSpectator('c1', seatToken);
  assert.equal(back.name, '小明');
  // 再進一位無名觀眾應為觀眾2（編號未被重複消耗）
  const other = l.addSpectator('c2');
  assert.equal(other.name, '觀眾2');
});

test('restoreSpectator：同 token 重連拿回原編號＋原名；未知 token 回 undefined', () => {
  const l = new LobbyManager(6);
  const named = l.setName('c1', { name: '阿水' });
  l.removeSpectator('c1'); // 模擬斷線下架（編號＋具名保留）
  const sp = l.restoreSpectator('c2', named.token);
  assert.ok(sp);
  assert.equal(sp!.name, '阿水');
  assert.equal(l.snapshot().spectators.length, 1);
  assert.equal(l.restoreSpectator('c3', 'unknown-token'), undefined);
});

test('SET_NAME：空名拒收、超過 12 字截斷', () => {
  const l = new LobbyManager(6);
  assert.throws(() => l.setName('c1', { name: '   ' }), /不可為空/);
  const r = l.setName('c1', { name: '123456789012345' });
  assert.equal(r.name, '123456789012');
  assert.ok(r.token.length > 0);
  assert.equal(l.snapshot().spectators.find((s) => s.clientId === 'c1')!.name, '123456789012');
});

test('SET_NAME：與他人重名拒收（座位／觀眾），自己沿用舊名放行', () => {
  const l = new LobbyManager(6);
  l.join(1, '老大');
  l.setName('c9', { name: '小明' });
  assert.throws(() => l.setName('c8', { name: '老大' }), /已被使用/);
  assert.throws(() => l.setName('c8', { name: '小明' }), /已被使用/);
  assert.throws(() => l.setName('c8', { playerId: 2, name: '老大' }), /已被使用/);
  assert.throws(() => l.setName('c8', { playerId: 2, name: '全新名' }), /尚未參戰/);
  // 自己重送同名放行
  assert.equal(l.setName('c9', { name: '小明' }).name, '小明');
});

test('JOIN：與他人重名拒收（座位／觀眾，含空白變體）', () => {
  const l = new LobbyManager(6);
  l.join(1, '老大', 'c-host');
  l.setName('c9', { name: '小明' });
  // 與座位重名 → 拒收（既有錯誤通道：throw → JOIN_REJECTED）
  assert.throws(() => l.join(2, '老大', 'c8'), /已被使用/);
  // 與觀眾重名 → 拒收（改名列打了重名、直接按參戰的場景）
  assert.throws(() => l.join(2, '小明', 'c8'), /已被使用/);
  // 前後空白視為同名 → 拒收
  assert.throws(() => l.join(2, '  老大  ', 'c8'), /已被使用/);
  // 座位仍為空，未被髒寫
  assert.equal(l.snapshot().seats[1].controlledBy, 'empty');
});

test('JOIN：自己沿用舊名放行', () => {
  const l = new LobbyManager(6);
  const named = l.setName('c9', { name: '小明' });
  const { token } = l.join(2, '小明', 'c9');
  assert.ok(token.length > 0);
  assert.equal(l.snapshot().seats[1].name, '小明');
  l.adoptSpectatorIdentity('c9', named.token, token);
  l.removeSpectator('c9');
  assert.equal(l.snapshot().seats[1].controlledBy, 'human');
});

test('SET_NAME 改名即時更新名單（座位＋觀眾）', () => {
  const l = new LobbyManager(6);
  const { token } = l.join(1, '老大');
  l.setName('c-seat', { playerId: 1, token, name: '新老大' });
  assert.equal(l.snapshot().seats[0].name, '新老大');
  l.setName('c1', { name: '小明' });
  l.setName('c1', { name: '大明' });
  assert.equal(l.snapshot().spectators.find((s) => s.clientId === 'c1')!.name, '大明');
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
