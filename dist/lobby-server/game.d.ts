/**
 * game.ts — 單一房間的遊戲引擎（ubuntu 分支 M5 + stage 2 狼會議）
 *
 * 簡化 phase 狀態機：phase timer + 直接 state mutation（不用 event queue，見規格 §12.10）。
 *
 * 流程：ROLE_REVEAL(10s) → NIGHT(不限時，依序解鎖) → NIGHT_RESULT(10s) → DAY_DISCUSSION(不限時，toggle)
 *       → DAY_VOTING(不限時，等全員投票) → DAY_RESULT(10s) →（勝利判定）→ 下一夜... → GAME_OVER
 *
 * 規則（規格 §12）：
 * - NIGHT 依序解鎖：GUARD（Day2 起）→ MASON（雙共有者 toggle ON）→ WOLF（狼會議）→ SEER
 * - 狼會議（§12.3 連續對話制）：DISCUSSION（WOLF_CHAT 持續對話 + toggle ready）
 *   → 全 ready → VOTING（各狼投 WOLF_KILL）→ 明確多數 → 收斂；
 *   平票 → 回 DISCUSSION（ready 重置、round+1、broadcast WOLF_VOTE_SPLIT）
 *   白板累計 WOLF_MESSAGE_CAP（100）則未收斂 → 停止並 broadcast WOLF_MEETING_ABORTED（不自動收斂）
 * - 人狼不可殺狂人；狼刀取收斂的 wolfTargetId（平票絕不用先提交者/隨機，回討論）
 * - 守衛 Day1 不可行動；不可自護（自護 → 隨機改護他人）
 * - 占い師不可查自己
 * - 霊能者只在黎明得知「昨日」被票死者身分（夜殺不可知）
 * - 夜殺／票死：身分不公開
 * - 村勝：人狼全滅；狼勝：存活人狼數 ≥ 存活村人陣營數
 * - NIGHT 不限時：等待所有夜間步驟完成才結算（無 timeout 截斷）
 */
