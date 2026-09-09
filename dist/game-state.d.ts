/**
 * Game State Manager — Phase 0 純事件驅動狀態機
 *
 * - 所有狀態變更經由 `transition(state, event)` 單一入口（純函式：原地 mutate，
 *   開 gate 時 deadline: 0，timer 由 engine 在 phase entry 時設定）
 * - I/O 副作用（timer、LLM 分派、廣播、存檔）一律以 Effect 回傳，由 engine 執行
 * - 夜晚結算唯一來源：night.ts resolveNightActions
 * - 平票 = 無人出局（全系統唯一規則）
 */
import { GameState, Team, Phase, GameEvent, PlayerSnapshot, GMSnapshot, SpectatorSnapshot, LobbySnapshot, TransitionResult, Effect } from './types.js';
export declare function createGameState(playerCount: number, humanPlayerIndices?: number[]): GameState;
/** Phase 2：全存活真人皆已跳過發言（無真人 → false） */
export declare function allAliveHumansSkipped(state: GameState): boolean;
/** Phase 2：大廳 snapshot */
export declare function buildLobbySnapshot(state: GameState): LobbySnapshot;
/** 統一收斂檢查：所有存活玩家（真人 + AI）皆在 voteReady → 直進投票（不經 CLOSING） */
export declare function allAlivePlayersReady(state: GameState): boolean;
/** 掛機接管門檻：未定真人在連續 N 次 AI 發言無活動後視為掛機（transition 計數、engine 執行接管） */
export declare const IDLE_TAKEOVER_THRESHOLD = 10;
/** 掛機接管執行（engine 在 IDLE_TAKEOVER effect 到達時呼叫；沿用斷線路徑語義） */
export declare function applyIdleTakeover(state: GameState, playerId: number): Effect[];
export declare function transition(state: GameState, event: GameEvent): TransitionResult;
export declare function getNightActors(state: GameState): number[];
export declare function getMediumResults(state: GameState): {
    targetId: number;
    team: Team;
    day: number;
}[];
export declare function buildPlayerSnapshot(state: GameState, playerId: number): PlayerSnapshot;
export declare function buildSpectatorSnapshot(state: GameState): SpectatorSnapshot;
export declare function buildGMSnapshot(state: GameState): GMSnapshot;
export declare function saveState(state: GameState): void;
export declare function loadState(): GameState | null;
export declare const AUTO_ADVANCE_PHASES: Phase[];
//# sourceMappingURL=game-state.d.ts.map