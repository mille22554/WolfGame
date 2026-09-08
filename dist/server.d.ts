/**
 * server.ts — Phase 1 單機 Web 全 AI 後端
 *
 * HTTP 靜態（public/）+ WebSocket（ws）+ 遊戲生命週期：
 * 模型檢查/下載進度 → WorkerDispatcher → engine + SpeechScheduler + WebSocketRegistry
 * → 全 AI 自動對戰 → 關閉機制（LEAVE / 斷線零連線兜底 / SIGINT/SIGTERM）
 */
import * as http from 'http';
import { WebSocketServer } from 'ws';
import type { GameState, GameEvent, LLMDispatcher, ClientRegistry, PlayerSnapshot, SpectatorSnapshot, LobbySnapshot } from './types.js';
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
    llamaServerPort?: number;
    llamaServerHost?: string;
    llamaServerCtxSize?: number;
    llamaServerThreads?: number;
    llamaServerParallel?: number;
    llamaServerIdleTimeout?: number;
    llamaServerRelease?: string;
    llamaServerBinDir?: string;
    llamaServerBinPath?: string;
}
export interface ServerHandle {
    port: number;
    url: string;
    shutdown(reason: string): Promise<void>;
    closed: Promise<string>;
}
export type ProviderMode = 'llama-server' | 'llamacpp' | 'mock' | 'openai';
export declare function resolveProviderMode(): ProviderMode;
/** 'hf:Qwen/Qwen3-4B-GGUF:Qwen3-4B-Q4_K_M.gguf' → 'Qwen3-4B-Q4_K_M.gguf' */
export declare function modelFileName(modelUri: string): string;
export declare function isModelDownloaded(modelUri: string, modelsDir: string): boolean;
/**
 * 解析實際模型檔路徑。
 * 精確檔名存在 → 直接使用；否則退回掃描 modelsDir 找第一個 .gguf
 * （node-llama-cpp 下載後實際檔名為 hf_ 前綴形式）。
 */
export declare function resolveModelPath(modelUri: string, modelsDir: string): string;
export interface ModelInfo {
    name: string;
    sizeMB: number;
}
/** 掃描 modelsDir 下的 .gguf 檔案（回傳 name + sizeMB，name 排序） */
export declare function listGgufModels(modelsDir: string): ModelInfo[];
/** 選定模型：檔名含 Qwen3-4B 優先，否則第一個；無模型 → null */
export declare function pickPreferredModel(names: string[]): string | null;
export declare function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, publicDir: string, _modelReady?: boolean): void;
export declare function findAvailablePort(start: number): Promise<number>;
export declare function openBrowser(url: string): void;
/** Phase 2：registry → engine/大廳的操作回呼（startServer 注入；大廳先於引擎存在） */
export interface RegistryActions {
    join(clientId: string, playerId: number, name?: string, prevToken?: string): {
        accepted: boolean;
        reason?: string;
        token?: string;
    };
    reconnect(clientId: string, token: string): {
        accepted: boolean;
        reason?: string;
        playerId?: number;
        token?: string;
        spectator?: boolean;
        name?: string;
    };
    spectate(clientId: string, playerId: number, token?: string): {
        accepted: boolean;
        reason?: string;
    };
    setName(clientId: string, playerId: number | undefined, token: string | undefined, name: string): {
        accepted: boolean;
        reason?: string;
        name?: string;
        token?: string;
    };
    setPlayerCount(clientId: string, count: number): {
        accepted: boolean;
        reason?: string;
    };
    setRandomCount(clientId: string, enabled: boolean): {
        accepted: boolean;
        reason?: string;
    };
    chat(clientId: string, playerId: number | undefined, text: string, token?: string): {
        accepted: boolean;
        reason?: string;
    };
    startLobbyGame(clientId: string): {
        accepted: boolean;
        reason?: string;
    };
    humanEvent(event: GameEvent): {
        accepted: boolean;
        reason?: string;
    };
    disconnectPlayer(playerId: number): void;
    isStarted(): boolean;
}
export interface WebSocketRegistryOptions {
    getState: () => GameState;
    zeroClientShutdownMs?: number;
    pingIntervalMs?: number;
    pingTimeoutMs?: number;
    onZeroClientsTimeout?: () => void;
    onLastClientLeave?: () => void;
    actions?: RegistryActions;
    ensureReady?: () => Promise<boolean>;
    getLobbySnapshot?: () => LobbySnapshot;
    onLobbySignal?: (clientId: string) => void;
    onClientLeave?: (clientId: string, playerId?: number) => void;
}
export declare class WebSocketRegistry implements ClientRegistry {
    private readonly opts;
    private readonly clients;
    private clientSeq;
    private zeroTimer;
    private pingTimer;
    constructor(wss: WebSocketServer, opts: WebSocketRegistryOptions);
    getConnectedPlayerIds(): number[];
    send(playerId: number, snapshot: PlayerSnapshot): void;
    sendSpectator(snapshot: SpectatorSnapshot): void;
    sendLobby(lobby: LobbySnapshot): void;
    hasSpectators(): boolean;
    /** 測試用：目前連線數 */
    clientCount(): number;
    stop(): void;
    /** 關閉所有連線（shutdown 時） */
    closeAll(): void;
    private pushSnapshot;
    private onConnection;
    private onClientMessage;
    private handleClientMessage;
    private onDisconnect;
    /**
     * 零連線關閉計時器：無 client 且尚未 armed 時啟動。
     * - 啟動時呼叫一次（主選單不開 WS 也能兜底：60 秒無連線 → no-clients 關閉 exe）。
     * - 逃生口：`zeroClientShutdownMs <= 0`（`ZERO_CLIENT_SHUTDOWN_MS=0`）時永不 armed，供 dev 使用。
     */
    armZeroTimerIfEmpty(): void;
    private pingCheck;
}
export declare function startServer(options?: ServerOptions): Promise<ServerHandle>;
export declare function main(): Promise<void>;
//# sourceMappingURL=server.d.ts.map