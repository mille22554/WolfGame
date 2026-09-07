/**
 * server.ts — Phase 1 單機 Web 全 AI 後端
 *
 * HTTP 靜態（public/）+ WebSocket（ws）+ 遊戲生命週期：
 * 模型檢查/下載進度 → WorkerDispatcher → engine + SpeechScheduler + WebSocketRegistry
 * → 全 AI 自動對戰 → 關閉機制（LEAVE / 斷線零連線兜底 / SIGINT/SIGTERM）
 */
import * as http from 'http';
import { WebSocketServer } from 'ws';
import type { GameState, LLMDispatcher, ClientRegistry, SpectatorSnapshot } from './types.js';
export interface ServerLLM extends LLMDispatcher {
    start(): Promise<void>;
    shutdown(): Promise<void>;
}
export interface ServerOptions {
    port?: number;
    playerCount?: number;
    publicDir?: string;
    modelsDir?: string;
    modelUri?: string;
    openBrowser?: boolean;
    dispatcherFactory?: (modelPath: string) => ServerLLM;
    zeroClientShutdownMs?: number;
    pingIntervalMs?: number;
    pingTimeoutMs?: number;
    speechesPerDay?: number;
    exitProcess?: boolean;
    onShutdown?: (reason: string) => void;
}
export interface ServerHandle {
    port: number;
    url: string;
    shutdown(reason: string): Promise<void>;
    closed: Promise<string>;
}
/** 'hf:Qwen/Qwen3-4B-GGUF:Qwen3-4B-Q4_K_M.gguf' → 'Qwen3-4B-Q4_K_M.gguf' */
export declare function modelFileName(modelUri: string): string;
export declare function isModelDownloaded(modelUri: string, modelsDir: string): boolean;
/**
 * 解析實際模型檔路徑。
 * 精確檔名存在 → 直接使用；否則退回掃描 modelsDir 找第一個 .gguf
 * （node-llama-cpp 下載後實際檔名為 hf_ 前綴形式）。
 */
export declare function resolveModelPath(modelUri: string, modelsDir: string): string;
export declare function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, publicDir: string, modelReady: boolean): void;
export declare function findAvailablePort(start: number): Promise<number>;
export declare function openBrowser(url: string): void;
export interface WebSocketRegistryOptions {
    getState: () => GameState;
    zeroClientShutdownMs?: number;
    pingIntervalMs?: number;
    pingTimeoutMs?: number;
    onZeroClientsTimeout?: () => void;
    onLastClientLeave?: () => void;
}
export declare class WebSocketRegistry implements ClientRegistry {
    private readonly opts;
    private readonly clients;
    private zeroTimer;
    private pingTimer;
    constructor(wss: WebSocketServer, opts: WebSocketRegistryOptions);
    getConnectedPlayerIds(): number[];
    send(): void;
    sendSpectator(snapshot: SpectatorSnapshot): void;
    hasSpectators(): boolean;
    /** 測試用：目前連線數 */
    clientCount(): number;
    stop(): void;
    /** 關閉所有連線（shutdown 時） */
    closeAll(): void;
    private pushSnapshot;
    private onConnection;
    private onClientMessage;
    private onDisconnect;
    private pingCheck;
}
export declare function startServer(options?: ServerOptions): Promise<ServerHandle>;
//# sourceMappingURL=server.d.ts.map