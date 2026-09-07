/**
 * worker-dispatcher.ts — WorkerDispatcher（LLMDispatcher 實作）
 *
 * - 管理 worker 生命週期：spawn、READY 等待、崩潰偵測、重啟
 * - job 佇列與 pending map；崩潰時已送出的 job 重試（≤ maxRetries）
 * - 僅 INIT 前崩潰（未 READY）視為啟動失敗：start() reject，不自動重啟
 */
import type { LLMDispatcher, GenerationConfig, WorkerJob } from './types.js';
export interface WorkerDispatcherOptions {
    modelPath: string;
    contextSize?: number;
    contextCount?: number;
    maxRetries?: number;
}
export declare const KIND_DEFAULTS: Record<WorkerJob['kind'], {
    temperature: number;
    maxTokens: number;
}>;
/** 取文字中最後一個 P{編號}；無 → throw */
export declare function parseTargetId(text: string): number;
export declare class WorkerDispatcher implements LLMDispatcher {
    private readonly options;
    private worker;
    private ready;
    private shuttingDown;
    private startResolve;
    private startReject;
    private readonly pending;
    constructor(options: WorkerDispatcherOptions);
    /** spawn worker + 等 READY */
    start(): Promise<void>;
    private spawn;
    private onMessage;
    private onCrash;
    private submit;
    generate(prompt: string, config?: GenerationConfig): Promise<string>;
    requestSpeech(playerId: number, prompt: string): Promise<{
        text: string;
    }>;
    requestVote(playerId: number, prompt: string): Promise<{
        targetId: number;
    }>;
    requestNightAction(playerId: number, prompt: string): Promise<{
        targetId: number;
    }>;
    /** SHUTDOWN + terminate */
    shutdown(): Promise<void>;
    isHealthy(): boolean;
}
//# sourceMappingURL=worker-dispatcher.d.ts.map