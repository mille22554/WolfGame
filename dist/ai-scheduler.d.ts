/**
 * ai-scheduler.ts — SpeechScheduler（白板更新驅動迴圈＋AI 決策 flag 收斂）
 *
 * 迴圈（用戶定案）：
 * - 白板更新 → 開工生產（未就緒 AI 除上輪發言者外全員草稿；已就緒者不再草稿）＋ CD 重啟。
 * - 生產完成 → 暫存，不直接播。
 * - CD 到有貨 → 播出（播出即白板更新，迴圈回去）。
 * - CD 到沒貨 → 等做好馬上播。
 * - 中間白板又更新 → 暫存作廢＋生產用新白板重跑＋CD 重啟（版本作廢沿用）。
 * - 同一時間只有一條生產線＋一個暫存位，不會疊跑。
 * - 生產失敗 → N 秒後重試（預設 60s，env SPEECH_RETRY_MS 可調）；重試前不播出、不推進掛機計數。
 * - 純 AI 局：CD=0，做好就播（計時器保留，只是 0ms）。
 * - quiet 整組拔除；跳過按鈕（HUMAN_SKIP／allAliveHumansSkipped）保留但 scheduler 不再依賴。
 *
 * 收斂（第 2 項）：
 * - 每輪未就緒 AI 除上輪發言者外寫草稿；候選為空不生產，等真人講話；唯一候選不斷線。
 * - 草稿結尾 flag 兩層解析（正規＋寬鬆決策語境關鍵字，不用 LLM）；剝離統一在收草稿回傳前，
 *   broadcast 前再洗一次 expand 輸出；flag 永不進白板。
 * - 安全閥：單一 AI 連續 maxUncertainRounds（預設 50）次資訊不足 → 強制 decided:abstain。
 * - AI decided 且其發言成功播出後 → enqueue AI_READY_VOTE（不帶版本；單向不退；標的可變覆蓋）；
 *   transition 統一檢查全員 ready → 直進投票（無 CLOSING）。
 */
