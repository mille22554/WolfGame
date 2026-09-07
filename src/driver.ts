/**
 * 遊戲驅動器 — Phase 0：舊同步流程（runGame / runDiscussion / runVoting / runNight）已移除。
 * discuss / vote / night / play 的完整實作屬 Phase 1（LLM 驅動流程），此處僅留 stub。
 */

export async function runDiscussion(): Promise<void> {
  throw new Error('Phase 1 實作');
}

export async function runVoting(): Promise<{ voterId: number; targetId: number }[]> {
  throw new Error('Phase 1 實作');
}

export async function runNight(): Promise<Record<string, number>> {
  throw new Error('Phase 1 實作');
}

export interface RunGameOptions {
  maxDays?: number;
  verbose?: boolean;
}

export async function runGame(): Promise<never> {
  throw new Error('Phase 1 實作');
}
