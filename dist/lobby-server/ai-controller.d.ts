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
    kind: 'WOLF_SPEECH' | 'JUDGE' | 'WOLF_STANCE' | 'WOLF_KILL' | 'SEER_CHECK' | 'GUARD_PROTECT' | 'MASON_TOGGLE' | 'WOLF_ABORT';
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
    private readonly llmTimeoutMs;
    /** 狼白板（本夜全部 WOLF_MESSAGE；每夜重置） */
    private wolfBoard;
    /** 白板游標：「最新一輪」= wolfBoard.slice(boardCursor)（judge 選完後推進） */
    private boardCursor;
    /** judge 選言序號（WOLF_SPEECH_SELECTED.round；本夜遞增） */
    private selectionSeq;
    /** wolf clientId -> 是否 toggle ready ON（由攔截的 WOLF_READY 訊息維護） */
    private wolfReadyMap;
    constructor(defs: AiPlayerDef[], opts?: {
        llmTimeoutMs?: number;
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
    /** 狼會議 DISCUSSION：0 全狼發一句 → loop（0.5 judge 選言 → 1 表態 → 分歧接著聊）直到全 ready 或停止 */
    private runWolfDiscussion;
    /** 狀態 0／2：單隻狼發一句（LLM 生成；失敗重試，最終失敗跳過不阻塞） */
    private wolfSpeak;
    /** 狀態 0.5：judge 全盲評分「最新一輪」發言、選最高分 → broadcast WOLF_SPEECH_SELECTED（回選中發言；無新訊息回 null） */
    private judgeSelect;
    /** 狀態 1：代表狼 toggle ready；其他未 ready 狼表態（接受→ready；反對→接著聊；失敗→跳過） */
    private runStancePhase;
    /** 狼會議 VOTING：每隻 AI 狼 LLM 選刀人目標 → 提交 WOLF_KILL（失敗重試；最終失敗跳過、不阻塞） */
    private runWolfVoting;
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
    private isWolfReady;
    /** 引擎是否已因安全上限停止狼會議 */
    private isAborted;
    private buildSystemPrompt;
    /** 狼白板歷史（prompt 用；無則提示沒有討論） */
    private wolfBoardText;
    /** 可刀目標（排除自己、狼隊、狂人） */
    private eligibleTargets;
    /** 狼 wolf 情境（system prompt 附加：狼隊同夥 + 狂人 + 私頻說明） */
    private wolfContext;
    /** 狀態 0／2 發言 prompt（首句：獨立提案，看不到隊友；接著聊：回應隊友）；輸出 {"speech"} */
    private buildWolfSpeechPrompts;
    /** 狀態 1 表態 prompt（代表狼發言＋對話；輸出 {"accept":bool, "speech"?:...}） */
    private buildWolfStancePrompts;
    /** 狼刀目標選擇 prompt（狼隊同夥 + 可刀目標 + 討論歷史；輸出 {"target":"<displayName>"}） */
    private buildWolfKillPrompts;
    /** 占い／守衛目標選擇 prompt（角色 + 存活玩家 + 過去行動；輸出 {"target":"<displayName>"}） */
    private buildTargetPrompts;
    /** 占い／守衛：LLM 選目標 → 提交夜間行動（失敗重試；最終失敗跳過、不阻塞） */
    private runTargetAction;
}
//# sourceMappingURL=ai-controller.d.ts.map