import type { AIScheduler } from './engine.js';
import type { FlagStats, GameState, SchedulerContext } from './types.js';
export type AIDecision = {
    status: 'decided';
    target: number | 'abstain';
} | {
    status: 'uncertain';
};
/** 安全閥：單一 AI 連續資訊不足次數上限（防卡死底線；只計真正資訊不足） */
export declare const MAX_UNCERTAIN_ROUNDS = 50;
/** 正規 flag：[決定:投P3]／[決定:殺P3]／[決定:棄票]／[決定:資訊不足]（方括號跳脫、全形/半形冒號、全域匹配） */
export declare const DECISION_FLAG_RE: RegExp;
export declare function normalizeTraditional(text: string): string;
/** 剝離 flag（全域，一律在收草稿回傳前＋broadcast 前各洗一次；含無方括號裸 flag 行尾） */
export declare function stripDecisionFlags(text: string): string;
/** 兩層解析：先正規，失敗走寬鬆關鍵字；都抓不到 → uncertain（計入安全閥） */
export declare function parseDecisionFlag(text: string): AIDecision;
/** grounding 黑名單種子：命中草稿文本即判違規（新制單次：拒收＋記賬＋棄權，無重試；哲學：首夜保護優先，後夜誤傷接受） */
export declare const GROUNDING_VIOLATION_SEEDS: string[];
/** 黑名單命中：回傳命中的種子，未命中回傳空字串（比對已正規化文本） */
export declare function findGroundingViolation(text: string): string;
/** 前科回寫：違規版（只帶最近一次被退；禁換皮重述） */
export declare function buildViolationRetryNote(prevDraft: string, hitSeed: string, isFirstNight: boolean): string;
/** 前科回寫：格式版（旗標解析 miss／缺旗標的重試；附正確範例） */
export declare function buildFormatRetryNote(prevDraft: string): string;
/** 狼草稿拒收檢查結果 */
export interface WolfRejection {
    kind: 'grounding' | 'format' | 'lang' | 'target';
    hit: string;
    note: string;
}
/** 英文超標：ASCII 字母占比過半即拒（全英文拒、中英夾雜不過半放行） */
export declare function isEnglishHeavy(text: string): boolean;
/** 前科回寫：英文版（英文超標／簡體混入共用；附格式提醒；pre 加自狀態指引，expand 不帶） */
export declare function buildLangRetryNote(prevDraft: string, selfState?: boolean): string;
/** 前科回寫：自指版（附格式提醒） */
export declare function buildTargetRetryNote(prevDraft: string, playerId: number): string;
/** 非法狼目標：自己／同盟／不存在或死亡 → 回傳 hit 說明，通過回傳空字串 */
export declare function illegalWolfTarget(st: GameState, playerId: number, targetId: number): string;
/** 首夜捏造檢查：首夜出現昨晚的行動／行為／表現／發言、或白天持續行為描述即判虛構（後夜有公開紀錄不攔） */
export declare function findFirstNightFabrication(text: string): string;
/** 簡體攔截：原文與正規化後不同即拒（回傳前科 note，空字串表通過） */
export declare function simplifiedRejection(rawRaw: string): string;
/** 英文短詞檢查：整詞命中回傳該詞，未命中回傳空字串 */
export declare function findEnglishWord(text: string): string;
/** 狼草稿拒收檢查：回傳前科回寫（含 kind/hit 供賬本），null 表通過 */
export declare function checkWolfDraft(raw: string, st: GameState, pid: number): WolfRejection | null;
/** expand 違規檢查：seed→fab（僅首夜）→eng 三層；回傳 kind/hit，null 表通過 */
export declare function checkExpandViolation(raw: string, firstNight: boolean): {
    kind: 'grounding' | 'lang';
    hit: string;
} | null;
/** 賬本一行：拒收確定後記一筆；fixed 表重試是否改過自新 */
export interface PrecedentEntry {
    t: number;
    game: string;
    meeting: string;
    phase: string;
    kind: string;
    hit: string;
    who: string;
    text: string;
    fixed: boolean;
}
/** 賬本上限行數（舊制殘留，新制無上限不使用；保留匯出免壞外部呼叫） */
export declare const PRECEDENTS_CAP = 500;
/** 賬本檔名（<dataDir> 下；已 gitignore） */
export declare const PRECEDENTS_FILE = "precedents.jsonl";
/** 賬本路徑（可注入；預設 <dataDir>/precedents.jsonl） */
export declare function precedentsFile(dataDir?: string): string;
/** 賬本讀取（缺檔／壞行容錯） */
export declare function readPrecedents(file?: string): PrecedentEntry[];
/** 賬本寫入（append-only 語義；無上限，只增不減） */
export declare function appendPrecedents(entries: PrecedentEntry[], file?: string): void;
/** 跨局 top-1：同 meeting＋同 phase 按 t 降冪（寫入序，不依賴文件序），own 優先、否則取最新 */
export declare function findCrossGamePrecedent(meeting: string, phase: string, persona: string, file?: string): PrecedentEntry | null;
/** 跨局每種一條：同 meeting＋同 phase 按 t 降冪，grounding／簡體／英文／target／format 各取最新 1 筆 */
export declare function findRecentPrecedentsByKind(meeting: string, phase: string, file?: string): PrecedentEntry[];
/** 跨局句（改版：不再引前句全文，防模板抄襲；target 分支抽象化） */
export declare function buildCrossGameNote(entry: PrecedentEntry): string;
export interface SpeechSchedulerOptions {
    cdMs?: number;
    retryMs?: number;
    preSpeechBatch?: number;
    preSpeechTemp?: number;
    judgeTemp?: number;
    expandTemp?: number;
    topK?: number;
    recentCompareCount?: number;
    maxUncertainRounds?: number;
    ledgerFile?: string;
}
interface Stash {
    playerId: number;
    text: string;
    boardVersion: number;
    decision: AIDecision;
}
interface Draft {
    slot: number;
    playerId: number;
    text: string;
    decision: AIDecision;
}
/** 草稿價值加分：decided＋具體數字目標 +3；內文含 P編號指名 +1（可疊加）；棄票／資訊不足 +0 */
export declare function draftValueBonus(draft: Draft): number;
/** 連播懲罰：當天白板近 N 則內該玩家每播出一次 −1（狼模式餵 wolfDiscussionLog 切片） */
export declare function repeatPenalty(playerId: number, recentSpeakerIds: number[]): number;
export declare class SpeechScheduler implements AIScheduler {
    private readonly ctx;
    private readonly options;
    private stopped;
    private lastSeenBoardVersion;
    private lastDay;
    private prodToken;
    private producing;
    private stash;
    private cdReady;
    private cdTimer;
    private retryTimer;
    private uncertainCounts;
    private decisions;
    private readonly gameId;
    private groundingStreak;
    constructor(ctx: SchedulerContext, options?: SpeechSchedulerOptions);
    onPhaseEntered(state: GameState): void;
    onBoardUpdated(state: GameState): void;
    /** 清除 timer（server 關閉時） */
    stop(): void;
    /** 供測試：目前暫存（有貨／無貨） */
    stashForTest(): Stash | null;
    /** 供測試：單一 AI 連續資訊不足次數 */
    uncertainCountForTest(playerId: number): number;
    /** 供測試：熔斷軌 grounding 連計 */
    groundingStreakForTest(): number;
    private resetCycle;
    private effectiveCdMs;
    private restartCd;
    private onCdFired;
    /** 草稿候選：存活 AI 除上輪發言者外全員（狼模式僅存活狼 AI）；為空 → 不生產（等真人）。
     *  已就緒（voteReady/wolfReady）者排除：已表態者不再草稿，降噪＋省算力＋加速收斂；
     *  收回就緒（人類）會重回候選。唯一候選時不斷線（避免單人僵局）。 */
    private candidateIds;
    private startProduction;
    private runProduction;
    /** 價值制選子：final＝judge分－新穎性＋價值－連播；取最高分，同分取 playerId 最小（不抽籤） */
    private selectWinner;
    /** 生產失敗 → N 秒後重試；重試前不播出（無暫存）、不推進掛機計數（transition 只在發言成功時計數） */
    private scheduleRetry;
    private collectPreSpeeches;
    /** 單候選 pre_speech（新制單次：首稿即唯一稿；違規記賬 fixed=false 後棄權；白天沿用舊流程） */
    private runPreSpeechCandidate;
    /** 單次棄權兜底：狼記 uncertain 不播出；白天回 null（不計安全閥） */
    private abstainPre;
    /** 賬本寫入（IO 失敗吞掉，不影響生產） */
    private recordPrecedents;
    /** expand 取文（新制單次：違規記賬 fixed=false 後回空退草稿；日間單發舊流程） */
    private fetchExpandText;
    /** 驗證狼襲擊目標合法性：存活、非自己、非狼同盟；不合法 → 視為棄票（狼放棄這票，不擋會議；夜晚結算另有過濾） */
    private validateWolfTarget;
    /** 決策更新：decided 覆蓋標的＋清空計數；資訊不足累計，達安全閥強制 decided:abstain */
    private updateDecision;
    /** GM 除錯用：每輪 AI 決策 flag 統計（每玩家最新決策，非累計筆數；決定投誰／棄票／資訊不足各幾筆） */
    flagStats(): FlagStats;
    private judge;
    /** CD 到有貨 → 播出；播出成功且 decided → enqueue AI_READY_VOTE（統一檢查由 transition 執行） */
    private broadcastStash;
}
export {};
//# sourceMappingURL=ai-scheduler.d.ts.map