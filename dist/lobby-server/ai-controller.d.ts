import { type ChatMessage } from './llm.js';
import type { GameEngine, GamePlayer, NightStep, WolfSubphase } from './game.js';
export interface AiPlayerDef {
    clientId: string;
    nickname: string;
    characterId: string;
}
export interface AiLogEntry {
    ts: number;
    clientId: string;
    characterId: string;
    role: string;
    kind: 'WOLF_SPEECH' | 'JUDGE' | 'WOLF_STANCE' | 'WOLF_KILL' | 'SEER_CHECK' | 'GUARD_PROTECT' | 'MASON_TOGGLE' | 'MASON_SPEECH' | 'MASON_STANCE' | 'WOLF_ABORT' | 'DAY_STRATEGY';
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
    /** AI clientId -> 是否 toggle 準備投票 ON */
    private dayReadyMap;
    private readonly messageCap;
    constructor(defs: AiPlayerDef[], opts?: {
        messageCap?: number;
    });
    /** 建立後由 harness 設定遊戲引擎 */
    setGame(game: GameEngine): void;
    isAi(clientId: string): boolean;
    /** 全部 LLM 互動記錄（依時間序） */
    getLog(): AiLogEntry[];
    /** 該 AI 的知識快照（供報告／除錯） */
    getKnowledge(clientId: string): AiKnowledge | null;
    /** 取消進行中的重試排程（進行中的 fetch 無法中斷，但其結果會被丟棄） */
    destroy(): void;
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
    /** 白天開始時：每個 AI 依角色生成策略 → 寫入全局 memory（全併發） */
    private generateDayStrategies;
    /** 依角色生成策略 prompt */
    private buildStrategyPrompt;
    /** 白天討論：策略先行 → AI 輪流發言（judge 盲選）→ 收斂（全 AI toggle ON）後結束 */
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
    /** 共有者情境（system prompt 附加：共有者夥伴 + 私頻說明） */
    private masonContext;
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
    /** 所有 AI 獨立出草稿（全併發 LLM 呼叫） */
    private generateDayDrafts;
    /** Judge 盲選一篇白天草稿（LLM 全盲評分） */
    private judgePickDayDraft;
    /** 非發言者 AI 讀白板後回應：ready / speak / wait */
    private dayRespond;
}
//# sourceMappingURL=ai-controller.d.ts.map