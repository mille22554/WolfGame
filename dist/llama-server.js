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
/**
 * 預設推理線程數（啟發式）：瞄準實體核 ≈ 邏輯核一半，上限 8、下限 1。
 * 背景：llama.cpp CPU 推理超訂（threads > 實體核）只增上下文切換，不加吞吐；
 * 8 線程跑 4 核（i3-14100）實測浪費 10-30%。多核機器不受傷（16 線程→8，32 線程→8）。
 * env LLAMA_SERVER_THREADS 照樣覆寫（server.ts／LlamaServerManagerOptions.threads 最高優先）。
 */
export function defaultThreads(logicalCpus = os.cpus().length) {
    const n = Number.isFinite(logicalCpus) ? Math.floor(logicalCpus) : 4;
    return Math.max(1, Math.min(8, Math.floor(n / 2)));
}
/** llama-server.exe 下載 URL（llama.cpp GitHub release 資產；變體化） */
export function llamaServerDownloadUrl(release, variant = 'cpu') {
    const asset = variant === 'vulkan'
        ? `llama-${release}-bin-win-vulkan-x64.zip`
        : `llama-${release}-bin-win-cpu-x64.zip`;
    return `https://github.com/ggml-org/llama.cpp/releases/download/${release}/${asset}`;
}
/** 變體分目錄名（換變體後舊目錄即殘留，由 prune／migrate 處理） */
export function llamaServerDirName(release, variant = 'cpu') {
    return `llama-${release}-${variant}`;
}
/** 清掉同 release 的非保留變體目錄（手動單變體用；auto 模式需雙包並存，不呼叫）。回傳刪除的目錄。 */
export function pruneOtherVariantDirs(binDir, release, keep) {
    const removed = [];
    for (const v of ['cpu', 'vulkan']) {
        if (v === keep)
            continue;
        const d = path.join(binDir, llamaServerDirName(release, v));
        try {
            if (fs.existsSync(d)) {
                fs.rmSync(d, { recursive: true, force: true });
                removed.push(d);
            }
        }
        catch {
            /* 清理失敗不擋啟動 */
        }
    }
    return removed;
}
/** 舊版無後綴目錄（llama-{release}/）視為 cpu 包：cpu 目錄缺 exe 則搬過去，否則當殘留刪除 */
export function migrateLegacyLlamaDir(binDir, release) {
    const legacyDir = path.join(binDir, `llama-${release}`);
    if (!fs.existsSync(legacyDir))
        return;
    const cpuDir = path.join(binDir, llamaServerDirName(release, 'cpu'));
    try {
        if (!fs.existsSync(path.join(cpuDir, 'llama-server.exe'))) {
            fs.mkdirSync(binDir, { recursive: true });
            if (fs.existsSync(cpuDir))
                fs.rmSync(cpuDir, { recursive: true, force: true });
            fs.renameSync(legacyDir, cpuDir);
        }
        else {
            fs.rmSync(legacyDir, { recursive: true, force: true });
        }
    }
    catch {
        /* 清理失敗不擋啟動 */
    }
}
// ============================================
// GPU 層數（顯存分級；偵測不可靠→保守預設＋行為回退，不寫複雜偵測）
// ============================================
export const FULL_GPU_LAYERS = 99;
export const REDUCED_GPU_LAYERS = 20;
/** 顯存（MB）→ --n-gpu-layers：≥6GB 全層 99、≥4GB 約 20 層、＜4GB／內顯／未知→ 0 或保守 20（未知保守 20，明確不足才走 CPU） */
export function gpuLayersForVram(vramMB, integrated) {
    if (integrated)
        return 0;
    if (vramMB === undefined || !Number.isFinite(vramMB))
        return REDUCED_GPU_LAYERS;
    const gb = vramMB / 1024;
    if (gb >= 6)
        return FULL_GPU_LAYERS;
    if (gb >= 4)
        return REDUCED_GPU_LAYERS;
    return 0;
}
/** 自動降層：99 等高層→ 20；20 以下→ 0（改走 CPU，不再重試同 binary） */
export function reducedGpuLayers(layers) {
    return layers > REDUCED_GPU_LAYERS ? REDUCED_GPU_LAYERS : 0;
}
/** 顯存偵測：只吃手動覆寫（env LLAMA_VRAM_MB，MB）；wmic／AdapterRAM 不準，不做 */
export function detectVramMB(env = process.env) {
    const v = Number(env.LLAMA_VRAM_MB);
    return Number.isFinite(v) && v > 0 ? v : undefined;
}
/** 預設層數：env LLAMA_GPU_LAYERS 強制覆寫 ＞ 顯存分級（未知→保守 20）；內顯（LLAMA_INTEGRATED_GPU=1）→ 0 */
export function defaultGpuLayers(env = process.env) {
    const forced = Number(env.LLAMA_GPU_LAYERS);
    if (Number.isFinite(forced) && forced >= 0)
        return Math.floor(forced);
    const integrated = /^(1|true)$/i.test(String(env.LLAMA_INTEGRATED_GPU ?? ''));
    return gpuLayersForVram(detectVramMB(env), integrated);
}
// ============================================
// GPU 錯誤辨識（logTail regex；命中才走降層／換包回退）
// ============================================
const GPU_CRASH_PATTERNS = [
    /no\s+vulkan/i,
    /vk_error_(device_lost|out_of_(device|host)_memory|incompatible_driver|initialization_failed)/i,
    /vulkan.*(no\s+devices?|not\s+(found|available|supported)|fail|error|unavailable)/i,
    /out\s+of\s+(device|video|vram)\s+memory/i,
    /(device|vram|gpu).{0,24}out\s+of\s+memory/i,
    /driver.{0,40}(too\s+old|insufficient|unsupported|incompatible|missing)/i,
    /(too\s+old|insufficient|incompatible|missing).{0,40}driver/i,
];
/** crash 輸出是否為 GPU（Vulkan 無裝置／OOM／驅動不足）錯誤 */
export function isGpuCrashError(logTail) {
    return GPU_CRASH_PATTERNS.some((re) => re.test(logTail));
}
// ============================================
// 後端偏好持久化（模型管理頁三檔；手動＞自動）
// ============================================
export const BACKEND_CONFIG_FILE = 'backend.json';
export function readBackendPreference(dataDir) {
    try {
        const raw = fs.readFileSync(path.join(dataDir ?? getDataDir(), BACKEND_CONFIG_FILE), 'utf-8');
        const v = JSON.parse(raw).backend;
        return v === 'cpu' || v === 'gpu' || v === 'auto' ? v : 'auto';
    }
    catch {
        return 'auto';
    }
}
export function writeBackendPreference(pref, dataDir) {
    const dir = dataDir ?? getDataDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, BACKEND_CONFIG_FILE), JSON.stringify({ backend: pref }));
}
/** 有效偏好：選項 hook ＞ 持久化手動（非 auto）＞ env LLAMA_BACKEND ＞ auto */
export function effectiveBackendPreference(opts = {}) {
    const o = opts.option;
    if (o === 'cpu' || o === 'gpu' || o === 'auto')
        return o;
    const s = opts.stored;
    if (s === 'cpu' || s === 'gpu')
        return s;
    const e = opts.env?.LLAMA_BACKEND;
    if (e === 'cpu' || e === 'gpu' || e === 'auto')
        return e;
    return 'auto';
}
/** 回傳 llama-server.exe 絕對路徑；找不到/下載失敗 → throw */
export async function ensureLlamaServer(options = {}) {
    const binDir = options.binDir ?? getDefaultBinDir();
    const release = options.release ?? DEFAULT_LLAMA_SERVER_RELEASE;
    const variant = options.variant ?? 'cpu';
    const fetchImpl = options.fetchImpl ?? fetch;
    // 舊版無後綴目錄視為 cpu 包先搬家（冪等；失敗不擋啟動）
    migrateLegacyLlamaDir(binDir, release);
    // 候選路徑依序檢查（存在 → 回傳）
    const variantDownload = path.join(binDir, llamaServerDirName(release, variant), 'llama-server.exe');
    if (fs.existsSync(variantDownload)) {
        if (options.pruneOtherVariants)
            pruneOtherVariantDirs(binDir, release, variant);
        return variantDownload;
    }
    const manual = path.join(binDir, 'llama-server.exe');
    if (fs.existsSync(manual)) {
        if (options.pruneOtherVariants)
            pruneOtherVariantDirs(binDir, release, variant);
        return manual;
    }
    fs.mkdirSync(binDir, { recursive: true });
    const zipPath = path.join(binDir, `llama-${release}-${variant}.zip.tmp`);
    const url = llamaServerDownloadUrl(release, variant);
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
        new AdmZip(zipPath).extractAllTo(path.join(binDir, llamaServerDirName(release, variant)), true);
    }
    finally {
        try {
            fs.rmSync(zipPath, { force: true });
        }
        catch {
            /* ignore */
        }
    }
    if (options.pruneOtherVariants)
        pruneOtherVariantDirs(binDir, release, variant);
    if (fs.existsSync(variantDownload))
        return variantDownload;
    throw new Error(`llama-server 解壓後找不到 llama-server.exe（${variantDownload}）`);
}
/**
 * auto 模式雙包確保：先 CPU（底線）再 Vulkan。
 * Vulkan 下載失敗不丟錯 → 回傳 { cpuPath, vulkanPath: null }，呼叫方只用 CPU 繼續；
 * CPU 失敗則直接 throw（無底線可用）。
 * 本函數只負責下載；啟動期回退（降層／換包）由 startLlamaServerWithFallback 處理，全程不再下載。
 */
