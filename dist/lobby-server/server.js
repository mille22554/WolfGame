/**
 * server.ts — 多房大廳 WebSocket server（ubuntu 分支）
 *
 * HTTP 靜態（ubuntu-web/）+ WebSocket（ws）+ RoomManager：
 * - 每 WS 連線一個 clientId（UUID），registry 記錄 ws/ip/roomCode
 * - 房間代碼 4 位數字；建立/加入/聊天/設定/模式/開始/踢人
 * - 斷線：移除成員、空房回收、房主移轉廣播
 * - shutdown：關所有 client socket → wss.close() → httpServer.close()
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { getResourceRoot } from '../utils.js';
import { RoomManager } from './room-manager.js';
import { GameEngine } from './game.js';
const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
};
/** 靜態檔案服務（含路徑穿越防護；目錄 → 其 index.html）。 */
function serveStatic(req, res, publicDir) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let p = decodeURIComponent(url.pathname);
    if (p === '/')
        p = '/index.html';
    const filePath = path.normalize(path.join(publicDir, p));
    if (!filePath.startsWith(publicDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    let target = filePath;
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        target = path.join(target, 'index.html');
    }
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        const buf = fs.readFileSync(target);
        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(buf);
    }
    else {
        res.writeHead(404);
        res.end('Not Found');
    }
}
export async function createLobbyServer(opts = {}) {
    const port = opts.port ?? 0;
    const host = opts.host ?? '0.0.0.0';
    const publicDir = opts.publicDir ?? path.join(getResourceRoot(), 'ubuntu-web');
    const roomManager = new RoomManager({
        inactivityTimeoutMs: opts.inactivityTimeoutMs,
        sweepIntervalMs: opts.sweepIntervalMs,
    });
    if (opts.startSweep !== false)
        roomManager.startSweep();
    const httpServer = http.createServer((req, res) => serveStatic(req, res, publicDir));
    const wss = new WebSocketServer({ server: httpServer });
    const clients = new Map();
    const send = (ws, msg) => {
        if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify(msg));
    };
    const broadcastToRoom = (code, msg, exceptClientId) => {
        const room = roomManager.getRoom(code);
        if (!room)
            return;
        for (const c of clients.values()) {
            if (c.roomCode === code && c.clientId !== exceptClientId && c.ws.readyState === WebSocket.OPEN) {
                c.ws.send(JSON.stringify(msg));
            }
        }
    };
    const clientIp = (req) => {
        const xff = req.headers['x-forwarded-for'];
        return (typeof xff === 'string' && xff ? xff.split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
    };
    const onMessage = (clientId, ws, data) => {
        let msg;
        try {
            msg = JSON.parse(String(data));
        }
        catch {
            return; // 非 JSON 幀：忽略
        }
        const rec = clients.get(clientId);
        if (!rec)
            return; // 已斷線/已移除的 client
        switch (msg.type) {
            case 'CREATE_ROOM': {
                const r = roomManager.createRoom(msg.nickname, clientId, rec.ip);
                if (r.ok) {
                    rec.roomCode = r.code;
                    send(ws, {
                        type: 'ROOM_JOINED', code: r.code, isHost: true, players: r.room.memberList(),
                        started: r.room.started, maxPlayers: r.room.maxPlayers, randomCount: r.room.randomCount,
                    });
                }
                else {
                    send(ws, { type: 'ERROR', message: '請求過於頻繁，請稍後再試' });
                }
                break;
            }
            case 'JOIN_ROOM': {
                const r = roomManager.joinRoom(msg.code, msg.nickname, clientId, rec.ip, msg.asSpectator);
                if (r.ok) {
                    rec.roomCode = r.code;
                    const isHost = r.room.host?.clientId === clientId;
                    const payload = {
                        code: r.code, isHost, players: r.room.memberList(),
                        started: r.room.started, maxPlayers: r.room.maxPlayers, randomCount: r.room.randomCount,
                    };
                    if (r.isSpectator)
                        send(ws, { type: 'SPECTATOR_JOINED', ...payload });
                    else
                        send(ws, { type: 'ROOM_JOINED', ...payload });
                    broadcastToRoom(r.code, { type: 'PLAYER_JOINED', nickname: msg.nickname }, clientId);
                }
                else if (r.error === 'ROOM_FULL') {
                    send(ws, { type: 'ROOM_FULL' });
                }
                else if (r.error === 'NOT_FOUND') {
                    send(ws, { type: 'ERROR', message: '房間不存在' });
                }
                else if (r.error === 'FULL_CAP') {
                    send(ws, { type: 'ERROR', message: '房間人數已滿' });
                }
                else if (r.error === 'RATE_LIMITED') {
                    send(ws, { type: 'ERROR', message: '請求過於頻繁，請稍後再試' });
                }
                break;
            }
            case 'SEND_MESSAGE': {
                const r = roomManager.sendMessage(clientId, msg.text);
                if (r.ok) {
                    broadcastToRoom(r.room.code, { type: 'MESSAGE', from: r.entry.from, text: r.entry.text, ts: r.entry.ts });
                }
                else if (r.error === 'TOO_LONG') {
                    send(ws, { type: 'ERROR', message: '訊息過長' });
                }
                // EMPTY → 靜默忽略
                break;
            }
            case 'SET_SETTING': {
                const r = roomManager.setSetting(clientId, { maxPlayers: msg.maxPlayers, randomCount: msg.randomCount });
                if (r.ok) {
                    broadcastToRoom(r.room.code, { type: 'SETTING_CHANGED', maxPlayers: r.room.maxPlayers, randomCount: r.room.randomCount });
                }
                else {
                    send(ws, { type: 'ERROR', message: '只有房主可以調整設定' });
                }
                break;
            }
            case 'SET_MODE': {
                const r = roomManager.setMode(clientId, msg.mode);
                if (r.ok) {
                    broadcastToRoom(r.room.code, { type: 'MEMBERS_CHANGED', players: r.room.memberList() });
                }
                else if (r.error === 'NO_SLOT') {
                    send(ws, { type: 'ERROR', message: '沒有空位可以參戰' });
                }
                break;
            }
            case 'START_GAME': {
                const r = roomManager.startGame(clientId, msg.maxPlayers, msg.randomCount);
                if (r.ok) {
                    broadcastToRoom(r.room.code, { type: 'GAME_STARTED', started: true, actualCount: r.actualCount });
                    // M5：建立遊戲引擎（僅參戰者入局；觀戰者不分配角色）
                    const participants = r.room.getParticipatingMembers();
                    if (participants.length > 0) {
                        const roomCode = r.room.code;
                        const game = new GameEngine(roomCode, participants.map((m) => ({ clientId: m.clientId, nickname: m.nickname })), {
                            sendTo: (cid, m) => {
                                const c = clients.get(cid);
                                if (c && c.ws.readyState === WebSocket.OPEN)
                                    c.ws.send(JSON.stringify(m));
                            },
                            broadcast: (m, targetClientIds) => {
                                const payload = JSON.stringify(m);
                                for (const c of clients.values()) {
                                    if (c.roomCode !== roomCode)
                                        continue;
                                    if (targetClientIds && !targetClientIds.includes(c.clientId))
                                        continue;
                                    if (c.ws.readyState === WebSocket.OPEN)
                                        c.ws.send(payload);
                                }
                            },
                            getHostClientId: () => roomManager.getRoom(roomCode)?.host?.clientId,
                        });
                        r.room.game = game;
                        game.start();
                    }
                }
                else {
                    send(ws, { type: 'ERROR', message: '只有房主可以開始遊戲' });
                }
                break;
            }
            case 'KICK_PLAYER': {
                const r = roomManager.kickPlayer(clientId, msg.target);
                if (r.ok) {
                    const kickedRec = clients.get(r.kicked.clientId);
                    if (kickedRec) {
                        send(kickedRec.ws, { type: 'KICKED', reason: '被房主移出房間' });
                        kickedRec.roomCode = undefined;
                    }
                    broadcastToRoom(r.room.code, { type: 'PLAYER_LEFT', nickname: r.kicked.nickname });
                }
                else {
                    send(ws, { type: 'ERROR', message: '無法移出該玩家' });
                }
                break;
            }
            case 'NIGHT_ACTION': {
                const room = rec.roomCode ? roomManager.getRoom(rec.roomCode) : undefined;
                if (room && room.game) {
                    room.touch();
                    room.game.handleNightAction(clientId, { type: msg.action, targetClientId: msg.targetClientId });
                }
                break;
            }
            case 'TOGGLE_MASON_END_TURN': {
                const room = rec.roomCode ? roomManager.getRoom(rec.roomCode) : undefined;
                if (room && room.game) {
                    room.touch();
                    room.game.handleToggleMasonEndTurn(clientId);
                }
                break;
            }
            case 'TOGGLE_WOLF_READY': {
                const room = rec.roomCode ? roomManager.getRoom(rec.roomCode) : undefined;
                if (room && room.game) {
                    room.touch();
                    room.game.handleToggleWolfReady(clientId);
                }
                break;
            }
            case 'CAST_VOTE': {
                const room = rec.roomCode ? roomManager.getRoom(rec.roomCode) : undefined;
                if (room && room.game) {
                    room.touch();
                    room.game.handleVote(clientId, msg.targetClientId);
                }
                break;
            }
            case 'END_DISCUSSION': {
                const room = rec.roomCode ? roomManager.getRoom(rec.roomCode) : undefined;
                if (room && room.game) {
                    room.touch();
                    room.game.handleEndDiscussion(clientId);
                }
                break;
            }
            case 'TOGGLE_VOTE_READY': {
                const room = rec.roomCode ? roomManager.getRoom(rec.roomCode) : undefined;
                if (room && room.game) {
                    room.touch();
                    room.game.handleToggleVoteReady(clientId);
                }
                break;
            }
            case 'WOLF_CHAT': {
                const room = rec.roomCode ? roomManager.getRoom(rec.roomCode) : undefined;
                if (room && room.game) {
                    room.touch();
                    room.game.handleWolfChat(clientId, msg.text);
                }
                break;
            }
            case 'MASON_CHAT': {
                const room = rec.roomCode ? roomManager.getRoom(rec.roomCode) : undefined;
                if (room && room.game) {
                    room.touch();
                    room.game.handleMasonChat(clientId, msg.text);
                }
                break;
            }
            default:
                break; // 未知訊息類型：忽略
        }
    };
    const onDisconnect = (clientId) => {
        const rec = clients.get(clientId);
        if (!rec)
            return;
        const code = rec.roomCode;
        clients.delete(clientId);
        if (!code)
            return;
        const r = roomManager.leaveRoom(clientId);
        if (r.left)
            broadcastToRoom(code, { type: 'PLAYER_LEFT', nickname: r.left.nickname }, clientId);
        if (r.wasHost && r.newHost)
            broadcastToRoom(code, { type: 'HOST_CHANGED', newHost: r.newHost.nickname });
    };
    wss.on('connection', (ws, req) => {
        const clientId = randomUUID();
        const ip = clientIp(req);
        clients.set(clientId, { clientId, ws, ip });
        ws.on('message', (data) => onMessage(clientId, ws, data));
        ws.on('close', () => onDisconnect(clientId));
    });
    await new Promise((resolve, reject) => {
        const onError = (e) => reject(e);
        httpServer.once('error', onError);
        httpServer.listen(port, host, () => {
            httpServer.removeListener('error', onError);
            resolve();
        });
    });
    const addr = httpServer.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    return {
        port: actualPort,
        url: `http://localhost:${actualPort}`,
        roomManager,
        shutdown: async () => {
            roomManager.stopSweep();
            for (const c of clients.values()) {
                if (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)
                    c.ws.close();
            }
            wss.close();
            await new Promise((resolve) => {
                httpServer.close(() => resolve());
                // 強迫關閉殘留的 keep-alive 連線（例如 fetch 的 HTTP 連線），讓 close 能完成
                httpServer.closeAllConnections();
            });
        },
    };
}
//# sourceMappingURL=server.js.map