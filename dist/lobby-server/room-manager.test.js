/**
 * room-manager.test.ts — RoomManager 單元測試
 *
 * 使用假時鐘（now hook）使 rate limit 與 inactivity reclaim 可確定性測試。
 * 注意：Room.lastActivity 由 Room 內部以真實 Date.now() 設定，
 * 因此 reclaim 測試先將 lastActivity 對齊到假時鐘再 advance。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from './room-manager.js';
import { MAX_MEMBERS_PER_ROOM } from './types.js';
let fakeNow = 0;
const advance = (ms) => {
    fakeNow += ms;
};
function makeManager() {
    return new RoomManager({ inactivityTimeoutMs: 50, sweepIntervalMs: 10, now: () => fakeNow });
}
test('createRoom：4 位數字代碼（首位 1-9），建立者為房主且為參戰玩家', () => {
    const rm = makeManager();
    const r = rm.createRoom('A', 'c1', '10.0.0.1');
    assert.equal(r.ok, true);
    if (!r.ok)
        return;
    assert.match(r.code, /^[1-9]\d{3}$/);
    assert.equal(rm.getRoom(r.code), r.room);
    assert.equal(r.room.host?.clientId, 'c1');
    assert.equal(r.room.getMember('c1')?.isSpectator, false);
    assert.equal(r.room.playerCount, 1);
});
test('joinRoom：未滿房以參戰玩家身分加入', () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    const r = rm.joinRoom(c.code, 'B', 'c2', 'ip2');
    assert.equal(r.ok, true);
    if (!r.ok)
        return;
    assert.equal(r.code, c.code);
    assert.equal(r.isSpectator, false);
    const names = r.room.memberList().map((m) => m.nickname);
    assert.deepEqual(names, ['A', 'B']);
});
test('joinRoom：參戰席位滿 → ROOM_FULL', () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    const room = rm.getRoom(c.code);
    room.maxPlayers = 6;
    for (let i = 2; i <= 6; i++) {
        const r = rm.joinRoom(c.code, `P${i}`, `c${i}`, 'ipx');
        assert.ok(r.ok);
    }
    assert.equal(room.playerCount, 6);
    const r = rm.joinRoom(c.code, 'P7', 'c7', 'ipy');
    assert.deepEqual(r, { ok: false, error: 'ROOM_FULL' });
});
test('joinRoom：滿房但 asSpectator=true → 以觀戰身分加入', () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    const room = rm.getRoom(c.code);
    room.maxPlayers = 6;
    for (let i = 2; i <= 6; i++)
        rm.joinRoom(c.code, `P${i}`, `c${i}`, 'ipx');
    const r = rm.joinRoom(c.code, 'S1', 'c8', 'ipz', true);
    assert.equal(r.ok, true);
    if (!r.ok)
        return;
    assert.equal(r.isSpectator, true);
    assert.equal(room.playerCount, 6);
    assert.equal(room.totalMembers, 7);
});
test('joinRoom：遊戲已開始 → 一律以觀戰身分加入', () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    rm.getRoom(c.code).started = true;
    const r = rm.joinRoom(c.code, 'B', 'c2', 'ip2');
    assert.equal(r.ok, true);
    if (r.ok)
        assert.equal(r.isSpectator, true);
});
test('joinRoom：不存在的代碼 → NOT_FOUND', () => {
    const rm = makeManager();
    const r = rm.joinRoom('0000', 'X', 'c1', 'ip1');
    assert.deepEqual(r, { ok: false, error: 'NOT_FOUND' });
});
test(`joinRoom：總人數達上限 ${MAX_MEMBERS_PER_ROOM} → FULL_CAP`, () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    const room = rm.getRoom(c.code);
    for (let i = 2; i <= 15; i++)
        rm.joinRoom(c.code, `P${i}`, `c${i}`, 'ipx');
    for (let i = 1; i <= 5; i++)
        rm.joinRoom(c.code, `S${i}`, `s${i}`, 'ipx', true);
    assert.equal(room.totalMembers, MAX_MEMBERS_PER_ROOM);
    const r = rm.joinRoom(c.code, 'X', 'cx', 'ipx');
    assert.deepEqual(r, { ok: false, error: 'FULL_CAP' });
});
test('leaveRoom：最後一人離開 → 房間回收', () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    assert.equal(rm.roomCount(), 1);
    const r = rm.leaveRoom('c1');
    assert.equal(r.room, undefined);
    assert.equal(r.left?.nickname, 'A');
    assert.equal(r.wasHost, true);
    assert.equal(r.newHost, undefined);
    assert.equal(rm.getRoom(c.code), undefined);
    assert.equal(rm.roomCount(), 0);
});
test('leaveRoom：房主離開 → wasHost=true，次早加入者接任房主', () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    rm.joinRoom(c.code, 'B', 'c2', 'ip2');
    rm.joinRoom(c.code, 'C', 'c3', 'ip3');
    const r = rm.leaveRoom('c1');
    assert.equal(r.wasHost, true);
    assert.equal(r.left?.nickname, 'A');
    assert.equal(r.newHost?.nickname, 'B');
    assert.equal(r.room?.host?.nickname, 'B');
});
test('leaveRoom：非房主離開 → wasHost=false，房主不變', () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    rm.joinRoom(c.code, 'B', 'c2', 'ip2');
    const r = rm.leaveRoom('c2');
    assert.equal(r.wasHost, false);
    assert.equal(r.left?.nickname, 'B');
    assert.equal(r.newHost?.nickname, 'A');
});
test('kickPlayer：非房主 → NOT_HOST；房主 → 移除成功；不可踢自己', () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    rm.joinRoom(c.code, 'B', 'c2', 'ip2');
    assert.deepEqual(rm.kickPlayer('c2', 'A'), { ok: false, error: 'NOT_HOST' });
    assert.deepEqual(rm.kickPlayer('c1', 'A'), { ok: false, error: 'NOT_FOUND' }); // self-kick guard
    const good = rm.kickPlayer('c1', 'B');
    assert.equal(good.ok, true);
    if (good.ok) {
        assert.equal(good.kicked.nickname, 'B');
        assert.equal(good.room.getMember('c2'), undefined);
    }
    assert.deepEqual(rm.kickPlayer('c1', 'ghost'), { ok: false, error: 'NOT_FOUND' });
});
test('setSetting：非房主 → NOT_HOST；房主合法更新生效', () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    rm.joinRoom(c.code, 'B', 'c2', 'ip2');
    assert.deepEqual(rm.setSetting('c2', { maxPlayers: 6 }), { ok: false, error: 'NOT_HOST' });
    const ok = rm.setSetting('c1', { maxPlayers: 6, randomCount: true });
    assert.equal(ok.ok, true);
    if (ok.ok) {
        assert.equal(ok.room.maxPlayers, 6);
        assert.equal(ok.room.randomCount, true);
    }
});
test('setSetting：maxPlayers 超範圍或小於目前玩家數 → INVALID', () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    for (let i = 2; i <= 7; i++)
        rm.joinRoom(c.code, `P${i}`, `c${i}`, 'ipx');
    assert.deepEqual(rm.setSetting('c1', { maxPlayers: 5 }), { ok: false, error: 'INVALID' });
    assert.deepEqual(rm.setSetting('c1', { maxPlayers: 16 }), { ok: false, error: 'INVALID' });
    assert.deepEqual(rm.setSetting('c1', { maxPlayers: 6 }), { ok: false, error: 'INVALID' }); // 6 < 7 名玩家
});
test('setMode：觀戰→參戰（有空位）成功；席位滿 → NO_SLOT', () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    const room = rm.getRoom(c.code);
    room.maxPlayers = 6;
    for (let i = 2; i <= 6; i++)
        rm.joinRoom(c.code, `P${i}`, `c${i}`, 'ipx');
    rm.joinRoom(c.code, 'S1', 's1', 'ips', true);
    assert.deepEqual(rm.setMode('s1', 'play'), { ok: false, error: 'NO_SLOT' });
    rm.kickPlayer('c1', 'P6'); // 騰出一席
    const ok = rm.setMode('s1', 'play');
    assert.equal(ok.ok, true);
    if (ok.ok)
        assert.equal(ok.room.getMember('s1')?.isSpectator, false);
    const back = rm.setMode('s1', 'spectate');
    assert.equal(back.ok, true);
    if (back.ok)
        assert.equal(back.room.getMember('s1')?.isSpectator, true);
});
test('setMode：不在任何房間 → NOT_IN_ROOM', () => {
    const rm = makeManager();
    assert.deepEqual(rm.setMode('ghost', 'play'), { ok: false, error: 'NOT_IN_ROOM' });
});
test('startGame：房主 → started=true；randomCount=false 時 actualCount=maxPlayers', () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    const r = rm.startGame('c1', 10, false);
    assert.equal(r.ok, true);
    if (r.ok) {
        assert.equal(r.room.started, true);
        assert.equal(r.room.maxPlayers, 10);
        assert.equal(r.actualCount, 10);
    }
});
test('startGame：randomCount=true → actualCount ∈ [6, maxPlayers]', () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    const r = rm.startGame('c1', 12, true);
    assert.equal(r.ok, true);
    if (r.ok) {
        assert.ok(r.actualCount >= 6 && r.actualCount <= 12, `actualCount=${r.actualCount} 應在 [6,12]`);
    }
});
test('startGame：非房主 → NOT_HOST；maxPlayers 超範圍 → INVALID', () => {
    const rm = makeManager();
    const c = rm.createRoom('A', 'c1', 'ip1');
    assert.ok(c.ok);
    rm.joinRoom(c.code, 'B', 'c2', 'ip2');
    assert.deepEqual(rm.startGame('c2', 6, false), { ok: false, error: 'NOT_HOST' });
    assert.deepEqual(rm.startGame('c1', 20, false), { ok: false, error: 'INVALID' });
    assert.deepEqual(rm.startGame('c1', 5, false), { ok: false, error: 'INVALID' });
});
test('createRoom：同一 IP 一分钟内 10 次成功，第 11 次 → RATE_LIMITED', () => {
    const rm = makeManager();
    for (let i = 0; i < 10; i++) {
        const r = rm.createRoom(`U${i}`, `c${i}`, 'same-ip');
        assert.equal(r.ok, true, `第 ${i + 1} 次建立應成功`);
    }
    assert.deepEqual(rm.createRoom('U10', 'c10', 'same-ip'), { ok: false, error: 'RATE_LIMITED' });
    // 不同 IP 不受影響
    assert.equal(rm.createRoom('Other', 'c99', 'other-ip').ok, true);
});
test('reclaimSwept：超時房間被回收，近期有活動的保留', () => {
    const rm = makeManager(); // inactivityTimeoutMs = 50
    const c1 = rm.createRoom('A', 'c1', 'ip1');
    const c2 = rm.createRoom('B', 'c2', 'ip2');
    assert.ok(c1.ok && c2.ok);
    const r1 = rm.getRoom(c1.code);
    const r2 = rm.getRoom(c2.code);
    // 對齊假時鐘（Room 建構子用的是真實 Date.now()）
    r1.lastActivity = fakeNow; // t=0
    r2.lastActivity = fakeNow; // t=0
    advance(30);
    r2.lastActivity = fakeNow; // t=30：r2 有近期活動
    advance(30); // t=60
    const reclaimed = rm.reclaimSwept();
    assert.deepEqual(reclaimed, [c1.code]); // r1：60-0=60 > 50 → 回收
    assert.equal(rm.getRoom(c1.code), undefined);
    assert.equal(rm.getRoom(c2.code), r2); // r2：60-30=30 < 50 → 保留
    assert.equal(rm.roomCount(), 1);
});
//# sourceMappingURL=room-manager.test.js.map