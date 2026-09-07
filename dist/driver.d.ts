/**
 * 遊戲驅動器 — Phase 0：舊同步流程（runGame / runDiscussion / runVoting / runNight）已移除。
 * discuss / vote / night / play 的完整實作屬 Phase 1（LLM 驅動流程），此處僅留 stub。
 */
export declare function runDiscussion(): Promise<void>;
export declare function runVoting(): Promise<{
    voterId: number;
    targetId: number;
}[]>;
export declare function runNight(): Promise<Record<string, number>>;
export interface RunGameOptions {
    maxDays?: number;
    verbose?: boolean;
}
export declare function runGame(): Promise<never>;
//# sourceMappingURL=driver.d.ts.map