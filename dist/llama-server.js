/**
 * llama-server.ts — llama-server.exe sidecar 管理（Plan B）
 *
 * ensureLlamaServer（下載/解壓/驗證）+ LlamaServerManager（spawn/健康檢查/重啟/停止）
 */
import * as fs from 'fs';
import * as net from 'node:net';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import { getDataDir } from './utils.js';
import { StallGuard, downloadStallTimeoutMs } from './download-stall.js';
export const DEFAULT_LLAMA_SERVER_RELEASE = 'b10361';
export const DEFAULT_LLAMA_SERVER_PORT = 2064;
export const DEFAULT_LLAMA_SERVER_HOST = '127.0.0.1';
export function getDefaultBinDir() {
    return path.join(getDataDir(), 'bin');
}
/** llama-server.exe 下載 URL（llama.cpp GitHub release 資產） */
export function llamaServerDownloadUrl(release) {
    return `https://github.com/ggml-org/llama.cpp/releases/download/${release}/llama-${release}-bin-win-cpu-x64.zip`;
}
/** 回傳 llama-server.exe 絕對路徑；找不到/下載失敗 → throw */
export async function ensureLlamaServer(options = {}) {
    const binDir = options.binDir ?? getDefaultBinDir();
    const release = options.release ?? DEFAULT_LLAMA_SERVER_RELEASE;
    const fetchImpl = options.fetchImpl ?? fetch;
    // 候選路徑依序檢查（存在 → 回傳）
    const prevDownload = path.join(binDir, `llama-${release}`, 'llama-server.exe');
    if (fs.existsSync(prevDownload))
        return prevDownload;
    const manual = path.join(binDir, 'llama-server.exe');
    if (fs.existsSync(manual))
        return manual;
    fs.mkdirSync(binDir, { recursive: true });
    const zipPath = path.join(binDir, `llama-${release}.zip.tmp`);
    const url = llamaServerDownloadUrl(release);
    // 停滯超時（idle）：一段時間無任何 bytes 進展就 abort；每 chunk 重置，不用固定總時長
    const guard = new StallGuard(downloadStallTimeoutMs(), 'llama-server ');
    try {
        const res = await fetchImpl(url, { signal: guard.signal });
        if (!res.ok) {
            throw new Error(`llama-server 下載失敗（HTTP ${res.status}）`);
        }
        const total = Number(res.headers.get('content-length') ?? 0);
        let downloaded = 0;
        try {
            if (!res.body)
                throw new Error('llama-server 下載失敗：回應無 body');
            const source = Readable.fromWeb(res.body);
            const dest = fs.createWriteStream(zipPath);
            source.on('data', (chunk) => {
                downloaded += chunk.length;
                options.onProgress?.(downloaded, total);
                guard.reset();
            });
            await pipeline(source, dest, { signal: guard.signal });
            options.onProgress?.(downloaded, total);
        }
        catch (err) {
            try {
                fs.rmSync(zipPath, { force: true });
            }
            catch {
                /* ignore */
            }
            throw err;
        }
    }
    catch (err) {
        if (guard.didStall)
            throw guard.stallError();
        throw err;
    }
    finally {
        guard.cancel();
    }
    // 解壓整包（DLL 需與 exe 同目錄；同步阻塞，慢碟可達 1-2 分鐘，先通知前端避免靜默）
    try {
        options.onStage?.('解壓中…');
        new AdmZip(zipPath).extractAllTo(path.join(binDir, `llama-${release}`), true);
    }
    finally {
        try {
            fs.rmSync(zipPath, { force: true });
        }
        catch {
            /* ignore */
        }
    }
    if (fs.existsSync(prevDownload))
        return prevDownload;
    throw new Error(`llama-server 解壓後找不到 llama-server.exe（${prevDownload}）`);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export class LlamaServerManager {
    options;
    child = null;
    spawnedByUs = false;
    stopRequested = false; // 背景啟動中遇到 shutdown：不再 spawn/等待，直接丟掉飛行中 child
    actualPort;
    logTail = [];
    constructor(options) {
        this.options = {
            binPath: options.binPath,
            modelPath: options.modelPath,
            port: options.port ?? DEFAULT_LLAMA_SERVER_PORT,
            host: options.host ?? DEFAULT_LLAMA_SERVER_HOST,
            ctxSize: options.ctxSize ?? 8192,
            threads: options.threads ?? os.cpus().length,
            parallel: options.parallel ?? 1,
            idleTimeout: options.idleTimeout ?? 600,
            healthTimeoutMs: options.healthTimeoutMs ?? 120000,
            healthIntervalMs: options.healthIntervalMs ?? 1000,
            maxRestarts: options.maxRestarts ?? 3,
            onStatus: options.onStatus,
        };
        this.actualPort = this.options.port;
    }
    get port() {
        return this.actualPort;
    }
    isRunning() {
        return (this.spawnedByUs &&
            this.child !== null &&
            this.child.exitCode === null &&
            this.child.signalCode === null);
    }
    /** 健康檢查通過即 resolve；回傳實際 port 與是否重用既有實例 */
    async start() {
        if (this.stopRequested)
            throw new Error('llama-server stopped');
        const base = this.options.port;
        this.options.onStatus?.('starting');
        for (let port = base; port <= base + 10; port++) {
            // a. 既有健康實例 → 重用
            if (await this.probeHealth(port)) {
                this.actualPort = port;
                this.spawnedByUs = false;
                this.options.onStatus?.('ready', `reused :${port}`);
                return { port, reused: true };
            }
            // b. 已被非 llama 進程監聽（TCP 可連但 /health 非 ok）→ 直接試下一個，
            //    不 spawn（Windows 上 127.0.0.1 與 :: 可影子共存，spawn 後難以快速察覺）
            if (await isPortListening(this.options.host, port)) {
                continue;
            }
            // b. spawn + 輪詢；port 被佔 → 試下一個 port；crash → 重啟耗盡後 throw
            const outcome = await this.tryPort(port);
            if (outcome === 'ready') {
                this.actualPort = port;
                this.spawnedByUs = true;
                this.options.onStatus?.('ready', `spawned :${port}`);
                return { port, reused: false };
            }
            if (outcome === 'port-in-use') {
                continue;
            }
            // 'crashed' → 重啟耗盡，依規格不再試下一個 port，直接失敗
            const tail = this.logTail.slice(-20).join('\n');
            this.options.onStatus?.('crashed', tail);
            throw new Error(`llama-server 啟動失敗（重啟耗盡）：${tail.slice(0, 500)}`);
        }
        this.options.onStatus?.('crashed', '無可用 port');
        throw new Error(`llama-server 啟動失敗：${base} 起 11 個 port 皆被佔用`);
    }
    /**
     * 在指定 port 上 spawn + 等待健康（内部重啟迴圈）。
     * @returns 'ready' | 'port-in-use' | 'crashed'
     */
    async tryPort(port) {
        let restarts = 0;
        for (;;) {
            if (this.stopRequested)
                throw new Error('llama-server stopped');
            const child = this.spawnChild(port);
            const result = await this.waitReady(child, port);
            if (result === 'ready') {
                // stop() 可能在 probe 成功後、賦值前到達（fetch 等待期間）：丟掉並報停
                if (this.stopRequested) {
                    this.killSync(child);
                    throw new Error('llama-server stopped');
                }
                this.child = child;
                return 'ready';
            }
            // child 已退出：判斷是否 port 被佔
            const tail = this.logTail.join('\n');
            const regexHit = /EADDRINUSE|listen EADDR|address already in use|port .* (in use|occupied|already)/i.test(tail);
            const occupied = regexHit || (await this.portOccupiedByOther(port));
            this.killSync(child);
            if (occupied)
                return 'port-in-use';
            // 重啟耗盡：保留 logTail（start() 的 crashed 錯誤訊息要用；清空會導致空診斷）
            if (restarts >= this.options.maxRestarts)
                return 'crashed';
            this.logTail.length = 0; // 真正重試才清空
            restarts++;
            await sleep(1000 * 2 ** (restarts - 1));
            // 每次重啟都廣播 starting（spawn + health polling 期間前端才有更新）
            this.options.onStatus?.('starting', `重啟中（第 ${restarts} 次）`);
        }
    }
    buildArgs(port) {
        const o = this.options;
        return [
            '--model', o.modelPath,
            '--host', o.host,
            '--port', String(port),
            '--ctx-size', String(o.ctxSize),
            '--threads', String(o.threads),
            '--parallel', String(o.parallel),
            '--no-webui',
            // 注意：b10361 不支援 --idle-timeout（傳了會秒死 "invalid argument"）；
            // idleTimeout 選項保留相容，暫不轉成 flag。
        ];
    }
    spawnChild(port) {
        const args = this.buildArgs(port);
        // 測試 hook：fake binary 為 node 腳本（.js/.mjs/.cjs）→ 用 node 執行
        const bin = this.options.binPath;
        const isScript = /\.[cm]?js$/.test(bin);
        const child = isScript
            ? spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
            : spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const push = (data) => {
            const lines = String(data).split('\n');
            for (const l of lines) {
                this.logTail.push(l);
                if (this.logTail.length > 200)
                    this.logTail.shift();
            }
        };
        child.stdout?.on('data', push);
        child.stderr?.on('data', push);
        return child;
    }
    /** 等待健康：輪詢 probeHealth；child 提前退出（且非健康）→ 回傳 'exited' */
    async waitReady(child, port) {
        const deadline = Date.now() + this.options.healthTimeoutMs;
        const start = Date.now();
        let beats = 0; // 已發送的心跳次數（迴圈區域變數，return 即清理，無殘留 timer）
        for (;;) {
            // shutdown 優先：背景啟動中被 stop → 殺掉飛行中 child 並報停（不留孤兒進程）
            if (this.stopRequested) {
                this.killSync(child);
                throw new Error('llama-server stopped');
            }
            if (await this.probeHealth(port))
                return 'ready';
            if (isDead(child))
                return 'exited';
            if (Date.now() >= deadline) {
                this.killSync(child);
                return 'exited';
            }
            // 心跳：每等待滿 30 秒廣播一次（沿用 starting + info，前端顯示「還在載入，沒死」）
            const due = Math.floor((Date.now() - start) / 30000);
            if (due > beats) {
                beats = due;
                this.options.onStatus?.('starting', `載入中，已等待 ${due * 30} 秒`);
            }
            await sleep(Math.min(this.options.healthIntervalMs, Math.max(50, deadline - Date.now())));
        }
    }
    killSync(child) {
        try {
            if (!isDead(child))
                child.kill();
        }
        catch {
            /* ignore */
        }
    }
    /** 該 port 是否被非 llama 進程佔用（TCP 可連但 /health 非 ok） */
    async portOccupiedByOther(port) {
        // 最多試兩次：連線池殘留的半死 socket 可能導致首次 ECONNRESET 誤判
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 2000);
                try {
                    await fetch(`http://${this.options.host}:${port}/health`, { signal: ctrl.signal });
                    return true; // 連得上但非健康 → 被其他進程佔用
                }
                finally {
                    clearTimeout(timer);
                }
            }
            catch {
                if (attempt === 0)
                    await sleep(200);
                else
                    return false;
            }
        }
        return false;
    }
    async probeHealth(port) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 2000);
            try {
                const res = await fetch(`http://${this.options.host}:${port}/health`, { signal: ctrl.signal });
                if (!res.ok)
                    return false;
                const body = (await res.json());
                return body.status === 'ok';
            }
            finally {
                clearTimeout(timer);
            }
        }
        catch {
            return false;
        }
    }
    /** 僅當由本實例 spawn 才殺 child；重用實例為 no-op */
    async stop() {
        this.stopRequested = true;
        const child = this.child;
        this.child = null;
        if (!this.spawnedByUs || !child) {
            this.options.onStatus?.('stopped');
            return;
        }
        this.spawnedByUs = false;
        try {
            child.kill();
        }
        catch {
            /* ignore */
        }
        const deadline = Date.now() + 5000;
        while (!isDead(child) && Date.now() < deadline) {
            await sleep(100);
        }
        if (!isDead(child)) {
            try {
                child.kill('SIGKILL');
            }
            catch {
                /* ignore */
            }
        }
        this.options.onStatus?.('stopped');
    }
}
/** child 是否已結束（含被訊號終止；Windows 上 kill 後 exitCode 為 null，需看 signalCode） */
function isDead(child) {
    return child.exitCode !== null || child.signalCode !== null;
}
/** 該 port 是否已有 TCP 監聽者（不論是否健康） */
function isPortListening(host, port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const done = (v) => {
            try {
                socket.destroy();
            }
            catch {
                /* ignore */
            }
            resolve(v);
        };
        socket.setTimeout(1000);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(port, host);
    });
}
//# sourceMappingURL=llama-server.js.map