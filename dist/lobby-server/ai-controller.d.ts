import { type ChatMessage } from './llm.js';
import type { GameEngine, GamePlayer, NightStep, WolfSubphase } from './game.js';
export interface AiPlayerDef {
    clientId: string;
    nickname: string;
    characterId: string;
}
export declare const AI_DAY_CHECKPOINT_SCHEMA_VERSION = 1;
export type AiDayCheckpointStage = 'strategies' | 'drafts' | 'judge' | 'expand' | 'publish' | 'responses' | 'reconcile' | 'complete';
/** 白天 judge 批次槽位；只保存 clientId 與純文字，不保存 GamePlayer。 */
export interface AiDayDraftSlotCheckpoint {
    clientId: string;
    speech?: string;
    stance?: string;
}
export interface AiDaySpeakDraft {
    speech: string;
    stance: string;
}
/** 某一 published turn 中，每位回應者的完成狀態。 */
export interface AiDayResponseCheckpoint {
    clientId: string;
    turnId: string;
    status: 'pending' | 'ready' | 'speak' | 'wait';
    draft?: AiDaySpeakDraft;
}
/** 已選發言的發布身份；messageId/seq 來自 GameEngine 的 day message identity。 */
export interface AiDayPublishedCheckpoint {
    turnId: string;
    clientId: string;
    status: 'pending' | 'committed';
    messageId: string | null;
    messageSeq: number | null;
    /** 發布完成後這位 AI 的 ready 目標值；恢復時以 setDayReady 補 commit。 */
    readyValue: boolean;
}
export interface AiDayKnowledgeCheckpoint {
    clientId: string;
    role: string;
    displayName: string;
    partners: string[];
    madman: string | null;
    privateInfo: string;
    recentMessages: {
        from: string;
        text: string;
    }[];
}
/**
 * AI 白天討論 continuation snapshot。
 *
 * 契約：只支援 DAY_DISCUSSION；所有欄位皆為 JSON-safe plain data，不含 Promise、
 * timer、fetch、Map、CharacterProfile 或 GamePlayer 引用。
 */
export interface AiDayCheckpoint {
    schemaVersion: typeof AI_DAY_CHECKPOINT_SCHEMA_VERSION;
    day: number;
    phase: 'DAY_DISCUSSION';
    runId: string;
    stage: AiDayCheckpointStage;
    /** 本 checkpoint 對應的目前 game roster 與 AI 子集合。 */
    rosterClientIds: string[];
    aiClientIds: string[];
    strategyDone: string[];
    draftSlots: AiDayDraftSlotCheckpoint[];
    selectedClientId: string | null;
    expandedText: string | null;
    published: AiDayPublishedCheckpoint | null;
    responses: AiDayResponseCheckpoint[];
    /** character profile 的 memory 純文字；null 代表沒有載入 profile。 */
    profileMemory: Record<string, string | null>;
    knowledge: AiDayKnowledgeCheckpoint[];
    wolfBoard: {
        from: string;
        text: string;
    }[];
    masonBoard: {
        from: string;
        text: string;
    }[];
}
/**
 * 測試注入 seam；正式 server 不接線。正式路徑仍走既有 prompt／JSON parser。
 */
