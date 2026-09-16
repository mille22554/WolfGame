/**
 * server.test.ts — lobby-server WS 整合測試（真實 WebSocket 客戶端）
 *
 * 整個檔案共用一個 server（port 0 = ephemeral，startSweep=false）。
 * 每個 test 自建房間，互不干擾；file 結束時 after() 關 server。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import WebSocket from 'ws';
import { getResourceRoot } from '../utils.js';
import { createLobbyServer } from './server.js';
function connect(port) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}`);
        const queue = [];
        const waiters = [];
        const tryDispatch = () => {
            for (let i = 0; i < waiters.length; i++) {
                const w = waiters[i];
                const idx = queue.findIndex((m) => !w.type || m.type === w.type);
                if (idx !== -1) {
                    const [m] = queue.splice(idx, 1);
                    waiters.splice(i, 1);
                    i -= 1;
                    w.resolve(m);
                }
            }
        };
        ws.on('message', (data) => {
            try {
                queue.push(JSON.parse(String(data)));
            }
            catch {
                // 非 JSON 幀：忽略
            }
            tryDispatch();
        });
        ws.on('open', () => {
            resolve({
                ws,
                next: (type) => new Promise((res) => {
                    const idx = queue.findIndex((m) => !type || m.type === type);
                    if (idx !== -1) {
                        const [m] = queue.splice(idx, 1);
                        res(m);
                    }
                    else {
                        waiters.push({ type, resolve: res });
                    }
                }),
                close: () => {
                    try {
                        ws.close();
                    }
                    catch {
                        // 已關閉
                    }
                },
            });
        });
        ws.on('error', (err) => reject(err));
    });
}
const h = await createLobbyServer({
    port: 0,
    startSweep: false,
    publicDir: path.join(getResourceRoot(), 'ubuntu-web'),
});
after(async () => {
    await h.shutdown();
});
test('M1：建立房間＋加入（房主/成員視角）', async () => {
    const A = await connect(h.port);
    A.ws.send(JSON.stringify({ type: 'CREATE_ROOM', nickname: 'A' }));
    const joined = await A.next('ROOM_JOINED');
    assert.equal(joined.isHost, true);
    assert.match(joined.code, /^[1-9]\d{3}$/);
    assert.equal(joined.players.length, 1);
    const B = await connect(h.port);
    B.ws.send(JSON.stringify({ type: 'JOIN_ROOM', code: joined.code, nickname: 'B' }));
    const bJoined = await B.next('ROOM_JOINED');
    assert.equal(bJoined.isHost, false);
    const names = bJoined.players.map((p) => p.nickname);
    assert.ok(names.includes('A') && names.includes('B'), `players 應含 A 與 B：${JSON.stringify(names)}`);
    const aNotified = await A.next('PLAYER_JOINED');
    assert.equal(aNotified.nickname, 'B');
    A.close();
    B.close();
});
test('M2：聊天訊息廣播給全房（含發送者）', async () => {
    const A = await connect(h.port);
    A.ws.send(JSON.stringify({ type: 'CREATE_ROOM', nickname: 'A' }));
    const joined = await A.next('ROOM_JOINED');
    const B = await connect(h.port);
    B.ws.send(JSON.stringify({ type: 'JOIN_ROOM', code: joined.code, nickname: 'B' }));
    await B.next('ROOM_JOINED');
    await A.next('PLAYER_JOINED');
    A.ws.send(JSON.stringify({ type: 'SEND_MESSAGE', text: 'hello' }));
    const ma = await A.next('MESSAGE');
    assert.equal(ma.from, 'A');
    assert.equal(ma.text, 'hello');
    assert.equal(typeof ma.ts, 'number');
    const mb = await B.next('MESSAGE');
    assert.equal(mb.from, 'A');
    assert.equal(mb.text, 'hello');
    B.ws.send(JSON.stringify({ type: 'SEND_MESSAGE', text: 'hi' }));
    const ma2 = await A.next('MESSAGE');
    assert.equal(ma2.from, 'B');
    assert.equal(ma2.text, 'hi');
    await B.next('MESSAGE'); // 排空 B 的訊息
    A.close();
    B.close();
});
test('M2：房主踢人 → 被踢者收 KICKED，房主收 PLAYER_LEFT', async () => {
    const A = await connect(h.port);
    A.ws.send(JSON.stringify({ type: 'CREATE_ROOM', nickname: 'A' }));
    const joined = await A.next('ROOM_JOINED');
    const B = await connect(h.port);
    B.ws.send(JSON.stringify({ type: 'JOIN_ROOM', code: joined.code, nickname: 'B' }));
    await B.next('ROOM_JOINED');
    await A.next('PLAYER_JOINED');
    A.ws.send(JSON.stringify({ type: 'KICK_PLAYER', target: 'B' }));
    const kicked = await B.next('KICKED');
    assert.equal(kicked.reason, '被房主移出房間');
    const left = await A.next('PLAYER_LEFT');
    assert.equal(left.nickname, 'B');
    A.close();
    B.close();
});
test('M3：房主斷線 → 房主移轉給次早加入者', async () => {
    const A = await connect(h.port);
    A.ws.send(JSON.stringify({ type: 'CREATE_ROOM', nickname: 'A' }));
    const joined = await A.next('ROOM_JOINED');
    const B = await connect(h.port);
    B.ws.send(JSON.stringify({ type: 'JOIN_ROOM', code: joined.code, nickname: 'B' }));
    await B.next('ROOM_JOINED');
    await A.next('PLAYER_JOINED');
    A.ws.close();
    const changed = await B.next('HOST_CHANGED');
    assert.equal(changed.newHost, 'B');
    B.close();
});
test('M3：已開始的房間 → 新加入者以觀戰身分進入', async () => {
    const A = await connect(h.port);
    A.ws.send(JSON.stringify({ type: 'CREATE_ROOM', nickname: 'A' }));
    const joined = await A.next('ROOM_JOINED');
    A.ws.send(JSON.stringify({ type: 'START_GAME', maxPlayers: 6, randomCount: false }));
    const started = await A.next('GAME_STARTED');
    assert.equal(started.started, true);
    assert.equal(started.actualCount, 6);
    const B = await connect(h.port);
    B.ws.send(JSON.stringify({ type: 'JOIN_ROOM', code: joined.code, nickname: 'B' }));
    const bJoined = await B.next('SPECTATOR_JOINED');
    assert.equal(bJoined.started, true);
    A.close();
    B.close();
});
test('M3：全人離開 → 房間回收，舊代碼無法再加入', async () => {
    const A = await connect(h.port);
    A.ws.send(JSON.stringify({ type: 'CREATE_ROOM', nickname: 'A' }));
    const joined = await A.next('ROOM_JOINED');
    const B = await connect(h.port);
    B.ws.send(JSON.stringify({ type: 'JOIN_ROOM', code: joined.code, nickname: 'B' }));
    await B.next('ROOM_JOINED');
    await A.next('PLAYER_JOINED');
    A.ws.close();
    await B.next('PLAYER_LEFT'); // A 離開通知
    B.ws.close();
    // 房間已空、無人可接收通知 → 直接輪詢 server 端狀態等回收完成
    for (let i = 0; i < 200 && h.roomManager.getRoom(joined.code); i++) {
        await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(h.roomManager.getRoom(joined.code), undefined, '房間應已被回收');
    const C = await connect(h.port);
    C.ws.send(JSON.stringify({ type: 'JOIN_ROOM', code: joined.code, nickname: 'C' }));
    const err = await C.next('ERROR');
    assert.equal(err.message, '房間不存在');
    C.close();
});
test('靜態服務：/index.html 回 200 且含標題', async () => {
    const res = await fetch(`${h.url}/index.html`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('狼人殺') || body.includes('Werewolf'), 'index.html 應含 狼人殺/Werewolf');
});
//# sourceMappingURL=server.test.js.map