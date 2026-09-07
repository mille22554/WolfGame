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
import { exec } from 'child_process';
import { pathToFileURL } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { GameEngine } from './engine.js';
import { SpeechScheduler } from './ai-scheduler.js';
import { WorkerDispatcher } from './worker-dispatcher.js';
import { createGameState, buildGMSnapshot, buildSpectatorSnapshot, } from './game-state.js';
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
        };
        wss.on('connection', (ws) => this.onConnection(ws));
        this.pingTimer = setInterval(() => this.pingCheck(), this.opts.pingIntervalMs);
        const t = this.pingTimer;
        if (typeof t.unref === 'function')
            t.unref();
    }
    // --- ClientRegistry ---
    getConnectedPlayerIds() {
        return []; // Phase 1 無真人玩家
    }
    send() {
        // Phase 1 不使用（預留 Phase 2）
    }
    sendSpectator(snapshot) {
        for (const c of this.clients) {
            const msg = c.gmView
                ? { type: 'SNAPSHOT', snapshot: buildGMSnapshot(this.opts.getState()), gmView: true }
                : { type: 'SNAPSHOT', snapshot, gmView: false };
            try {
                c.ws.send(JSON.stringify(msg));
            }
            catch { /* 單一客戶端失敗不影響其他人 */ }
        }
    }
    hasSpectators() {
        return this.clients.size > 0;
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
        const msg = c.gmView
            ? { type: 'SNAPSHOT', snapshot: buildGMSnapshot(this.opts.getState()), gmView: true }
            : { type: 'SNAPSHOT', snapshot: buildSpectatorSnapshot(this.opts.getState()), gmView: false };
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
    const registry = new WebSocketRegistry(wss, {
        getState: () => engine.getState(),
        zeroClientShutdownMs: options.zeroClientShutdownMs,
        pingIntervalMs: options.pingIntervalMs,
        pingTimeoutMs: options.pingTimeoutMs,
        onZeroClientsTimeout: () => void shutdownFn('no-clients'),
        onLastClientLeave: () => void shutdownFn('leave'),
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
    for (let i = 0; i < playerCount; i++) {
        engine.enqueue({ type: 'CLIENT_JOIN', name: `P${i + 1}` });
    }
    engine.enqueue({ type: 'START_GAME' });
    engine.drain();
    // ---- 全 AI 自動推進：每日發言達標 → CLOSE_DISCUSSION（缺口補位） ----
    // 規格 §11.8 只定義 CLOSING 之後自動開投票 gate，未定義誰關閉討論；
    // 全 AI 局無真人可關閉，故由 server 定時檢查發言數達標後推進。
    autoCloseTimer = setInterval(() => {
        try {
            const s = engine.getState();
            if (s.phase !== 'DAY_DISCUSSION_OPEN')
                return;
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