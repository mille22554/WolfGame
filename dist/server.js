/**
 * server.ts — Phase 1 單機 Web 全 AI 後端
 *
 * HTTP 靜態（public/）+ WebSocket（ws）+ 遊戲生命週期：
 * 模型檢查/下載進度 → WorkerDispatcher → engine + SpeechScheduler + WebSocketRegistry
 * → 全 AI 自動對戰 → 關閉機制（LEAVE / 斷線零連線兜底 / SIGINT/SIGTERM）
 */
import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { pathToFileURL } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { GameEngine } from './engine.js';
import { SpeechScheduler } from './ai-scheduler.js';
import { WorkerDispatcher } from './worker-dispatcher.js';
import { createGameState, buildGMSnapshot, buildPlayerSnapshot, buildSpectatorSnapshot, buildLobbySnapshot, } from './game-state.js';
import { ensureModelDownloaded, DEFAULT_LLAMACPP_MODEL_URI, getDefaultModelsDir, } from './llm.js';
import { getResourceRoot } from './utils.js';
function envInt(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) ? v : fallback;
}
// ============================================
// 模型檢查
// ============================================
/** 'hf:Qwen/Qwen3-4B-GGUF:Qwen3-4B-Q4_K_M.gguf' → 'Qwen3-4B-Q4_K_M.gguf' */
export function modelFileName(modelUri) {
    const idx = modelUri.lastIndexOf(':');
    return idx >= 0 ? modelUri.slice(idx + 1) : modelUri;
}
export function isModelDownloaded(modelUri, modelsDir) {
    try {
        if (fs.existsSync(path.join(modelsDir, modelFileName(modelUri))))
            return true;
        // spike 驗證：node-llama-cpp resolveModelFile 實際檔名為 hf_ 前綴形式
        // （如 hf_Qwen_Qwen3-4B.QWEN3-4B-Q4_K_M.GGUF.gguf），故退回檢查任意 .gguf
        const entries = fs.readdirSync(modelsDir);
        return entries.some((e) => e.toLowerCase().endsWith('.gguf'));
    }
    catch {
        return false;
    }
}
/**
 * 解析實際模型檔路徑。
 * 精確檔名存在 → 直接使用；否則退回掃描 modelsDir 找第一個 .gguf
 * （node-llama-cpp 下載後實際檔名為 hf_ 前綴形式）。
 */
