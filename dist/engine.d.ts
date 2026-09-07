/**
 * GameEngine — Phase 0 事件佇列 + I/O 副作用
 *
 * - 佇列：enqueue → drain 同步處理（避免 async 競態）
 * - transition 的 Effect 由 engine 執行：BROADCAST / SAVE / ARM_GATE / DISPATCH_LLM / ENQUEUE
 * - phase 變更立即 flushSave；其餘 SAVE debounce（預設 5s）
 * - gate timer 到期 → enqueue ACTION_TIMEOUT
 */
import type { GameState, GameEvent, PlayerSnapshot, Phase } from './types.js';
export interface EngineOptions {
    mode: 'gm' | 'web';
    nightTimeoutMs?: number;
    voteTimeoutMs?: number;
    closingTimeoutMs?: number;
    llm?: LLMDispatcher;
    scheduler?: AIScheduler;
    registry?: ClientRegistry;
    saveDebounceMs?: number;
}
export interface LLMDispatcher {
    requestNightAction(playerId: number, prompt: string): Promise<{
        targetId: number;
    }>;
    requestVote(playerId: number, prompt: string): Promise<{
        targetId: number;
    }>;
    requestSpeech(playerId: number, prompt: string): Promise<{
        text: string;
    }>;
}
export interface AIScheduler {
    onBoardUpdated(state: GameState): void;
    onPhaseEntered(state: GameState): void;
}
export interface ClientRegistry {
    getConnectedPlayerIds(): number[];
    send(playerId: number, snapshot: PlayerSnapshot): void;
}
export declare class GameEngine {
    private state;
    private readonly options;
    private readonly queue;
    private gateTimer;
    private saveTimer;
    private draining;
    constructor(options: EngineOptions, initialState?: GameState);
    enqueue(event: GameEvent): void;
    /** 同步處理佇列（含級聯 ENQUEUE 的內部事件） */
    drain(): void;
    /** 單一事件處理（transition + effects + phase 變更收尾） */
    handleEvent(event: GameEvent): void;
    getState(): GameState;
    /** 立即寫檔（flushSave） */
    save(): void;
    /** 釋放 timer（測試 / 程序結束用） */
    close(): void;
    private processEvent;
    /** phase entry 副作用：gate timer、LLM 分派、摘要推進 */
    onPhaseEntered(state: GameState): void;
    private broadcastSnapshots;
    private scheduleSave;
    private timeoutFor;
    private armGate;
    private dispatchLLM;
    /** 供測試：目前排隊事件數 */
    pendingCount(): number;
    /** 供測試：目前 phase */
    currentPhase(): Phase;
}
//# sourceMappingURL=engine.d.ts.map