import { Role, Team, SeerResult } from '../types.js';
export type GamePhase = 'ROLE_REVEAL' | 'NIGHT' | 'NIGHT_RESULT' | 'DAY_DISCUSSION' | 'DAY_VOTING' | 'DAY_RESULT' | 'GAME_OVER';
/** NIGHT 內部依序解鎖的子步驟（規格 §12.3 結算順序） */
export type NightStep = 'GUARD' | 'MASON' | 'WOLF' | 'SEER';
/** 狼會議子階段：討論（WOLF_CHAT + toggle ready）→ 投票（WOLF_KILL） */
export type WolfSubphase = 'DISCUSSION' | 'VOTING';
export interface GamePlayer {
    clientId: string;
    nickname: string;
    role: Role;
    team: Team;
    alive: boolean;
    isMasonPartner: boolean;
    masonPartnerId?: string;
    wolfPartnerIds: string[];
    seerChecks: {
        targetId: string;
        result: SeerResult;
        day: number;
    }[];
    guardProtects: {
        targetId: string;
        day: number;
        success: boolean;
    }[];
}
export interface NightAction {
    actorClientId: string;
    type: 'WOLF_KILL' | 'SEER_CHECK' | 'GUARD_PROTECT';
    targetClientId: string;
}
export interface Vote {
    voterClientId: string;
    targetClientId: string | null;
}
/** 白天討論訊息：day/seq/id 讓存檔恢復後仍能保留順序與身份。 */
export interface DayMessage {
    from: string;
    text: string;
    day: number;
    seq: number;
    id: string;
}
export interface DeathRecord {
    clientId: string;
    nickname: string;
    day: number;
    cause: 'wolf_kill' | 'vote';
}
export interface GameState {
    phase: GamePhase;
    day: number;
    players: GamePlayer[];
    nightActions: NightAction[];
    votes: Vote[];
    deathHistory: DeathRecord[];
    winner: Team | null;
    /** 昨日被票出局者 clientId（霊能者黎明資訊用；每日投票開始時清除，避免隔天重送舊資訊） */
    lastVoteDeathClientId: string | null;
    /** 目前夜間步驟（非 NIGHT phase 時 null） */
    nightStep: NightStep | null;
    /** 本夜依序要走的步驟（依存活角色＋day 計算） */
    nightSteps: NightStep[];
    /** mason clientId -> 是否 toggle ON（雙人都 ON 才解鎖下一步） */
    masonReady: Map<string, boolean>;
    /** 存活玩家 clientId -> 是否 toggle「準備投票」ON（全部 ON 才進 DAY_VOTING） */
    dayReady: Map<string, boolean>;
    /** wolf clientId -> 是否 toggle ON（全 ready 才進 VOTING） */
    wolfReady: Map<string, boolean>;
    /** 狼會議子階段（非 WOLF step 時 null） */
    wolfSubphase: WolfSubphase | null;
    /** wolf clientId -> 投票目標 clientId（覆蓋式） */
    wolfVotes: Map<string, string>;
    /** 狼會議回合數（平票 +1） */
    wolfMeetingRound: number;
    /** 收斂後確定的刀人目標（平票時保持 null，回討論重來） */
    wolfTargetId: string | null;
    /** 白板累計 WOLF_MESSAGE 數（本夜；安全上限用） */
    wolfMessageCount: number;
    /** 狼會議已因安全上限停止（停止後不再受理 WOLF_CHAT / TOGGLE_WOLF_READY；不自動收斂） */
    wolfMeetingAborted: boolean;
    /** 白板訊息歷史（WOLF_MESSAGE 文字；存檔/恢復用） */
    wolfBoard: {
        from: string;
        text: string;
    }[];
    /** 白天討論訊息歷史（存檔/恢復用；AI 控制器接續用；正常新的一天會清空） */
    dayMessages: DayMessage[];
}
export interface GameCallbacks {
    /** 發送訊息給特定 client */
    sendTo(clientId: string, msg: object): void;
    /** 廣播：targetClientIds 未指定 → 全房成員；指定 → 只發給那些 clientIds（人狼私頻／共有者私頻） */
    broadcast(msg: object, targetClientIds?: string[]): void;
    /** 房間內所有 clientId（含觀戰者） */
    getAllClientIds?(): string[];
    /** 目前房主 clientId（END_DISCUSSION 驗證用；房間已不存在時回傳 undefined） */
    getHostClientId?(): string | undefined;
    /** NIGHT 子步驟激活（AI 控制器掛鉤：驅動該 step 的 AI 玩家行動） */
    onNightStepActive?(step: NightStep, players: GamePlayer[]): void;
    /** 狼會議子階段切換（AI 控制器掛鉤：DISCUSSION 跑管線、VOTING 驅動投票） */
    onWolfSubphaseChange?(subphase: WolfSubphase, round: number): void;
}
export declare class GameEngine {
    private roomCode;
    private players;
    private callbacks;
    private wolfMessageCap;
    private state;
    private timers;
    private countdownInterval?;
    /** 當日白天訊息序號；dayMessages 會因 50 則上限移出舊訊息。 */
    private dayMessageSeq;
    constructor(roomCode: string, players: {
        clientId: string;
        nickname: string;
    }[], callbacks: GameCallbacks, wolfMessageCap?: number);
    /** 開始遊戲：分配角色、私發 ROLE_REVEALED、進入 phase 循環 */
    start(): void;
    /** 處理夜間行動提交（依序解鎖：各行動只在對應 nightStep 時受理） */
    handleNightAction(clientId: string, action: {
        type: 'WOLF_KILL' | 'SEER_CHECK' | 'GUARD_PROTECT';
        targetClientId: string;
    }): void;
    /** 共有者 toggle 回合結束（開/關）；雙人都 ON → 解鎖下一步 */
    handleToggleMasonEndTurn(clientId: string): void;
    /** 人狼 toggle「準備投票」（開/關）；全 ready → 進入 VOTING */
    handleToggleWolfReady(clientId: string): void;
    /** 處理投票（targetClientId = null → 棄票） */
    handleVote(clientId: string, targetClientId: string | null): void;
    /** 房主提前結束討論 */
    handleEndDiscussion(clientId: string): void;
    /**
     * 設定某位存活玩家的白天準備狀態（idempotent）。
     *
     * 同一個 ready 值不會重複 broadcast，也不會再次觸發 phase transition；
     * 這是 restore／AI 重送時的安全入口。handleToggleVoteReady 仍保留原本的
     * toggle 語意，但委派到這個 setter。
     */
    setDayReady(clientId: string, ready: boolean): void;
    /** 玩家 toggle「準備投票」（ON/OFF 可切換，同狼會議 handleToggleWolfReady）；所有存活玩家皆 ON → 推進到 DAY_VOTING */
    handleToggleVoteReady(clientId: string): void;
    /**
     * 重新檢查白天準備狀態；restore 後可由呼叫端安全補做 phase progression。
     * 只在目前是 DAY_DISCUSSION 且所有存活玩家都已 ready 時推進到 DAY_VOTING；
     * 不改變 ready 值、不重複 toggle，也不額外廣播 DAY_READY_STATUS。
     */
    reconcileDayReady(): void;
    /** AI 白天發言（broadcast MESSAGE 到公頻；复用 lobby 的 MESSAGE 協議） */
    sendDayMessage(clientId: string, text: string): void;
    /** 人狼私頻（僅狼會議步驟可用、僅存活人狼可見）；累計訊息數，達安全上限 → 停止並報告 */
    handleWolfChat(clientId: string, text: string): void;
    /** 狼會議安全上限觸發：標記停止＋broadcast 報告（night 停在 WOLF step，由 harness 觀察 timeout 兜底） */
    private abortWolfMeeting;
    /** 廣播給所有存活人狼（AI 控制器用：WOLF_SPEECH_SELECTED 等） */
    broadcastToWolves(msg: object): void;
    /** 共有者私頻（僅 MASON step 可用、僅雙方可見） */
    handleMasonChat(clientId: string, text: string): void;
    /** 共有者會議：judge 選言發布（broadcast MASON_MESSAGE ＋ MASON_SPEECH_SELECTED，僅雙共有者可見） */
    publishMasonSpeech(speakerClientId: string, text: string, round: number): void;
    /** 清除所有 timer（房間回收時呼叫，避免孤兒 timer 讓 process 無法結束） */
    destroy(): void;
    /** 夜間狀態快照（供 harness / AI 控制器觀察狼會議進度） */
    getNightState(): {
        phase: GamePhase;
        day: number;
        nightStep: NightStep | null;
        wolfSubphase: WolfSubphase | null;
        wolfMeetingRound: number;
        wolfTargetId: string | null;
        wolfMessageCount: number;
        wolfMeetingAborted: boolean;
    };
    /** 全部玩家（AI 控制器用 nickname→clientId 對照 LLM 回傳的中文名） */
    getPlayers(): GamePlayer[];
    /** 序列化目前遊戲狀態（JSON-safe；用於存檔/分階段測試 resume） */
    saveState(): Record<string, unknown>;
    /** AI 控制器用：取得白天討論狀態（dayReady + dayMessages；回傳複本避免外部改寫核心狀態） */
    getDayState(): {
        dayReady: Map<string, boolean>;
        dayMessages: DayMessage[];
    };
    /**
     * 從存檔恢復狀態並直接進入 DAY_DISCUSSION（跳過 ROLE_REVEAL / NIGHT）。
     * 用於分階段測試：先跑 night 存檔，再 resume 只跑 day。
     *
     * 目前刻意只支援 DAY_DISCUSSION checkpoint：snapshot.phase 不會被恢復，
     * 也不會因此觸發 NIGHT／DAY_VOTING 的回呼或轉換。所有 day 事實會先完成
     * hydration，才透過 transitionTo 的 phase callback 對外通知。
     */
    restoreState(snapshot: Record<string, any>): void;
    private assignRoles;
    private transitionTo;
    /** 廣播目前存活玩家的 day ready 狀態；每次實際狀態變更只呼叫一次。 */
    private broadcastDayReadyStatus;
    /** 從 snapshot 物件／Map 還原 dayReady；缺少的存活玩家預設為 false。 */
    private normalizeDayReady;
    /** 取得下一個不與目前 day board 碰撞的訊息身份。 */
    private nextDayMessageIdentity;
    /** 將舊／新 dayMessages 正規化，補上 day、seq、id，但保留每則訊息（不依 from+text 去重）。 */
    private normalizeDayMessages;
    private makeDayMessageId;
    /** 排定一次性 timer（fire 後自動從清單移除） */
    private schedule;
    /** 倒數提醒：剩餘 <30s 時每 10s 發一次 PHASE_COUNTDOWN（60s phase → 20s、10s） */
    private startCountdown;
    private stopCountdown;
    /** 計算本夜依序要走的步驟（只含存活且該 day 有行動的角色） */
    private computeNightSteps;
    /** 激活目前夜間步驟：WOLF 步驟進入 DISCUSSION 子階段；通知 AI 控制器 */
    private activateNightStep;
    /** 該步驟對應的存活玩家 */
    private getStepPlayers;
    /** 目前步驟完成 → 推進下一步；無下一步 → 結算夜間 */
    private completeNightStep;
    /** 所有存活共有者皆已 toggle ON */
    private allMasonsReady;
    /** 所有存活狼皆已 toggle ON */
    private allWolvesReady;
    /** 所有存活狼皆已提交 WOLF_KILL */
    private allWolvesVoted;
    /**
     * 狼投票計票（規格 §12.3）：
     * - 明確多數（2:1、3:0）→ 確定 wolfTargetId，完成 WOLF 步驟
     * - 平票（1:1、1:1:1）→ 回 DISCUSSION：ready 全重置、votes 清空、round+1、broadcast WOLF_VOTE_SPLIT
     */
    private resolveWolfVote;
    /** 夜間結算：守衛 → 人狼（收斂目標）→ 占い師 → 霊能者（黎明）；broadcast 結果後進 NIGHT_RESULT 或 GAME_OVER */
    private resolveNight;
    /** 守衛：記錄護衛目標（自護 → 隨機改護他人，防禦性處理）；回傳護衛目標（無則 null） */
    private applyGuard;
    /** 人狼：刀收斂的 wolfTargetId（== 護衛目標時由呼叫方判定平安夜）；回傳被殺玩家（無則 null） */
    private applyWolfKill;
    /** 占い師：查驗結果記錄並只發給占い師 */
    private applySeerResult;
    /** 黎明：霊能者得知昨日被票死者身分（Day1 無） */
    private sendDawnInfo;
    /** 廣播夜間結果：NIGHT_RESULT、GUARD_RESULT（私發）、PLAYER_ELIMINATED */
    private broadcastNightResult;
    /** 投票結算：票最高者出局（平票 → 無人出局）；broadcast 結果後進 DAY_RESULT 或 GAME_OVER */
    private resolveVotes;
    /** 村勝：存活人狼 == 0；狼勝：存活人狼 ≥ 存活村人陣營（含狂人） */
    private checkWin;
    private getAlivePlayers;
    private getAliveWolves;
    private getAliveVillagers;
    private getPlayerByClientId;
}
//# sourceMappingURL=game.d.ts.map