export interface AiDayLlmTestAdapter {
    strategy(clientId: string, day: number): Promise<string>;
    draft(clientId: string, day: number): Promise<{
        speech: string;
        stance: string;
        strategyUpdate?: string | null;
    }>;
    judge(speeches: string[], day: number): Promise<number>;
    expand(clientId: string, draftSpeech: string, day: number): Promise<string>;
    respond(clientId: string, publishedSpeech: string, day: number): Promise<{
        action: 'ready';
        strategyUpdate?: string | null;
    } | {
        action: 'speak';
        speech: string;
        stance: string;
        strategyUpdate?: string | null;
    } | {
        action: 'wait';
        strategyUpdate?: string | null;
    }>;
}
export interface AiLogEntry {
    ts: number;
    clientId: string;
    characterId: string;
    role: string;
    kind: 'WOLF_SPEECH' | 'JUDGE' | 'WOLF_STANCE' | 'WOLF_KILL' | 'SEER_CHECK' | 'GUARD_PROTECT' | 'MASON_TOGGLE' | 'MASON_SPEECH' | 'MASON_STANCE' | 'WOLF_ABORT' | 'DAY_STRATEGY' | 'DAY_SPEECH' | 'DAY_STANCE' | 'DAY_VOTE' | 'EXPAND';
    round: number;
    /** 第幾次嘗試（重試時 >1） */
    attempt: number;
    prompts: ChatMessage[];
    response: string | null;
    parsed: any;
}
/** AI 玩家的知識（由攔截的私訊／私頻訊息累積） */
export interface AiKnowledge {
    role: string;
    displayName: string;
    partners: string[];
    madman: string | null;
    privateInfo: string;
    recentMessages: {
        from: string;
        text: string;
    }[];
}
export declare class AiController {
    private entries;
    private game;
    private log;
    private destroyed;
    private timers;
    private phase;
    private day;
    /** 狼白板（本夜全部 WOLF_MESSAGE；每夜重置） */
    private wolfBoard;
    /** 白板游標：「最新一輪」= wolfBoard.slice(boardCursor)（judge 選完後推進） */
    private boardCursor;
    /** judge 選言序號（WOLF_SPEECH_SELECTED.round；本夜遞增） */
    private selectionSeq;
    /** wolf clientId -> 是否 toggle ready ON（由攔截的 WOLF_READY 訊息維護） */
    private wolfReadyMap;
    /** wolf clientId -> 當前 stance（"投XXX" / "資訊不足"） */
    private wolfStanceMap;
    /** 共有者白板（本夜全部 MASON_MESSAGE；每夜重置） */
    private masonBoard;
    /** 共有者 judge 選言序號（MASON_SPEECH_SELECTED.round；本夜遞增） */
    private masonSelectionSeq;
    /** mason clientId -> 是否 toggle ready ON（由攔截的 MASON_READY 訊息維護） */
    private masonReadyMap;
    /** mason clientId -> 當前 stance（"準備好了" / "資訊不足"） */
    private masonStanceMap;
    /** 白天公頻訊息（本天；AI 知識用） */
    private dayBoard;
    /** AI clientId -> 是否準備投票 ON；每次 resume 以 GameEngine 狀態為準重建。 */
    private dayReadyMap;
    /** false 時 PHASE_CHANGED(DAY_DISCUSSION) 只追蹤 phase/day，不清 state、不啟動。 */
    private phaseStartEnabled;
    private dayContinuation;
    private dayContinuationEpoch;
    private dayRunCounter;
    private dayTurnCounter;
    private dayResumePromise;
    private dayResumeEpoch;
    private dayResumeRunId;
    private readonly dayTestLlm;
    private readonly messageCap;
    constructor(defs: AiPlayerDef[], opts?: {
        messageCap?: number;
        dayTestLlm?: AiDayLlmTestAdapter;
    });
    /** 建立後由 harness 設定遊戲引擎 */
    setGame(game: GameEngine): void;
    isAi(clientId: string): boolean;
    /** 全部 LLM 互動記錄（依時間序） */
    getLog(): AiLogEntry[];
    /** resume 用：把前段存檔的 AI log 縫回（跨段報告需完整流程） */
    restoreLog(entries: AiLogEntry[]): void;
    /** 該 AI 的知識快照（供報告／除錯） */
    getKnowledge(clientId: string): AiKnowledge | null;
    /** restore barrier：false 時只記錄 PHASE_CHANGED，不重置或自動啟動白天 loop。 */
    setPhaseStartEnabled(enabled: boolean): void;
    /** 匯出可 JSON round-trip 的 DAY_DISCUSSION continuation；不匯出任何 live runtime handle。 */
    exportDayCheckpoint(): AiDayCheckpoint | null;
    /**
     * 驗證並 hydrate DAY_DISCUSSION checkpoint；任何 schema/day/phase/roster 不合法都 safe no-op。
     * 此方法刻意不啟動 loop；完成 game restore → import → resume 的呼叫端須明確呼叫 resumeDayDiscussion。
     */
    importDayCheckpoint(snapshot: AiDayCheckpoint): void;
    /** 明確啟動／續跑；同一 continuation 已有 in-flight run 時回傳同一 Promise（single-flight）。 */
    resumeDayDiscussion(): Promise<void>;
    /** 取消進行中的重試排程（進行中的 fetch 無法中斷，但其結果會被丟棄） */
    destroy(): void;
    private invalidateDayRun;
    private nextDayRunId;
    private createDayContinuation;
    private isCurrentDayRun;
    private cloneDayDraftSlot;
    private cloneDayResponse;
    private rebuildDayStateFromGame;
    /** 先完整驗證並建立副本；驗證成功前不碰 controller live state。 */
    private prepareDayCheckpoint;
    private sameUniqueClientSet;
    private uniqueStringsAreIn;
    private validBoardSnapshot;
    onNightStepActive(step: NightStep, players: GamePlayer[]): void;
    onWolfSubphaseChange(subphase: WolfSubphase, round: number): void;
    handlePrivate(clientId: string, msg: any): void;
    handleBroadcast(msg: any, targetClientIds?: string[]): void;
    /** 狼會議 DISCUSSION：全狼獨立出草稿 → loop（judge 盲選發布 → 其他狼回應 → 收斂判斷） */
    private runWolfDiscussion;
    /** 所有狼獨立出草稿（平行 LLM 呼叫；互不可見；失敗的狼跳過） */
    private generateAllDrafts;
    /** 組裝 judge 盲評 prompt：system「你是裁判，全盲評分以下發言，不考慮作者」；user 列出所有 speech（編號，不標作者），要求 JSON 回 {"scores":[...],"best":index} */
    private buildJudgePrompts;
    /** Judge 盲評（LLM）：給所有 speech 打分（1-10），回最高分的 index；LLM 失敗 → 隨機 fallback（不阻塞）。
     *  LLM 呼叫本身由 llmWithRetry 記錄 log。 */
    private judgeScoreIndex;
    /** Judge 盲選一篇草稿（LLM 全盲評分，不告知作者）→ 回選中的 draft */
    private judgePickDraft;
    /** 發布稿 stance 正規化（對齊 spec §12.3：stance 只有「投XXX」或「資訊不足」二值）：
     *  發布稿或草稿原文任一已明確點名刀人目標時，視為已承諾——補上「投<目標>」；沒有目標才維持原樣（資訊不足）。 */
    private normalizePublishedStance;
    /** 非發言者狼讀白板後回應：vote / speak / wait */
    private wolfRespond;
    /** 狼會議 VOTING：每隻 AI 狼 LLM 選刀人目標 → 提交 WOLF_KILL（全併發） */
    private runWolfVoting;
    /** 共有者會議：雙共有者獨立出草稿 → loop（judge 盲選發布 → 另一人回應 → 收斂判斷） */
    private runMasonDiscussion;
    /** 所有共有者獨立出草稿（平行 LLM 呼叫；互不可見；失敗的跳過） */
    private generateMasonDrafts;
    /** Judge 盲選一篇共有者草稿（LLM 全盲評分，同 wolf judge）→ 回選中的 draft */
    private judgePickMasonDraft;
    /** 非發言者共有者讀白板後回應：vote / speak / wait */
    private masonRespond;
    /** 展開 prompt：把選中的行動筆記（草稿要點）展開成該角色真正會說的話；輸出 {"speech":"完整發言"} */
    private buildExpandPrompts;
    /** 展開：LLM 把選中的草稿要點展開成完整發言（llmWithRetry 內建 3 次重試）；全失敗 → fallback 用草稿原文，不阻塞會議 */
    private expandSpeech;
    /** 白天策略：只補 strategyDone 缺漏者；每個完成即 commit。 */
    private generateDayStrategies;
    /** 依角色生成策略 prompt */
    private buildStrategyPrompt;
    /** 可恢復白天 loop：所有階段都以 controller field 為 checkpoint source of truth。 */
    private runDayDiscussion;
    /** 白天投票：每個 AI 玩家 LLM 決定投誰（或棄票）→ 提交 CAST_VOTE */
    private runDayVoting;
    private logEntry;
    private sleep;
    /** 呼叫 LLM 並解析；失敗（null / parse 失敗 / 抽取不到值）重試，最多 3 次、間隔 2s */
    private llmWithRetry;
    /** displayName（LLM 回傳的中文名）→ clientId；對照不到回 null（觸發重試） */
    private resolveClientId;
    /** nickname → 存活的狼玩家（WOLF_SPEECH_SELECTED.from 是 nickname） */
    private resolveWolfByNickname;
    private characterIdOf;
    private getAiWolves;
    private getAiMasons;
    private getAiAlivePlayers;
    private isWolfReady;
    private isMasonReady;
    /** 引擎是否已因安全上限停止狼會議 */
    private isAborted;
    private buildSystemPrompt;
    /** 追加到 AI 的全局 memory（跨階段不重置；4000 字上限，超出砍最舊） */
    appendMemory(clientId: string, text: string): void;
    /** 狼白板歷史（prompt 用；無則提示沒有討論） */
    private wolfBoardText;
    /** 共有者白板歷史（prompt 用；無則提示沒有討論） */
    private masonBoardText;
    /** 可刀目標（排除自己、狼隊、狂人） */
    private eligibleTargets;
    /** 狼 wolf 情境（system prompt 附加：Two-Level Split 結構） */
    private wolfContext;
    /** 共有者情境（system prompt 附加：Two-Level Split，與 wolfContext 同構；V8） */
    private masonContext;
    /** 白天情境（system prompt 附加：Two-Level Split，全角色共用；與 wolfContext/masonContext 同構） */
    private dayContext;
    /** 草稿 prompt（獨立出稿：speech + stance）；輸出 {"speech":"...", "stance":"投XXX"|"資訊不足"} */
    private buildDraftPrompts;
    /** 回應 prompt（非發言者狼讀白板後回應）；輸出 {"action":"vote","target":"..."} 或 {"action":"speak","speech":"...","stance":"..."} 或 {"action":"wait"} */
    private buildResponsePrompts;
    /** 共有者草稿 prompt（獨立出稿：speech + stance）；輸出 {"speech":"...", "stance":"準備好了"|"資訊不足"} */
    private buildMasonDraftPrompts;
    /** 共有者回應 prompt（非發言者讀白板後回應）；輸出 {"action":"vote","target":"ready"} 或 {"action":"speak","speech":"...","stance":"..."} 或 {"action":"wait"} */
    private buildMasonResponsePrompts;
    /** 白天討論草稿 prompt；輸出 {"speech":"...", "stance":"準備好了"|"資訊不足"} */
    private buildDayDraftPrompts;
    /** 白天討論回應 prompt；輸出含 strategy_update + action(ready/speak/wait) */
    private buildDayResponsePrompts;
    /** 狼刀目標選擇 prompt（狼隊同夥 + 可刀目標 + 討論歷史；輸出 {"target":"<displayName>"}） */
    private buildWolfKillPrompts;
    /** 白天投票 prompt；輸出 {"target":"<displayName>"} 或 {"target":null}（棄票） */
    private buildDayVotePrompts;
    /** 占い／守衛目標選擇 prompt（角色 + 存活玩家 + 過去行動；輸出 {"target":"<displayName>"}） */
    private buildTargetPrompts;
    /** 占い／守衛：LLM 選目標 → 提交夜間行動（失敗重試；最終失敗跳過、不阻塞） */
    private runTargetAction;
    /** 依 game roster 順序建立 draft slots；完成先回來也不改變 judge 順序。 */
    private ensureDraftSlots;
    private completedDayDrafts;
    private resetDayJudgeState;
    /** 草稿 LLM：placeholder 先保留順序；每個成功結果立即寫回自己的 slot。 */
    private generateDayDrafts;
    /** Judge 盲選一篇白天草稿（LLM 全盲評分；test adapter 只在測試注入時存在）。 */
    private judgePickDayDraft;
    private expandDaySpeech;
    /** 發布 identity 與 ready 目標同 tick commit；resume 看 committed state 不重送。 */
    private publishSelectedDayDraft;
    /** 已完成 response 不再叫 LLM；speak draft 依 aiPlayers 輸入順序組成下一個 judge batch。 */
    private runDayResponses;
    /** 使用 engine ready truth 的 idempotent setter；絕不 replay toggle。 */
    private commitDayReady;
    private forceAiDayReady;
    /** 非發言者 AI 讀白板後回應；memory/ready commit 交由 caller 立即落 continuation state。 */
    private dayRespond;
}
//# sourceMappingURL=ai-controller.d.ts.map