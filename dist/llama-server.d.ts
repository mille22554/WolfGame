/**
 * llama-server.ts — llama-server.exe sidecar 管理（Plan B）
 *
 * ensureLlamaServer（下載/解壓/驗證）+ LlamaServerManager（spawn/健康檢查/重啟/停止）
 */
export declare const DEFAULT_LLAMA_SERVER_RELEASE = "b10361";
export declare const DEFAULT_LLAMA_SERVER_PORT = 2064;
export declare const DEFAULT_LLAMA_SERVER_HOST = "127.0.0.1";
export declare function getDefaultBinDir(): string;
/** llama-server.exe 下載 URL（llama.cpp GitHub release 資產） */
export declare function llamaServerDownloadUrl(release: string): string;
export interface LlamaServerDownloadOptions {
    binDir?: string;
    release?: string;
    onProgress?: (downloaded: number, total: number) => void;
    /** 解壓等同步阻塞階段前呼叫一次（下載進度通道語意不合適，另開 stage 通道） */
    onStage?: (info: string) => void;
    fetchImpl?: typeof fetch;
}
/** 回傳 llama-server.exe 絕對路徑；找不到/下載失敗 → throw */
export declare function ensureLlamaServer(options?: LlamaServerDownloadOptions): Promise<string>;
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
    onStatus?: (status: 'starting' | 'ready' | 'crashed' | 'stopped', info?: string) => void;
}
export declare class LlamaServerManager {
    private readonly options;
    private child;
    private spawnedByUs;
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
//# sourceMappingURL=llama-server.d.ts.map