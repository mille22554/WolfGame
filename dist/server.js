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
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { GameEngine } from './engine.js';
import { SpeechScheduler } from './ai-scheduler.js';
import { WorkerDispatcher } from './worker-dispatcher.js';
import { createGameState, buildGMSnapshot, buildPlayerSnapshot, buildSpectatorSnapshot, buildLobbySnapshot, } from './game-state.js';
import { DEFAULT_LLAMACPP_MODEL_URI, getDefaultModelsDir, OpenAICompatibleProvider, } from './llm.js';
import { downloadModelFile } from './model-download.js';
import { LlamaServerManager, ensureLlamaServer, getDefaultBinDir, DEFAULT_LLAMA_SERVER_RELEASE, DEFAULT_LLAMA_SERVER_PORT, DEFAULT_LLAMA_SERVER_HOST, } from './llama-server.js';
import { OpenAICompatibleDispatcher, MockDispatcher } from './llm-dispatcher.js';
import { getResourceRoot } from './utils.js';
function envInt(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) ? v : fallback;
}
function envBool(name, fallback) {
    const v = process.env[name];
    if (v === undefined)
        return fallback;
    return v !== '0' && v.toLowerCase() !== 'false' && v !== '';
}
export function resolveProviderMode() {
    const v = process.env.LLM_PROVIDER;
    if (v === 'mock')
        return 'mock';
    if (v === 'llamacpp')
        return 'llamacpp';
    if (v === 'openai')
        return 'openai';
    return 'llama-server'; // 預設（含未設定）
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
/** 掃描 modelsDir 下的 .gguf 檔案（回傳 name + sizeMB，name 排序） */
export function listGgufModels(modelsDir) {
    let entries;
    try {
        entries = fs.readdirSync(modelsDir);
    }
    catch {
        return [];
    }
    const ggufs = entries.filter((e) => e.toLowerCase().endsWith('.gguf')).sort();
    const out = [];
    for (const name of ggufs) {
        try {
            const bytes = fs.statSync(path.join(modelsDir, name)).size;
            out.push({ name, sizeMB: Number((bytes / 1048576).toFixed(1)) });
        }
        catch { /* 忽略無法 stat 的檔案 */ }
    }
    return out;
}
/** 選定模型：檔名含 Qwen3-4B 優先，否則第一個；無模型 → null */
export function pickPreferredModel(names) {
    if (names.length === 0)
        return null;
    const hit = names.find((n) => n.includes('Qwen3-4B'));
    return hit ?? names[0];
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
export function serveStatic(req, res, publicDir, _modelReady) {
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
        pathname = '/menu.html';
    }
    const resolved = path.resolve(publicDir, `.${pathname}`);
    if (!resolved.startsWith(path.resolve(publicDir) + path.sep) && resolved !== path.resolve(publicDir)) {
        res.writeHead(404).end('Not found');
        return;
    }
    fs.readFile(resolved, (err, data) => {
        if (err) {
            // menu.html 尚不存在（@designer 處理中）時退回 index.html，保持根路徑可用
            if (pathname === '/menu.html') {
                const fallback = path.resolve(publicDir, './index.html');
                fs.readFile(fallback, (err2, data2) => {
                    if (err2) {
                        res.writeHead(404).end('Not found');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(data2);
                });
                return;
            }
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
            zeroClientShutdownMs: opts.zeroClientShutdownMs ?? envInt('ZERO_CLIENT_SHUTDOWN_MS', 60000),
            pingIntervalMs: opts.pingIntervalMs ?? envInt('PING_INTERVAL_MS', 30000),
            pingTimeoutMs: opts.pingTimeoutMs ?? envInt('PING_TIMEOUT_MS', 10000),
            onZeroClientsTimeout: opts.onZeroClientsTimeout,
            onLastClientLeave: opts.onLastClientLeave,
            actions: opts.actions,
            ensureReady: opts.ensureReady,
        };
        wss.on('connection', (ws) => void this.onConnection(ws));
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
    // 注意：連線時不觸發 ensureReady（模型管理頁也會連 WS 監聽 MODEL_STATUS，
    // 若連線即啟動會被誤觸發）。只有收到遊戲訊息（handleClientMessage）才延遲啟動
    // llama-server + 建立 engine。連線當下 engine 若已就緒則推送快照，否則略過
    // （client 發遊戲訊息後會觸發 ensure 並補送 LOBBY）。
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
        void this.handleClientMessage(client, data);
    }
    async handleClientMessage(client, data) {
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
        // 延遲初始化重試：先前因模型未就緒而連線的 client，下載完成後無需重連，
        // 任意訊息（除 PONG/LEAVE）都可觸發 ensure，成功後繼續處理本次訊息。
        if (this.opts.ensureReady && msg.type !== 'PONG' && msg.type !== 'LEAVE') {
            let needEnsure = false;
            try {
                this.opts.getState();
            }
            catch {
                needEnsure = true;
            }
            if (needEnsure) {
                let ok = false;
                try {
                    ok = await this.opts.ensureReady();
                }
                catch {
                    ok = false;
                }
                if (!ok) {
                    send({ type: 'ERROR', message: '模型未就緒' });
                    return;
                }
                if (msg.type === 'REQUEST_SNAPSHOT') {
                    this.pushSnapshot(client);
                    return;
                }
            }
        }
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
        this.armZeroTimerIfEmpty();
    }
    /**
     * 零連線關閉計時器：無 client 且尚未 armed 時啟動。
     * - 啟動時呼叫一次（主選單不開 WS 也能兜底：60 秒無連線 → no-clients 關閉 exe）。
     * - 逃生口：`zeroClientShutdownMs <= 0`（`ZERO_CLIENT_SHUTDOWN_MS=0`）時永不 armed，供 dev 使用。
     */
    armZeroTimerIfEmpty() {
        if (this.opts.zeroClientShutdownMs <= 0)
            return;
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
    const shouldOpenBrowser = options.openBrowser ?? envBool('OPEN_BROWSER', true);
    const exitProcess = options.exitProcess ?? true;
    const speechesPerDay = options.speechesPerDay ?? 6;
    const mode = resolveProviderMode();
    const isMock = mode === 'mock';
    const llamaServerHost = options.llamaServerHost ?? process.env.LLAMA_SERVER_HOST ?? DEFAULT_LLAMA_SERVER_HOST;
    const llamaServerPort = options.llamaServerPort ?? envInt('LLAMA_SERVER_PORT', DEFAULT_LLAMA_SERVER_PORT);
    // ---- 啟動時模型掃描（不自動下載；mock/openai 免檢查）----
    let modelReady;
    let selectedModel;
    let modelPath;
    let downloading = false;
    if (isMock) {
        modelReady = true;
        selectedModel = 'mock';
        modelPath = 'mock';
    }
    else if (mode === 'openai') {
        modelReady = true;
        selectedModel = null;
        modelPath = 'openai';
    }
    else {
        const found = listGgufModels(modelsDir);
        if (found.length > 0) {
            modelReady = true;
            const pick = pickPreferredModel(found.map((f) => f.name));
            selectedModel = pick;
            modelPath = path.join(modelsDir, pick);
        }
        else {
            modelReady = false;
            selectedModel = null;
            modelPath = resolveModelPath(modelUri, modelsDir);
        }
    }
    const httpServer = http.createServer((req, res) => {
        void handleRequest(req, res);
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
    function sendJson(res, status, obj) {
        const body = JSON.stringify(obj);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
    }
    function readBody(req) {
        return new Promise((resolve, reject) => {
            let data = '';
            req.on('data', (c) => { data += String(c); });
            req.on('end', () => resolve(data));
            req.on('error', reject);
        });
    }
    async function handleRequest(req, res) {
        try {
            let pathname;
            try {
                pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
            }
            catch {
                res.writeHead(400).end('Bad request');
                return;
            }
            if (req.method === 'GET' && pathname === '/api/status') {
                sendJson(res, 200, { modelReady, selectedModel, models: listGgufModels(modelsDir) });
                return;
            }
            if (req.method === 'POST' && pathname === '/api/model/select') {
                let body = '';
                try {
                    body = await readBody(req);
                }
                catch {
                    sendJson(res, 400, { error: 'bad body' });
                    return;
                }
                let name;
                try {
                    name = JSON.parse(body || '{}').name;
                }
                catch {
                    sendJson(res, 400, { error: 'invalid json' });
                    return;
                }
                if (typeof name !== 'string' || name.length === 0) {
                    sendJson(res, 400, { error: 'missing name' });
                    return;
                }
                if (name.includes('/') || name.includes('\\') || name.includes('..')) {
                    sendJson(res, 404, { error: 'not found' });
                    return;
                }
                if (!name.toLowerCase().endsWith('.gguf')) {
                    sendJson(res, 404, { error: 'not found' });
                    return;
                }
                const target = path.join(modelsDir, name);
                try {
                    const st = fs.statSync(target);
                    if (!st.isFile()) {
                        sendJson(res, 404, { error: 'not found' });
                        return;
                    }
                }
                catch {
                    sendJson(res, 404, { error: 'not found' });
                    return;
                }
                selectedModel = name;
                modelPath = target;
                modelReady = true;
                sendJson(res, 200, { ok: true });
                return;
            }
            if (req.method === 'POST' && pathname === '/api/model/download') {
                if (!downloading && !modelReady) {
                    downloading = true;
                    void (async () => {
                        try {
                            broadcast({ type: 'MODEL_STATUS', state: 'downloading', stage: 'model', downloaded: 0, total: 0 });
                            const dlPath = await downloadModelFile(modelUri, modelsDir, (downloaded, total) => {
                                broadcast({ type: 'MODEL_STATUS', state: 'downloading', stage: 'model', downloaded, total });
                            });
                            modelPath = dlPath;
                            selectedModel = path.basename(dlPath);
                            modelReady = true;
                            broadcast({ type: 'MODEL_STATUS', state: 'ready', stage: 'model' });
                        }
                        catch (err) {
                            const error = err instanceof Error ? err.message : String(err);
                            broadcast({ type: 'MODEL_STATUS', state: 'error', stage: 'model', error });
                        }
                        finally {
                            downloading = false;
                        }
                    })();
                }
                sendJson(res, 200, { ok: true });
                return;
            }
            serveStatic(req, res, publicDir, modelReady);
        }
        catch {
            try {
                res.writeHead(500).end('Internal error');
            }
            catch { /* ignore */ }
        }
    }
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
    let llamaServer = null; // doShutdown 用
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
        if (llamaServer) {
            try {
                await llamaServer.stop();
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
        getState: () => {
            if (!engine)
                throw new Error('engine not ready');
            return engine.getState();
        },
        zeroClientShutdownMs: options.zeroClientShutdownMs,
        pingIntervalMs: options.pingIntervalMs,
        pingTimeoutMs: options.pingTimeoutMs,
        onZeroClientsTimeout: () => void shutdownFn('no-clients'),
        onLastClientLeave: () => void shutdownFn('leave'),
        ensureReady: () => ensureEngineReady(),
        actions: {
            join: (playerId, name) => {
                if (started)
                    return { accepted: false, reason: 'game started' };
                if (!engine)
                    return { accepted: false, reason: 'engine not ready' };
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
                if (!engine)
                    return { accepted: false, reason: 'engine not ready' };
                engine.enqueue({ type: 'RECONNECT', playerId: pid });
                engine.drain();
                // 死亡 → RECONNECT 被拒，client 變觀戰者，仍回 JOINED 讓其知道身分
                return { accepted: true, playerId: pid, token };
            },
            startGame: () => { startGame(); },
            humanEvent: (event) => {
                if (!engine)
                    return { accepted: false, reason: 'engine not ready' };
                const result = engine.tryEvent(event);
                return { accepted: result.accepted, reason: result.reason };
            },
            disconnectPlayer: (playerId) => {
                if (!engine)
                    return;
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
    // ---- 延遲建立：進入遊戲（WS 連線）時確保 llama-server + dispatcher/scheduler/engine ----
    // llama-server 只啟動一次；重複連線直接回傳既有 engine。
    let initPromise = null;
    async function ensureEngineReady() {
        if (engine)
            return true;
        if (initPromise) {
            try {
                await initPromise;
            }
            catch {
                return false;
            }
            return engine !== null;
        }
        // 測試 hook 直接注入 dispatcher，跳過模型檢查與 sidecar
        if (!options.dispatcherFactory && (mode === 'llama-server' || mode === 'llamacpp') && !modelReady) {
            return false;
        }
        initPromise = initGame();
        try {
            await initPromise;
        }
        catch {
            initPromise = null;
            return false;
        }
        return engine !== null;
    }
    async function initGame() {
        if (engine)
            return;
        if (options.dispatcherFactory) {
            dispatcher = options.dispatcherFactory(modelPath); // 測試 hook：跳過 sidecar
        }
        else if (mode === 'llama-server') {
            broadcast({ type: 'MODEL_STATUS', state: 'starting', stage: 'llama-server' });
            let binPath;
            try {
                binPath = options.llamaServerBinPath
                    ?? await ensureLlamaServer({
                        binDir: options.llamaServerBinDir ?? process.env.LLAMA_SERVER_BIN_DIR ?? getDefaultBinDir(),
                        release: options.llamaServerRelease ?? process.env.LLAMA_SERVER_RELEASE ?? DEFAULT_LLAMA_SERVER_RELEASE,
                        onProgress: (downloaded, total) => broadcast({ type: 'MODEL_STATUS', state: 'downloading', stage: 'llama-server', downloaded, total }),
                        onStage: (info) => broadcast({ type: 'MODEL_STATUS', state: 'starting', stage: 'llama-server', info }),
                    });
            }
            catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                broadcast({ type: 'MODEL_STATUS', state: 'error', stage: 'llama-server', error });
                console.error(`[server] llama-server 準備失敗：${error}`);
                throw err;
            }
            llamaServer = new LlamaServerManager({
                binPath,
                modelPath,
                port: llamaServerPort,
                host: llamaServerHost,
                ctxSize: options.llamaServerCtxSize ?? envInt('LLAMA_SERVER_CTX_SIZE', 8192),
                threads: options.llamaServerThreads ?? envInt('LLAMA_SERVER_THREADS', os.cpus().length),
                parallel: options.llamaServerParallel ?? envInt('LLAMA_SERVER_PARALLEL', 1),
                idleTimeout: options.llamaServerIdleTimeout ?? envInt('LLAMA_SERVER_IDLE_TIMEOUT', 600),
                // 2.38GB 模型載入動輒數分鐘：健康等待放寬至 300s（可用 env 覆寫），避免誤殺
                healthTimeoutMs: envInt('LLAMA_SERVER_HEALTH_TIMEOUT_MS', 300000),
                onStatus: (status, info) => {
                    if (status === 'starting')
                        broadcast({ type: 'MODEL_STATUS', state: 'starting', stage: 'llama-server', info });
                    if (status === 'ready')
                        broadcast({ type: 'MODEL_STATUS', state: 'ready', stage: 'llama-server' });
                    if (status === 'crashed')
                        broadcast({ type: 'MODEL_STATUS', state: 'error', stage: 'llama-server', error: info ?? 'llama-server crashed' });
                },
            });
            try {
                const { port } = await llamaServer.start();
                dispatcher = new OpenAICompatibleDispatcher(new OpenAICompatibleProvider({ baseURL: `http://${llamaServerHost}:${port}/v1`, model: 'local' }));
            }
            catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                broadcast({ type: 'MODEL_STATUS', state: 'error', stage: 'llama-server', error });
                console.error(`[server] llama-server 啟動失敗：${error}`);
                throw err;
            }
        }
        else if (mode === 'llamacpp') {
            try {
                dispatcher = new WorkerDispatcher({ modelPath });
            }
            catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                broadcast({ type: 'MODEL_STATUS', state: 'error', stage: 'model',
                    error: `packaged build 不支援 llamacpp 模式：${error}` });
                console.error(`[server] llamacpp 模式啟動失敗：${error}`);
                throw err;
            }
        }
        else if (mode === 'openai') {
            dispatcher = new OpenAICompatibleDispatcher(new OpenAICompatibleProvider({
                baseURL: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL, apiKey: process.env.FREELLMAPI_API_KEY
            }));
        }
        else { // mock
            dispatcher = new MockDispatcher();
        }
        try {
            await dispatcher.start();
        }
        catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            broadcast({ type: 'MODEL_STATUS', state: 'error', stage: 'model', error });
            console.error(`[server] worker 啟動失敗：${error}`);
            throw err;
        }
        // scheduler 先建（ctx 閉包延遲取用 engine），再傳入 engine options
        scheduler = new SpeechScheduler({
            enqueue: (e) => {
                engine.enqueue(e);
                engine.drain(); // AI_SPEECH_DONE 需立即處理，否則卡在 queue（討論永不推進）
            },
            getState: () => engine.getState(),
            llm: dispatcher,
        });
        engine = new GameEngine({ mode: 'web', llm: dispatcher, scheduler, registry }, createGameState(playerCount));
        // ---- Phase 2：大廳流程（不再自動 CLIENT_JOIN × N + START_GAME，改由大廳驅動） ----
        startLobbyTimer();
        // ---- 全 AI 自動推進：每日發言達標 → CLOSE_DISCUSSION（缺口補位） ----
        if (!autoCloseTimer) {
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
        }
        // 先前因模型未就緒而連線的 client：補送 LOBBY，無需重連
        try {
            registry.sendLobby(buildLobbySnapshot(engine.getState()));
        }
        catch { /* ignore */ }
    }
    const onSignal = () => {
        void shutdownFn('signal');
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const port = portOpt === 0 ? await findAvailablePort(2639) : portOpt;
    await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, () => resolve());
    });
    const url = `http://localhost:${port}`;
    console.log(`[server] 啟動：${url}`);
    // 啟動即 armed：主選單不開 WS，從頭 0 連線也會計時（60 秒無連線 → no-clients）；
    // 首條連線進來時 onConnection 會清掉 timer，故已有連線的情況不受影響。
    registry.armZeroTimerIfEmpty();
    handle = {
        port,
        url,
        shutdown: (reason) => shutdownFn(reason),
        closed,
    };
    // ---- 啟動完成：先顯示主選單，不自動下載模型、不自動啟動 llama-server ----
    // 模型下載改由 POST /api/model/download 觸發；
    // llama-server + dispatcher/scheduler/engine 改由 WS 連線時（ensureEngineReady）延遲建立。
    if (!modelReady && !isMock && mode !== 'openai') {
        console.log(`[server] 未偵測到模型（${modelsDir}），請由主選單下載`);
    }
    if (shouldOpenBrowser)
        openBrowser(url);
    return handle;
}
export async function main() {
    try {
        await startServer({});
    }
    catch (err) {
        console.error(`[server] 啟動失敗：${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
//# sourceMappingURL=server.js.map