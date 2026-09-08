/**
 * llama-server.ts — llama-server.exe sidecar 管理（Plan B）
 *
 * ensureLlamaServer（下載/解壓/驗證）+ LlamaServerManager（spawn/健康檢查/重啟/停止）
 */
export declare const DEFAULT_LLAMA_SERVER_RELEASE = "b10361";
export declare const DEFAULT_LLAMA_SERVER_PORT = 2064;
export declare const DEFAULT_LLAMA_SERVER_HOST = "127.0.0.1";
export declare function getDefaultBinDir(): string;
/** llama-server 二進位變體 */
export type LlamaServerVariant = 'cpu' | 'vulkan';
/** 模型管理頁三檔（手動覆寫；優先序：選項 hook ＞ 持久化手動 ＞ env ＞ auto） */
export type BackendPreference = 'auto' | 'cpu' | 'gpu';
/** llama-server.exe 下載 URL（llama.cpp GitHub release 資產；變體化） */
export declare function llamaServerDownloadUrl(release: string, variant?: LlamaServerVariant): string;
/** 變體分目錄名（換變體後舊目錄即殘留，由 prune／migrate 處理） */
export declare function llamaServerDirName(release: string, variant?: LlamaServerVariant): string;
/** 清掉同 release 的非保留變體目錄（手動單變體用；auto 模式需雙包並存，不呼叫）。回傳刪除的目錄。 */
export declare function pruneOtherVariantDirs(binDir: string, release: string, keep: LlamaServerVariant): string[];
/** 舊版無後綴目錄（llama-{release}/）視為 cpu 包：cpu 目錄缺 exe 則搬過去，否則當殘留刪除 */
export declare function migrateLegacyLlamaDir(binDir: string, release: string): void;
export declare const FULL_GPU_LAYERS = 99;
export declare const REDUCED_GPU_LAYERS = 20;
/** 顯存（MB）→ --n-gpu-layers：≥6GB 全層 99、≥4GB 約 20 層、＜4GB／內顯／未知→ 0 或保守 20（未知保守 20，明確不足才走 CPU） */
export declare function gpuLayersForVram(vramMB?: number, integrated?: boolean): number;
/** 自動降層：99 等高層→ 20；20 以下→ 0（改走 CPU，不再重試同 binary） */
export declare function reducedGpuLayers(layers: number): number;
/** 顯存偵測：只吃手動覆寫（env LLAMA_VRAM_MB，MB）；wmic／AdapterRAM 不準，不做 */
export declare function detectVramMB(env?: NodeJS.ProcessEnv): number | undefined;
/** 預設層數：env LLAMA_GPU_LAYERS 強制覆寫 ＞ 顯存分級（未知→保守 20）；內顯（LLAMA_INTEGRATED_GPU=1）→ 0 */
export declare function defaultGpuLayers(env?: NodeJS.ProcessEnv): number;
/** crash 輸出是否為 GPU（Vulkan 無裝置／OOM／驅動不足）錯誤 */
export declare function isGpuCrashError(logTail: string): boolean;
export declare const BACKEND_CONFIG_FILE = "backend.json";
export declare function readBackendPreference(dataDir?: string): BackendPreference;
export declare function writeBackendPreference(pref: BackendPreference, dataDir?: string): void;
/** 有效偏好：選項 hook ＞ 持久化手動（非 auto）＞ env LLAMA_BACKEND ＞ auto */
export declare function effectiveBackendPreference(opts?: {
    option?: BackendPreference;
    stored?: BackendPreference;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): BackendPreference;
export interface LlamaServerDownloadOptions {
    binDir?: string;
    release?: string;
    /** 二進位變體（預設 'cpu'，維持現行行為）；auto 模式會分別呼叫兩次（先 cpu 後 vulkan） */
    variant?: LlamaServerVariant;
    /** 手動單變體時清同 release 另一變體殘留；auto 模式必須 false（雙包並存才是底線） */
    pruneOtherVariants?: boolean;
    onProgress?: (downloaded: number, total: number) => void;
    /** 解壓等同步阻塞階段前呼叫一次（下載進度通道語意不合適，另開 stage 通道） */
    onStage?: (info: string) => void;
    fetchImpl?: typeof fetch;
}
/** 回傳 llama-server.exe 絕對路徑；找不到/下載失敗 → throw */
export declare function ensureLlamaServer(options?: LlamaServerDownloadOptions): Promise<string>;
/**
 * auto 模式雙包確保：先 CPU（底線）再 Vulkan。
 * Vulkan 下載失敗不丟錯 → 回傳 { cpuPath, vulkanPath: null }，呼叫方只用 CPU 繼續；
 * CPU 失敗則直接 throw（無底線可用）。
 * 本函數只負責下載；啟動期回退（降層／換包）由 startLlamaServerWithFallback 處理，全程不再下載。
 */
export declare function ensureLlamaServerPair(options?: LlamaServerDownloadOptions): Promise<{
    cpuPath: string;
    vulkanPath: string | null;
}>;
export interface LlamaServerManagerOptions {
    binPath: string;
    modelPath: string;
    port?: number;
    host?: string;
    ctxSize?: number;
    threads?: number;
    parallel?: number;
    idleTimeout?: number;
    healthTimeoutMs?: number;
    healthIntervalMs?: number;
    maxRestarts?: number;
    /** Vulkan 用 GPU 層數（0／省略＝純 CPU，不帶 GPU flags；>0 才帶 --n-gpu-layers＋砍半 KV） */
    gpuLayers?: number;
    /** KV cache 類型（預設 q8_0／q8_0 砍半 KV；僅 gpuLayers > 0 時生效） */
    cacheTypeK?: string;
    cacheTypeV?: string;
    onStatus?: (status: 'starting' | 'ready' | 'crashed' | 'stopped', info?: string) => void;
}
export declare class LlamaServerManager {
    private readonly options;
    private child;
    private spawnedByUs;
    private stopRequested;
    private actualPort;
    private readonly logTail;
    constructor(options: LlamaServerManagerOptions);
    get port(): number;
    isRunning(): boolean;
    /** 健康檢查通過即 resolve；回傳實際 port 與是否重用既有實例 */
    start(): Promise<{
        port: number;
        reused: boolean;
    }>;
    /**
     * 在指定 port 上 spawn + 等待健康（内部重啟迴圈）。
     * @returns 'ready' | 'port-in-use' | 'crashed'
     */
    private tryPort;
    /** 測試／診斷用：最近輸出（回退狀態機判斷 GPU 錯誤用） */
    getLogTail(): string;
    private buildArgs;
    private spawnChild;
    /** 等待健康：輪詢 probeHealth；child 提前退出（且非健康）→ 回傳 'exited' */
    private waitReady;
    private killSync;
    /** 該 port 是否被非 llama 進程佔用（TCP 可連但 /health 非 ok） */
    private portOccupiedByOther;
    probeHealth(port: number): Promise<boolean>;
    /** 僅當由本實例 spawn 才殺 child；重用實例為 no-op */
    stop(): Promise<void>;
}
export interface LlamaFallbackStartOptions {
    cpuBinPath: string;
    /** 缺省／碟上不存在＝只用 CPU */
    vulkanBinPath?: string | null;
    modelPath: string;
    port?: number;
    host?: string;
    ctxSize?: number;
    threads?: number;
    parallel?: number;
    idleTimeout?: number;
    healthTimeoutMs?: number;
    healthIntervalMs?: number;
    maxRestarts?: number;
    /** 省略＝ defaultGpuLayers()（env 覆寫＞顯存分級＞保守 20；內顯／不足＝0 走 CPU） */
    gpuLayers?: number;
    /** false＝手動 gpu（降層可以，換 CPU 不行）；預設 true（auto 可換 CPU） */
    allowCpuFallback?: boolean;
    onStatus?: (status: 'starting' | 'ready' | 'crashed' | 'stopped', info?: string) => void;
    /** 測試 hook：自訂 manager 建構（計數／fake 用）；預設 new LlamaServerManager */
    createManager?: (opts: LlamaServerManagerOptions) => LlamaServerManager;
}
export interface LlamaFallbackStartResult {
    manager: LlamaServerManager;
    port: number;
    reused: boolean;
    /** 實際生效後端 */
    backend: 'cpu' | 'gpu';
    gpuLayers: number;
}
/** 啟動期回退：只吃碟上路徑，不呼叫任何下載（含 ensure），故無二次下載 */
export declare function startLlamaServerWithFallback(options: LlamaFallbackStartOptions): Promise<LlamaFallbackStartResult>;
//# sourceMappingURL=llama-server.d.ts.map