export function resolveModelPath(modelUri, modelsDir) {
    const exact = path.join(modelsDir, modelFileName(modelUri));
    if (fs.existsSync(exact))
        return exact;
    try {
        const found = fs.readdirSync(modelsDir).find((e) => e.toLowerCase().endsWith('.gguf'));
        if (found)
            return path.join(modelsDir, found);
    }
    catch { /* fallthrough */ }
    return exact;
}
// ============================================
// 靜態檔案伺服
// ============================================
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};
export function serveStatic(req, res, publicDir, modelReady) {
    if (req.method !== 'GET') {
        res.writeHead(404).end('Not found');
        return;
    }
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    }
    catch {
        res.writeHead(400).end('Bad request');
        return;
    }
    if (pathname === '/') {
        if (!modelReady) {
            res.writeHead(302, { Location: '/download.html' }).end();
            return;
        }
        pathname = '/index.html';
    }
    const resolved = path.resolve(publicDir, `.${pathname}`);
    if (!resolved.startsWith(path.resolve(publicDir) + path.sep) && resolved !== path.resolve(publicDir)) {
        res.writeHead(404).end('Not found');
        return;
    }
    fs.readFile(resolved, (err, data) => {
        if (err) {
            res.writeHead(404).end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] ?? 'application/octet-stream' });
        res.end(data);
    });
}
// ============================================
// 自動找 port
// ============================================
export async function findAvailablePort(start) {
    for (let p = start; p < start + 10; p++) {
        const ok = await new Promise((resolve) => {
            const srv = net.createServer();
            srv.once('error', () => resolve(false));
            srv.listen(p, () => {
                srv.close(() => resolve(true));
            });
        });
        if (ok)
            return p;
    }
    throw new Error(`找不到可用 port（${start} 起 10 個皆被佔用）`);
}
// ============================================
// 開瀏覽器（Windows）
// ============================================
export function openBrowser(url) {
    exec(`start "" "${url}"`, (err) => {
        if (err)
            console.log(`請手動開啟瀏覽器：${url}`);
    });
}
// ============================================
// WebSocketRegistry（實作 ClientRegistry）
// ============================================
/** Phase 2：SeatManager（token 管理；playerId ↔ token 雙向映射） */
export class SeatManager {
    reservations = new Map(); // playerId → token
    tokens = new Map(); // token → playerId
    reserve(playerId) {
        const token = crypto.randomUUID();
        this.reservations.set(playerId, token);
        this.tokens.set(token, playerId);
        return token;
    }
    release(playerId) {
        const token = this.reservations.get(playerId);
        if (token !== undefined)
            this.tokens.delete(token);
        this.reservations.delete(playerId);
    }
    lookup(token) {
        return this.tokens.get(token);
    }
    isReserved(playerId) {
        return this.reservations.has(playerId);
    }
}
export class WebSocketRegistry {
    opts;
    clients = new Set();
    zeroTimer = null;
    pingTimer = null;
    constructor(wss, opts) {
        this.opts = {
            getState: opts.getState,
            zeroClientShutdownMs: opts.zeroClientShutdownMs ?? envInt('ZERO_CLIENT_SHUTDOWN_MS', 600000),
            pingIntervalMs: opts.pingIntervalMs ?? envInt('PING_INTERVAL_MS', 30000),
            pingTimeoutMs: opts.pingTimeoutMs ?? envInt('PING_TIMEOUT_MS', 10000),
            onZeroClientsTimeout: opts.onZeroClientsTimeout,
            onLastClientLeave: opts.onLastClientLeave,
            actions: opts.actions,
        };
        wss.on('connection', (ws) => this.onConnection(ws));
        this.pingTimer = setInterval(() => this.pingCheck(), this.opts.pingIntervalMs);
        const t = this.pingTimer;
        if (typeof t.unref === 'function')
            t.unref();
    }
    // --- ClientRegistry ---
    getConnectedPlayerIds() {
        return [...this.clients]
            .filter((c) => c.playerId !== undefined)
            .map((c) => c.playerId);
    }
    send(playerId, snapshot) {
        for (const c of this.clients) {
            if (c.playerId !== playerId)
                continue;
            const msg = { type: 'SNAPSHOT', snapshot, gmView: false };
            try {
                c.ws.send(JSON.stringify(msg));
            }
            catch { /* 單一客戶端失敗不影響其他人 */ }
        }
    }
    sendSpectator(snapshot) {
        for (const c of this.clients) {
            if (c.playerId !== undefined)
                continue; // Phase 2：只送給觀戰者（未選座）
            const msg = c.gmView
                ? { type: 'SNAPSHOT', snapshot: buildGMSnapshot(this.opts.getState()), gmView: true }
                : { type: 'SNAPSHOT', snapshot, gmView: false };
            try {
                c.ws.send(JSON.stringify(msg));
            }
            catch { /* 單一客戶端失敗不影響其他人 */ }
        }
    }
    sendLobby(lobby) {
        const msg = { type: 'LOBBY', lobby };
        for (const c of this.clients) {
            try {
                c.ws.send(JSON.stringify(msg));
            }
            catch { /* 單一客戶端失敗不影響其他人 */ }
        }
    }
    hasSpectators() {
        return [...this.clients].some((c) => c.playerId === undefined);
    }
    /** 測試用：目前連線數 */
    clientCount() {
        return this.clients.size;
    }
    stop() {
        if (this.pingTimer)
            clearInterval(this.pingTimer);
        this.pingTimer = null;
        if (this.zeroTimer)
            clearTimeout(this.zeroTimer);
        this.zeroTimer = null;
    }
    /** 關閉所有連線（shutdown 時） */
    closeAll() {
        const msg = { type: 'SHUTDOWN' };
        for (const c of this.clients) {
            try {
                c.ws.send(JSON.stringify(msg));
            }
            catch { /* ignore */ }
            try {
                c.ws.close(1000, 'server shutdown');
            }
            catch { /* ignore */ }
        }
        this.clients.clear();
    }
    pushSnapshot(c) {
        let msg;
        try {
            const state = this.opts.getState();
            if (state.phase === 'SETUP_WAITING_JOIN' || state.phase === 'SETUP_READY') {
                msg = { type: 'LOBBY', lobby: buildLobbySnapshot(state) };
            }
            else if (c.gmView) {
                msg = { type: 'SNAPSHOT', snapshot: buildGMSnapshot(state), gmView: true };
            }
            else if (c.playerId !== undefined) {
                msg = { type: 'SNAPSHOT', snapshot: buildPlayerSnapshot(state, c.playerId), gmView: false };
            }
            else {
                msg = { type: 'SNAPSHOT', snapshot: buildSpectatorSnapshot(state), gmView: false };
            }
        }
        catch {
            return; // engine 尚未就緒（模型下載中）→ 略過，client 可稍後 REQUEST_SNAPSHOT
        }
        try {
            c.ws.send(JSON.stringify(msg));
        }
        catch { /* ignore */ }
    }
    onConnection(ws) {
        const client = { ws, gmView: false, lastPong: Date.now() };
        this.clients.add(client);
        if (this.zeroTimer) {
            clearTimeout(this.zeroTimer);
            this.zeroTimer = null;
        }
        this.pushSnapshot(client);
        ws.on('message', (data) => this.onClientMessage(client, data));
        ws.on('close', () => this.onDisconnect(client));
        ws.on('error', () => { });
    }
    onClientMessage(client, data) {
        let msg;
        try {
            msg = JSON.parse(String(data));
        }
        catch {
            return;
        }
        const send = (m) => {
            try {
                client.ws.send(JSON.stringify(m));
            }
            catch { /* ignore */ }
        };
        switch (msg.type) {
            case 'PONG':
                client.lastPong = Date.now();
                break;
            case 'SET_GM_VIEW':
                client.gmView = msg.enabled;
                this.pushSnapshot(client);
                break;
            case 'REQUEST_SNAPSHOT':
                this.pushSnapshot(client);
                break;
            case 'JOIN': {
                const actions = this.opts.actions;
                if (!actions)
                    return;
                if (actions.isStarted()) {
                    send({ type: 'JOIN_REJECTED', reason: 'game started' });
                    break;
                }
                const r = actions.join(msg.playerId, msg.name);
                if (!r.accepted || r.token === undefined) {
                    send({ type: 'JOIN_REJECTED', reason: r.reason ?? 'join failed' });
                    break;
                }
                client.playerId = msg.playerId;
                client.token = r.token;
                send({ type: 'JOINED', playerId: msg.playerId, token: r.token });
                break;
            }
            case 'RECONNECT': {
                const actions = this.opts.actions;
                if (!actions)
                    return;
                const r = actions.reconnect(msg.token);
                if (!r.accepted || r.playerId === undefined || r.token === undefined) {
                    send({ type: 'JOIN_REJECTED', reason: r.reason ?? 'unknown token' });
                    break;
                }
                client.playerId = r.playerId;
                client.token = r.token;
                send({ type: 'JOINED', playerId: r.playerId, token: r.token });
                break;
            }
            case 'START_GAME': {
                const actions = this.opts.actions;
                if (!actions)
                    return;
                if (client.playerId !== undefined && !actions.isStarted()) {
                    actions.startGame();
                }
                break;
            }
            case 'HUMAN_SPEAK':
            case 'HUMAN_SKIP':
            case 'HUMAN_READY_VOTE':
            case 'HUMAN_UNREADY_VOTE':
            case 'HUMAN_VOTE':
            case 'HUMAN_NIGHT_ACTION': {
                const actions = this.opts.actions;
                if (!actions || client.playerId === undefined)
                    return;
                const pid = client.playerId;
                let event;
                switch (msg.type) {
                    case 'HUMAN_SPEAK':
                        event = { type: 'HUMAN_SPEAK', playerId: pid, text: msg.text };
                        break;
                    case 'HUMAN_SKIP':
                        event = { type: 'HUMAN_SKIP', playerId: pid };
                        break;
                    case 'HUMAN_READY_VOTE':
                        event = { type: 'HUMAN_READY_VOTE', playerId: pid };
                        break;
                    case 'HUMAN_UNREADY_VOTE':
                        event = { type: 'HUMAN_UNREADY_VOTE', playerId: pid };
                        break;
                    case 'HUMAN_VOTE':
                        event = { type: 'HUMAN_VOTE', playerId: pid, targetId: msg.targetId };
                        break;
                    case 'HUMAN_NIGHT_ACTION':
                        event = { type: 'HUMAN_NIGHT_ACTION', playerId: pid, targetId: msg.targetId };
                        break;
                }
                const r = actions.humanEvent(event);
                if (!r.accepted)
                    send({ type: 'ACTION_REJECTED', reason: r.reason ?? 'rejected' });
                break;
            }
            case 'LEAVE': {
                const isLast = this.clients.size === 1 && this.clients.has(client);
                try {
                    client.ws.close(1000, 'leave');
                }
                catch { /* ignore */ }
                if (isLast)
                    this.opts.onLastClientLeave?.();
                break;
            }
        }
    }
    onDisconnect(client) {
        this.clients.delete(client);
        // Phase 2：真人座位處理（大廳 → 座位釋放；遊戲中 → AI 接管由 engine DISCONNECT 執行）
        const actions = this.opts.actions;
        if (actions && client.playerId !== undefined) {
            const pid = client.playerId;
            if (!actions.isStarted()) {
                actions.releaseSeat(pid);
            }
            try {
                actions.disconnectPlayer(pid);
            }
            catch { /* ignore */ }
            if (!actions.isStarted()) {
                actions.restartLobbyTimerIfEmpty();
            }
        }
        if (this.clients.size === 0 && !this.zeroTimer) {
            this.zeroTimer = setTimeout(() => {
                this.zeroTimer = null;
                this.opts.onZeroClientsTimeout?.();
            }, this.opts.zeroClientShutdownMs);
            const t = this.zeroTimer;
            if (typeof t.unref === 'function')
                t.unref();
        }
    }
    pingCheck() {
        const now = Date.now();
        const ping = { type: 'PING' };
        for (const c of [...this.clients]) {
            if (now - c.lastPong > this.opts.pingTimeoutMs) {
                try {
                    c.ws.terminate();
                }
                catch { /* ignore */ }
                continue;
            }
            try {
                c.ws.send(JSON.stringify(ping));
            }
            catch { /* ignore */ }
        }
    }
}
// ============================================
// startServer
// ============================================
export async function startServer(options = {}) {
    const portOpt = options.port ?? envInt('PORT', 0);
    const playerCount = options.playerCount ?? envInt('PLAYER_COUNT', 15);
    if (!Number.isInteger(playerCount) || playerCount < 6 || playerCount > 15) {
        throw new Error(`玩家人數必須是 6-15，輸入為：${playerCount}`);
    }
    const publicDir = options.publicDir ?? path.join(getResourceRoot(), 'public');
    const modelsDir = options.modelsDir ?? process.env.LLM_MODELS_DIR ?? getDefaultModelsDir();
    const modelUri = options.modelUri ?? process.env.LLM_MODEL_URI ?? DEFAULT_LLAMACPP_MODEL_URI;
    const shouldOpenBrowser = options.openBrowser ?? true;
    const exitProcess = options.exitProcess ?? true;
    const speechesPerDay = options.speechesPerDay ?? 6;
    const isMock = process.env.LLM_PROVIDER === 'mock';
    let modelReady = isMock || isModelDownloaded(modelUri, modelsDir);
    let modelPath = isMock ? 'mock' : resolveModelPath(modelUri, modelsDir);
    const httpServer = http.createServer((req, res) => {
        serveStatic(req, res, publicDir, modelReady);
    });
    const wss = new WebSocketServer({ server: httpServer });
    const broadcast = (msg) => {
        for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(JSON.stringify(msg));
                }
                catch { /* ignore */ }
            }
        }
    };
    let handle;
    let shutdownFn = async () => undefined;
    const closed = new Promise((resolveClosed) => {
        shutdownFn = async (reason) => {
            await doShutdown(reason);
            resolveClosed(reason);
        };
    });
    // 遊戲物件（shutdown 流程用，延遲指派）
    let engine = null;
    let scheduler = null;
    let dispatcher = null;
    let autoCloseTimer = null;
    let shut = false;
    async function doShutdown(reason) {
        if (shut)
            return;
        shut = true;
        console.log(`[server] 關閉（${reason}）`);
        if (autoCloseTimer)
            clearInterval(autoCloseTimer);
        clearLobbyTimer();
        try {
            engine?.save();
        }
        catch { /* ignore */ }
        scheduler?.stop();
        registry.stop();
        if (dispatcher) {
            try {
                await dispatcher.shutdown();
            }
            catch { /* ignore */ }
        }
        engine?.close();
        registry.closeAll();
        await new Promise((resolve) => {
            wss.close(() => resolve());
        });
        await new Promise((resolve) => {
            httpServer.close(() => resolve());
        });
        options.onShutdown?.(reason);
        if (exitProcess)
            process.exit(0);
    }
    // ---- Phase 2 大廳狀態 ----
    const seats = new SeatManager();
    let started = false;
    let lobbyTimer = null;
    const lobbyTimeoutMs = options.lobbyTimeoutMs ?? envInt('LOBBY_TIMEOUT_MS', 10000);
    function clearLobbyTimer() {
        if (lobbyTimer) {
            clearTimeout(lobbyTimer);
            lobbyTimer = null;
        }
    }
    function hasHumanPlayers() {
        try {
            return engine.getState().players.some((p) => p.controlledBy === 'human');
        }
        catch {
            return false;
        }
    }
    function startGame() {
        if (started || !engine)
            return;
        started = true;
        clearLobbyTimer();
        const state = engine.getState();
        for (let id = 1; id <= state.expectedPlayerCount; id++) {
            if (!state.players.some((p) => p.id === id)) {
                engine.enqueue({ type: 'AI_JOIN', playerId: id });
            }
        }
        engine.enqueue({ type: 'START_GAME' });
        engine.drain();
    }
    function startLobbyTimer() {
        clearLobbyTimer();
        lobbyTimer = setTimeout(() => {
            lobbyTimer = null;
            if (!started && !hasHumanPlayers())
                startGame(); // 無真人 → 全 AI 開局
        }, lobbyTimeoutMs);
        const t = lobbyTimer;
        if (typeof t.unref === 'function')
            t.unref();
    }
    const registry = new WebSocketRegistry(wss, {
        getState: () => engine.getState(),
        zeroClientShutdownMs: options.zeroClientShutdownMs,
        pingIntervalMs: options.pingIntervalMs,
        pingTimeoutMs: options.pingTimeoutMs,
        onZeroClientsTimeout: () => void shutdownFn('no-clients'),
        onLastClientLeave: () => void shutdownFn('leave'),
        actions: {
            join: (playerId, name) => {
                if (started)
                    return { accepted: false, reason: 'game started' };
                if (seats.isReserved(playerId))
                    return { accepted: false, reason: 'seat reserved' };
                const result = engine.tryEvent({ type: 'HUMAN_JOIN', playerId, name });
                if (!result.accepted)
                    return { accepted: false, reason: result.reason ?? 'join failed' };
                const token = seats.reserve(playerId);
                clearLobbyTimer(); // 有人類了，改等人按開始
                return { accepted: true, token };
            },
            reconnect: (token) => {
                const pid = seats.lookup(token);
                if (pid === undefined)
                    return { accepted: false, reason: 'unknown token' };
                engine.enqueue({ type: 'RECONNECT', playerId: pid });
                engine.drain();
                // 死亡 → RECONNECT 被拒，client 變觀戰者，仍回 JOINED 讓其知道身分
                return { accepted: true, playerId: pid, token };
            },
            startGame: () => { startGame(); },
            humanEvent: (event) => {
                const result = engine.tryEvent(event);
                return { accepted: result.accepted, reason: result.reason };
            },
            disconnectPlayer: (playerId) => {
                engine.enqueue({ type: 'DISCONNECT', playerId });
                engine.drain();
            },
            isStarted: () => started,
            releaseSeat: (playerId) => { seats.release(playerId); },
            restartLobbyTimerIfEmpty: () => {
                if (!started && !hasHumanPlayers())
                    startLobbyTimer();
            },
        },
    });
    const onSignal = () => {
        void shutdownFn('signal');
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const port = portOpt === 0 ? await findAvailablePort(3000) : portOpt;
    await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, () => resolve());
    });
    const url = `http://localhost:${port}`;
    console.log(`[server] 啟動：${url}`);
    handle = {
        port,
        url,
        shutdown: (reason) => shutdownFn(reason),
        closed,
    };
    // ---- 模型下載流程 ----
    if (!modelReady) {
        console.log(`[server] 模型未下載，背景下載中：${modelUri}`);
        if (shouldOpenBrowser)
            openBrowser(`${url}/download.html`);
        try {
            modelPath = await ensureModelDownloaded(modelUri, modelsDir, (downloaded, total) => {
                broadcast({ type: 'MODEL_STATUS', state: 'downloading', downloaded, total });
            });
            modelReady = true;
            broadcast({ type: 'MODEL_STATUS', state: 'ready' });
        }
        catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            broadcast({ type: 'MODEL_STATUS', state: 'error', error });
            console.error(`[server] 模型下載失敗：${error}`);
            return handle;
        }
    }
    else {
        broadcast({ type: 'MODEL_STATUS', state: 'ready' });
    }
    // ---- 啟動 LLM + 遊戲 ----
    const factory = options.dispatcherFactory
        ?? ((mp) => new WorkerDispatcher({ modelPath: mp }));
    dispatcher = factory(modelPath);
    try {
        await dispatcher.start();
    }
    catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        broadcast({ type: 'MODEL_STATUS', state: 'error', error });
        console.error(`[server] worker 啟動失敗：${error}`);
        return handle;
    }
    // scheduler 先建（ctx 閉包延遲取用 engine），再傳入 engine options
    scheduler = new SpeechScheduler({
        enqueue: (e) => engine.enqueue(e),
        getState: () => engine.getState(),
        llm: dispatcher,
    });
    engine = new GameEngine({ mode: 'web', llm: dispatcher, scheduler, registry }, createGameState(playerCount));
    // ---- Phase 2：大廳流程（不再自動 CLIENT_JOIN × N + START_GAME，改由大廳驅動） ----
    startLobbyTimer();
    // ---- 全 AI 自動推進：每日發言達標 → CLOSE_DISCUSSION（缺口補位） ----
    // 規格 §11.8 只定義 CLOSING 之後自動開投票 gate，未定義誰關閉討論；
    // 全 AI 局無真人可關閉，故由 server 定時檢查發言數達標後推進。
    // Phase 2：有存活真人時由真人主導討論，不自動關閉。
    autoCloseTimer = setInterval(() => {
        try {
            const s = engine.getState();
            if (s.phase !== 'DAY_DISCUSSION_OPEN')
                return;
            const aliveHumans = s.players.filter((p) => p.alive && p.controlledBy === 'human').length;
            if (aliveHumans > 0)
                return; // 真人主導討論，不自動關閉
            const count = s.discussionLog.filter((d) => d.day === s.day).length;
            if (count >= speechesPerDay) {
                engine.enqueue({ type: 'CLOSE_DISCUSSION' });
                engine.drain();
            }
        }
        catch { /* ignore */ }
    }, 1000);
    const act = autoCloseTimer;
    if (typeof act.unref === 'function')
        act.unref();
    if (shouldOpenBrowser)
        openBrowser(url);
    return handle;
}
async function main() {
    try {
        await startServer({});
    }
    catch (err) {
        console.error(`[server] 啟動失敗：${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main();
}
//# sourceMappingURL=server.js.map