export async function ensureLlamaServerPair(options = {}) {
    const { pruneOtherVariants: _prune, variant: _variant, ...rest } = options;
    void _prune;
    void _variant;
    const cpuPath = await ensureLlamaServer({ ...rest, variant: 'cpu', pruneOtherVariants: false });
    let vulkanPath = null;
    try {
        vulkanPath = await ensureLlamaServer({ ...rest, variant: 'vulkan', pruneOtherVariants: false });
    }
    catch (err) {
        console.error(`[llama-server] Vulkan 包下載失敗，僅用 CPU 包繼續：${err instanceof Error ? err.message : String(err)}`);
    }
    return { cpuPath, vulkanPath };
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
            threads: options.threads ?? defaultThreads(),
            parallel: options.parallel ?? 1,
            idleTimeout: options.idleTimeout ?? 600,
            healthTimeoutMs: options.healthTimeoutMs ?? 120000,
            healthIntervalMs: options.healthIntervalMs ?? 1000,
            maxRestarts: options.maxRestarts ?? 3,
            gpuLayers: options.gpuLayers ?? 0,
            cacheTypeK: options.cacheTypeK ?? 'q8_0',
            cacheTypeV: options.cacheTypeV ?? 'q8_0',
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
            throw new Error(isGpuCrashError(tail)
                ? `llama-server 啟動失敗（GPU 錯誤：疑似無 Vulkan 裝置／顯存不足／驅動過舊，請換 CPU 後端或降層重試，或更新顯卡驅動）：${tail.slice(0, 500)}`
                : `llama-server 啟動失敗（重啟耗盡）：${tail.slice(0, 500)}`);
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
    /** 測試／診斷用：最近輸出（回退狀態機判斷 GPU 錯誤用） */
    getLogTail() {
        return this.logTail.join('\n');
    }
    buildArgs(port) {
        const o = this.options;
        const args = [
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
        // Vulkan 版：GPU 層數＋砍半 KV（顯存不足 OOM 機率大，先砍半保啟動）
        if (o.gpuLayers > 0) {
            args.push('--n-gpu-layers', String(o.gpuLayers));
            args.push('--cache-type-k', o.cacheTypeK, '--cache-type-v', o.cacheTypeV);
        }
        return args;
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
/** 啟動期回退：只吃碟上路徑，不呼叫任何下載（含 ensure），故無二次下載 */
export async function startLlamaServerWithFallback(options) {
    const { cpuBinPath, vulkanBinPath, modelPath, allowCpuFallback = true, createManager, onStatus, gpuLayers: gpuLayersOpt, ...rest } = options;
    const mk = createManager ?? ((o) => new LlamaServerManager(o));
    const baseOpts = { modelPath, ...rest, onStatus };
    const startOne = async (binPath, layers, extraStatus) => {
        let crashedTail = '';
        const mgr = mk({
            ...baseOpts,
            binPath,
            gpuLayers: layers,
            onStatus: (s, i) => {
                if (s === 'crashed' && i)
                    crashedTail = i;
                extraStatus?.(s, i);
                onStatus?.(s, i);
            },
        });
        try {
            const r = await mgr.start();
            return { manager: mgr, port: r.port, reused: r.reused, crashedTail };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // crashed 廣播沒帶 info（極少）時退回用 manager 內 tail＋錯誤訊息拼湊
            if (!crashedTail)
                crashedTail = `${mgr.getLogTail()}\n${msg}`;
            await mgr.stop().catch(() => undefined);
            throw { err, crashedTail };
        }
    };
    const layers = gpuLayersOpt ?? defaultGpuLayers();
    const hasVulkan = !!vulkanBinPath && fs.existsSync(vulkanBinPath);
    // 無 Vulkan 包／層數 0（內顯／顯存不足／未知保守關閉）→ 直接 CPU，不算回退
    if (!hasVulkan || layers <= 0) {
        const r = await startOne(cpuBinPath, 0);
        return { manager: r.manager, port: r.port, reused: r.reused, backend: 'cpu', gpuLayers: 0 };
    }
    const vulkan = vulkanBinPath;
    // 1) Vulkan 全層（或指定層數）優先試
    try {
        const r = await startOne(vulkan, layers);
        return { manager: r.manager, port: r.port, reused: r.reused, backend: 'gpu', gpuLayers: layers };
    }
    catch (e) {
        const tail = e.crashedTail ?? '';
        const err = e.err;
        if (!isGpuCrashError(tail))
            throw err; // 一般 crash：不回退，直接丟原錯（已含一般 crash 診斷）
        // 2) GPU 錯誤 → 同包降層一次（高層→20；20 以下→0 會改走 CPU，故此處只處理可降層的情況）
        const reduced = reducedGpuLayers(layers);
        if (reduced > 0) {
            onStatus?.('starting', `GPU 啟動失敗，自動降層重試（--n-gpu-layers ${layers} → ${reduced}）…`);
            try {
                const r2 = await startOne(vulkan, reduced);
                return { manager: r2.manager, port: r2.port, reused: r2.reused, backend: 'gpu', gpuLayers: reduced };
            }
            catch (e2) {
                const tail2 = e2.crashedTail ?? '';
                const err2 = e2.err;
                if (!isGpuCrashError(tail2))
                    throw err2; // 降層後非 GPU 錯：一般 crash
                if (!allowCpuFallback) {
                    throw new Error(`llama-server 啟動失敗（GPU 錯誤：降層至 ${reduced} 仍失敗，請更新顯卡驅動或換 CPU 後端）：${tail2.slice(0, 500)}`);
                }
                onStatus?.('starting', 'GPU 降層仍失敗，切換為碟上 CPU 包重啟（免重新下載）…');
                const rc = await startOne(cpuBinPath, 0);
                return { manager: rc.manager, port: rc.port, reused: rc.reused, backend: 'cpu', gpuLayers: 0 };
            }
        }
        // 初始即低層（≤20）且 GPU 錯 → 無降層空間，直接換 CPU（auto）或報錯（手動 gpu）
        if (!allowCpuFallback) {
            throw new Error(`llama-server 啟動失敗（GPU 錯誤：請更新顯卡驅動或換 CPU 後端）：${tail.slice(0, 500)}`);
        }
        onStatus?.('starting', 'GPU 啟動失敗，切換為碟上 CPU 包重啟（免重新下載）…');
        const rc = await startOne(cpuBinPath, 0);
        return { manager: rc.manager, port: rc.port, reused: rc.reused, backend: 'cpu', gpuLayers: 0 };
    }
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