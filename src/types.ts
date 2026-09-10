/**
 * Werewolf Game Types — Phase 0 事件驅動狀態機型別層
 *
 * - Role / Team / SeerResult / MediumResult / NightActionType / ROLE_CONFIG 等沿用現有定義
 * - Phase 改為扁平 string union（9 值）；GameState / Player 改為事件驅動形狀
 * - GameState 另含 night.ts 相容欄位（nightActions / wolfKillTarget / guardProtectedTarget /
 *   seerCheckTarget / seerCheckResult）與 masonChatLog、expectedPlayerCount（規格缺口補位，見 game-state.ts）
 */

import { Personality } from './personalities.js';

// ============================================
// Schema
// ============================================

export const SCHEMA_VERSION = 4;

// ============================================
// Phase（扁平，10 值）
// ============================================

export type Phase =
  | 'SETUP_WAITING_JOIN'      // 等待玩家加入
  | 'SETUP_READY'             // 人數足夠，可開始
  | 'NIGHT_DISCUSSION_OPEN'   // 狼人夜晚密談開放（僅狼可見）
  | 'NIGHT_COLLECTING'        // 夜晚，收集行動
  | 'NIGHT_RESOLVING'         // 夜晚行動結算
  | 'DAY_DISCUSSION_OPEN'     // 白天討論開放（自由發言；全員 ready 直進投票）
  | 'DAY_VOTING_COLLECTING'   // 收集投票
  | 'DAY_VOTING_RESOLVING'    // 投票結算
  | 'DAY_RESULT_ANNOUNCING'   // 公布處決結果
  | 'GAME_OVER_FINAL';        // 遊戲結束

// ============================================
// GameEvent（union，27 事件）
// ============================================

export type GameEvent =
  | { type: 'CLIENT_JOIN'; name: string }
  | { type: 'CLIENT_LEAVE' }
  | { type: 'START_GAME' }
  | { type: 'HUMAN_SPEAK'; playerId: number; text: string }
  | { type: 'HUMAN_SKIP'; playerId: number }
  | { type: 'HUMAN_READY_VOTE'; playerId: number }
  | { type: 'HUMAN_UNREADY_VOTE'; playerId: number }
  | { type: 'HUMAN_VOTE'; playerId: number; targetId: number }
  | { type: 'HUMAN_NIGHT_ACTION'; playerId: number; targetId: number }
  | { type: 'AI_SPEECH_DONE'; playerId: number; text: string; boardVersion: number }
  | { type: 'AI_WOLF_SPEECH_DONE'; playerId: number; text: string; boardVersion: number }   // 狼密談 AI 發言完成
  | { type: 'HUMAN_WOLF_SPEAK'; playerId: number; text: string }   // 狼密談真人發言
  | { type: 'AI_WOLF_READY'; playerId: number }   // 狼密談 AI 準備就緒
  | { type: 'HUMAN_WOLF_READY'; playerId: number }   // 狼密談真人準備就緒
  | { type: 'HUMAN_WOLF_UNREADY'; playerId: number }   // 狼密談真人取消就緒
  | { type: 'AI_VOTE_DONE'; playerId: number; targetId: number }
  | { type: 'AI_NIGHT_DONE'; playerId: number; targetId: number }
  | { type: 'MASON_CHAT'; playerId: number; text: string }
  | { type: 'ACTION_TIMEOUT'; gateId: string }   // gate 級，無 playerId
  | { type: 'DISCONNECT'; playerId: number }
  | { type: 'AI_READY_VOTE'; playerId: number }   // AI 草稿 decided → scheduler 在發言成功後 enqueue（不帶版本；單向不退）
  | { type: 'RESOLVE_NIGHT' }    // 內部：NIGHT_RESOLVING 結算完成
  | { type: 'RESOLVE_VOTES' }    // 內部：DAY_VOTING_RESOLVING 結算完成
  | { type: 'ADVANCE_DAY' }     // 內部：進入下一天
  | { type: 'HUMAN_JOIN'; playerId: number; name?: string }   // Phase 2：真人選座（大廳）
  | { type: 'AI_JOIN'; playerId: number }                      // Phase 2：伺服器填 AI 空位（大廳）
  | { type: 'RECONNECT'; playerId: number };                   // Phase 2：真人重連拿回身分

// ============================================
// PendingGate
// ============================================

export interface PendingGate {
  kind: 'night' | 'vote';
  required: number[];   // 需要行動的 playerId
  done: number[];       // 已完成行動的 playerId
  timeoutMs: number;
  deadline: number;     // engine 在 phase entry 時設定；transition 開 gate 時為 0
}

// ============================================
// Role Definitions（沿用現有）
// ============================================

export enum Role {
  VILLAGER = 'villager',           // 村民
  SEER = 'seer',                   // 占い師
  MEDIUM = 'medium',               // 靈能者
  GUARD = 'guard',                 // 獵人（守衛/狩人）
  MASON = 'mason',                 // 共有者
  WEREWOLF = 'werewolf',           // 人狼
  MADMAN = 'madman',               // 狂人
}

export enum Team {
  VILLAGE = 'village',             // 村人陣營
  WEREWOLF = 'werewolf',           // 人狼陣營
}

export enum NightActionType {
  WOLF_KILL = 'wolf_kill',
  SEER_CHECK = 'seer_check',
  GUARD_PROTECT = 'guard_protect',
}

export enum SeerResult {
  VILLAGER = 'villager',    // 村人 (includes Madman, Mason, Villager)
  WEREWOLF = 'werewolf',    // 人狼
}

export enum MediumResult {
  VILLAGER = 'villager',
  WEREWOLF = 'werewolf',
}

// ============================================
// Player & Game State
// ============================================

export interface Player {
  id: number;
  name: string;
  role: Role;
  team: Team;
  controlledBy: 'human' | 'ai';   // 取代 isHuman
  personality: string;            // Personality id（character/<id>/ 目錄名）
  alive: boolean;
  isMasonPartner?: boolean;
  // --- night.ts 相容欄位（夜晚結算唯一來源所需，玩家級歷史） ---
  seerChecks?: SeerCheck[];
  guardProtects?: GuardProtect[];
  masonPartnerId?: number;
}

export interface NightAction {
  type: NightActionType;
  targetId: number;
  actorId: number;
}

export interface SeerCheck {
  targetId: number;
  result: SeerResult;
  day: number;
}

export interface GuardProtect {
  targetId: number;
  day: number;
  success: boolean;
}

export interface Vote {
  voterId: number;
  targetId: number;
  day: number;
}

export interface DeathRecord {
  playerId: number;
  day: number;
  cause: 'vote' | 'wolf_kill' | 'suicide';
}

export interface DiscussionEntry {
  playerId: number;
  text: string;
  day: number;
}

export interface MasonChatEntry {
  playerId: number;
  text: string;
  day: number;
}

export interface GameState {
  schemaVersion: number;          // = SCHEMA_VERSION
  phase: Phase;
  day: number;
  players: Player[];
  humanPlayerIndices: number[];
  discussionLog: DiscussionEntry[];
  wolfDiscussionLog: DiscussionEntry[];   // 狼人夜晚密談記錄（僅狼可見）
  votes: Vote[];
  deathHistory: DeathRecord[];
  seerChecks: { seerId: number; targetId: number; result: Team; day: number }[];
  guardProtects: { guardId: number; targetId: number; day: number }[];
  winner: Team | null;
  gameOver: boolean;
  boardVersion: number;           // 白板版本號
  daySummaries: string[];         // 每天摘要（截斷用）
  voteReady: number[];            // 已準備投票的玩家（真人 + AI）
  wolfReady: number[];            // 狼密談已就緒的玩家（真人 + AI）
  skippedHumans: number[];        // Phase 2：當天已跳過發言的真人 playerId（保留：待用戶確認刪除）
  /** 掛機計數：playerId → 該真人未定期間的 AI 發言次數；任一真人發話／跳過／收回即清空，到 10 觸發接管 */
  idleCounts: Record<number, number>;
  /** 掛機接管中座位（controlledBy 已翻為 ai；區分原生 AI 與掛機接管；重連拿回時移除） */
  takenOver: number[];
  pendingGate: PendingGate | null;
  // --- 規格缺口補位（transition 純函式內使用，持久化） ---
  /** 大廳目標人數：CLIENT_JOIN 達標 → SETUP_READY 的依據 */
  expectedPlayerCount: number;
  /** 夜晚行動暫存（NIGHT_COLLECTING 收集 → NIGHT_RESOLVING 交 night.ts 結算） */
  nightActions: NightAction[];
  /** 共有者夜聊（MASON_CHAT 事件儲存，僅共有者 snapshot 可見） */
  masonChatLog: MasonChatEntry[];
  // --- night.ts 相容欄位（resolveNightActions 讀寫） ---
  wolfKillTarget?: number;
  guardProtectedTarget?: number;
  seerCheckTarget?: number;
  seerCheckResult?: SeerResult;
}

// ============================================
// Snapshot 型別
// ============================================

export interface PlayerSnapshot {
  phase: Phase;
  day: number;
  alivePlayers: { id: number; name: string }[];
  deadPlayers: { id: number; name: string; cause: string; day: number }[];
  nightResult: string | null;     // 昨晚結果（由 deathHistory 最後一筆 wolf_kill 推導）
  discussionLog: { playerId: number; text: string }[];
  votes: { voterId: number; targetId: number }[];
  winner: Team | null;
  gameOver: boolean;
  gateDeadline: number | null;   // Phase 2：pendingGate?.deadline ?? null（0 = 無 timer；前端倒數用）
  you: {
    role: Role;
    team: Team;
    seerChecks?: { targetId: number; result: Team; day: number }[];
    guardProtects?: { targetId: number; day: number }[];
    mediumResults?: { targetId: number; team: Team; day: number }[];  // 由 deathHistory 推導
    masonPartnerId?: number;
    masonChatLog?: { playerId: number; text: string }[];
    wolfDiscussionLog?: { playerId: number; text: string }[];   // 狼密談記錄（僅狼本人可見）
    wolfReady?: boolean;           // 狼密談：我是否已就緒（僅狼）
    wolfReadyIds?: number[];       // 狼密談：已就緒的存活狼（僅狼）
    wolfAllyIds?: number[];
    canAct?: boolean;            // Phase 2：目前是否輪到我行動：pendingGate 存在 && required 含我 && done 不含我
    takenOver: boolean;          // 掛機接管標記：true → 顯示「AI 接管中」panel＋拿回座位鈕（每次快照重算）
    wolfMeeting?: { wolfId: number; targetId: number }[];   // Phase 2：狼人會議目前提交（僅狼；由 nightActions 推導）
  };
}

/** Phase 2：大廳 snapshot（遊戲前 UI，唯一允許顯示 controlledBy 的介面，AI 永不看到） */
/** 等候大廳：引擎狀態（大廳 loading 角落＋LOBBY 內嵌，語意同 MODEL_STATUS） */
export interface EngineStatus {
  state: 'idle' | 'downloading' | 'starting' | 'ready' | 'error';
  stage?: 'llama-server' | 'model';
  downloaded?: number;
  total?: number;
  info?: string;
  error?: string;
}

export interface LobbySnapshot {
  phase: Phase;
  expectedPlayerCount: number;
  seats: { playerId: number; name: string; controlledBy: 'ai' | 'human' | 'empty'; disconnected?: boolean }[];
  started: boolean;   // phase 非 SETUP_* 即 true
  /** 等候大廳擴充：目前座位格數（randomCount 時仍為格數，實際人數開局才擲出） */
  playerCount: number;
  /** 等候大廳擴充：人數隨機旗標 */
  randomCount: boolean;
  /** 等候大廳擴充：觀戰者名單 */
  spectators: { clientId: string; name: string }[];
  /** 等候大廳擴充：引擎狀態（loading 角落初始渲染用，即時更新走 MODEL_STATUS 廣播） */
  engineStatus: EngineStatus;
  /** 等候大廳擴充：host clientId（缺席時前端退回舊行為） */
  hostClientId?: string;
}

export interface GMSnapshot {
  phase: Phase;
  day: number;
  players: Player[];              // 完整，含 role/team/controlledBy
  discussionLog: { playerId: number; text: string; day: number }[];
  votes: { voterId: number; targetId: number; day: number }[];
  deathHistory: { playerId: number; cause: string; day: number }[];
  boardVersion: number;
  pendingGate: PendingGate | null;
  voteReady: number[];
  takenOver: number[];            // 掛機接管中座位（GM 視角區分原生 AI 與接管）
  idleCounts: Record<number, number>;   // 掛機計數（GM 視角可見，驗收用）
  // --- GM 白板同步（與一般視角 boardHtml 相容） ---
  nightResult: string | null;
  deadPlayers: { id: number; name: string; cause: string; day: number }[];
  winner: Team | null;
  gameOver: boolean;
  // --- 夜間行動全覽 ---
  nightActions: NightAction[];
  seerChecks: { seerId: number; targetId: number; result: Team; day: number }[];
  guardProtects: { guardId: number; targetId: number; day: number }[];
  masonChatLog: MasonChatEntry[];
  // --- GM 玩家列表顯示：personality id → 顯示名（AI 座位顯示 AI 角色名） ---
  personalityNames: Record<string, string>;
  // --- GM 除錯用：每輪 AI 決策 flag 統計（未注入時 undefined） ---
  flagStats?: FlagStats;
}

/** 每輪 AI 決策 flag 統計（scheduler 維護，供 GM 檢視除錯與驗證收斂） */
export interface FlagStats {
  decided: number;    // 決定投誰（target 為玩家編號）
  abstain: number;    // 棄票（target 為 abstain，含安全閥強制）
  uncertain: number;  // 資訊不足
}

// ============================================
// TransitionResult / Effect
// ============================================

export interface TransitionResult {
  state: GameState;
  effects: Effect[];   // engine 執行的副作用
  accepted: boolean;   // 事件是否被接受（例如版本不符的 AI_SPEECH_DONE 被丟棄）
  reason?: string;     // 拒絕原因
}

export type Effect =
  | { type: 'BROADCAST' }
  | { type: 'SAVE' }
  | { type: 'ARM_GATE'; gate: PendingGate }
  | { type: 'DISPATCH_LLM'; playerId: number; kind: 'speech' | 'vote' | 'night' }
  | { type: 'ENQUEUE'; event: GameEvent }
  | { type: 'IDLE_TAKEOVER'; playerId: number; reason: string };   // 掛機接管：engine 切座位＋發通知，server 轉播

// ============================================
// Role Configuration (from rules)
// ============================================

export interface RoleConfig {
  [playerCount: number]: {
    [role in Role]?: number;
  };
}

export const ROLE_CONFIG: RoleConfig = {
  6: { [Role.VILLAGER]: 2, [Role.SEER]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 1, [Role.MADMAN]: 1 },
  7: { [Role.VILLAGER]: 3, [Role.SEER]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 1, [Role.MADMAN]: 1 },
  8: { [Role.VILLAGER]: 2, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
  9: { [Role.VILLAGER]: 3, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
  10: { [Role.VILLAGER]: 4, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
  11: { [Role.VILLAGER]: 5, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
  12: { [Role.VILLAGER]: 6, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
  13: { [Role.VILLAGER]: 4, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.MASON]: 2, [Role.WEREWOLF]: 3, [Role.MADMAN]: 1 },
  14: { [Role.VILLAGER]: 5, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.MASON]: 2, [Role.WEREWOLF]: 3, [Role.MADMAN]: 1 },
  15: { [Role.VILLAGER]: 6, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.MASON]: 2, [Role.WEREWOLF]: 3, [Role.MADMAN]: 1 },
};

// ============================================
// Role Metadata
// ============================================

export const ROLE_TEAM: Record<Role, Team> = {
  [Role.VILLAGER]: Team.VILLAGE,
  [Role.SEER]: Team.VILLAGE,
  [Role.MEDIUM]: Team.VILLAGE,
  [Role.GUARD]: Team.VILLAGE,
  [Role.MASON]: Team.VILLAGE,
  [Role.WEREWOLF]: Team.WEREWOLF,
  [Role.MADMAN]: Team.VILLAGE,  // Madman is human team but wins with wolves
};

export const ROLE_DISPLAY: Record<Role, string> = {
  [Role.VILLAGER]: '村民 🟢',
  [Role.SEER]: '占い師 🔮',
  [Role.MEDIUM]: '靈能者 👁️',
  [Role.GUARD]: '獵人 🛡️',
  [Role.MASON]: '共有者 🤝',
  [Role.WEREWOLF]: '人狼 🔴',
  [Role.MADMAN]: '狂人 🤡',
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  [Role.VILLAGER]: '無特殊能力，靠推理與投票找出人狼',
  [Role.SEER]: '每夜選一名存活玩家查驗，結果為「村人」或「人狼」（狂人顯示為村人）',
  [Role.MEDIUM]: '只能得知白天被投票出局者的身分（「村人」或「人狼」），夜間被殺者無法得知',
  [Role.GUARD]: '獵人（狩人/守衛）：每夜守護一人免於人狼襲擊，可連續守護同一人，第一天不可守護',
  [Role.MASON]: '雙人組，互相知道對方身分，夜間可私聊，查驗結果為「村人」',
  [Role.WEREWOLF]: '夜間互相認識並合謀，全體共同選擇一人殺害，查驗結果為「人狼」',
  [Role.MADMAN]: '為人類陣營效力但不知同夥誰，無特殊能力，查驗結果為「村人」，人狼勝則狂人勝',
};

// ============================================
// Utility Functions
// ============================================

export function getTeam(role: Role): Team {
  return ROLE_TEAM[role];
}

export function getDisplayName(role: Role): string {
  return ROLE_DISPLAY[role];
}

export function getDescription(role: Role): string {
  return ROLE_DESCRIPTION[role];
}

export function isVillageTeam(role: Role): boolean {
  return ROLE_TEAM[role] === Team.VILLAGE;
}

export function isWerewolfTeam(role: Role): boolean {
  return ROLE_TEAM[role] === Team.WEREWOLF;
}

export function seerSeesAs(targetRole: Role): SeerResult {
  return targetRole === Role.WEREWOLF ? SeerResult.WEREWOLF : SeerResult.VILLAGER;
}

export function mediumSeesAs(targetRole: Role): MediumResult {
  return targetRole === Role.WEREWOLF ? MediumResult.WEREWOLF : MediumResult.VILLAGER;
}

// 保留 Personality 型別再匯出，供舊引用相容
export type { Personality };

// ============================================
// Phase 1：單機 Web 全 AI 擴充
// ============================================

/** LLM 文字生成參數（沿用 llm.ts 語義；正典定義移至此，llm.ts 再匯出相容） */
export interface GenerationConfig {
  temperature?: number;
  maxTokens?: number;
}

/** 觀戰者視角：與 PlayerSnapshot 公開欄位相同，不含 you（永不洩漏角色） */
export interface SpectatorSnapshot {
  phase: Phase;
  day: number;
  alivePlayers: { id: number; name: string }[];
  deadPlayers: { id: number; name: string; cause: string; day: number }[];
  nightResult: string | null;
  discussionLog: { playerId: number; text: string }[];
  votes: { voterId: number; targetId: number }[];
  winner: Team | null;
  gameOver: boolean;
}

/** Worker 任務（主 → worker） */
export interface WorkerJob {
  jobId: string;
  kind: 'speech' | 'vote' | 'night' | 'pre_speech' | 'judge' | 'expand';
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}

export type MainToWorkerMessage =
  | { type: 'INIT'; modelPath: string; contextSize: number; contextCount: number }
  | { type: 'JOB'; job: WorkerJob }
  | { type: 'SHUTDOWN' };

export type WorkerToMainMessage =
  | { type: 'READY' }
  | { type: 'RESULT'; jobId: string; ok: true; text: string }
  | { type: 'RESULT'; jobId: string; ok: false; error: string }
  | { type: 'LOG'; level: 'info' | 'warn' | 'error'; message: string };

/** LLM 分派器（Phase 1 新增 generate，供預發言/裁判/展開用） */
export interface LLMDispatcher {
  requestNightAction(playerId: number, prompt: string): Promise<{ targetId: number }>;
  requestVote(playerId: number, prompt: string): Promise<{ targetId: number }>;
  requestSpeech(playerId: number, prompt: string): Promise<{ text: string }>;
  /** Phase 1 新增：原始文字生成（預發言/裁判/展開用） */
  generate(prompt: string, config?: GenerationConfig): Promise<string>;
}

/** 客戶端註冊表（Phase 1 新增觀戰者廣播，optional 保持相容） */
export interface ClientRegistry {
  getConnectedPlayerIds(): number[];
  send(playerId: number, snapshot: PlayerSnapshot): void;
  /** Phase 1 新增（optional）：觀戰者廣播 */
  sendSpectator?(snapshot: SpectatorSnapshot): void;
  hasSpectators?(): boolean;
  /** Phase 2 新增（optional）：大廳廣播（SETUP 階段取代 snapshot 廣播） */
  sendLobby?(lobby: LobbySnapshot): void;
  /** 掛機接管通知（optional）：只推被接管者本人＋標記其舊連線為接管過濾 */
  notifyTakeover?(playerId: number, reason: string): void;
}

/** SpeechScheduler 建構參數 */
export interface SchedulerContext {
  enqueue(event: GameEvent): void;
  getState(): GameState;
  llm: LLMDispatcher;
}

/** 前端 WS 協定：伺服器 → 客戶端（Phase 2 擴充） */
export type ServerToClientMessage =
  | { type: 'SNAPSHOT'; snapshot: PlayerSnapshot | SpectatorSnapshot | GMSnapshot; gmView: boolean }
  | { type: 'LOBBY'; lobby: LobbySnapshot; clientId?: string }
  | { type: 'JOINED'; playerId: number; token: string; clientId?: string }
  | { type: 'NAME_SET'; name: string; token: string; clientId?: string }
  | { type: 'JOIN_REJECTED'; reason: string }
  | { type: 'ACTION_REJECTED'; reason: string }
  | { type: 'MODEL_STATUS'; state: 'downloading' | 'starting' | 'ready' | 'error'; stage?: 'llama-server' | 'model'; downloaded?: number; total?: number; info?: string; error?: string }
  | { type: 'ERROR'; message: string }
  | { type: 'PING' }
  | { type: 'SHUTDOWN' }
  | { type: 'LEFT_LOBBY' }
  | { type: 'IDLE_TAKEOVER'; playerId: number; reason: string }
  | { type: 'CHAT_MESSAGE'; from: string; text: string; ts: number };

/** 前端 WS 協定：客戶端 → 伺服器（Phase 2 擴充；真人操作訊息不含 playerId，伺服器由連線補上） */
export type ClientToServerMessage =
  | { type: 'PONG' }
  | { type: 'REQUEST_SNAPSHOT' }
  | { type: 'SET_GM_VIEW'; enabled: boolean }
  | { type: 'LEAVE' }
  | { type: 'LEAVE_LOBBY' }
  | { type: 'JOIN'; playerId: number; name?: string }
  | { type: 'RECONNECT'; token: string }
  | { type: 'SET_NAME'; name: string; token?: string }
  | { type: 'START_GAME' }
  | { type: 'SPECTATE' }
  | { type: 'SET_PLAYER_COUNT'; count: number }
  | { type: 'SET_RANDOM_COUNT'; enabled: boolean }
  | { type: 'CHAT_SEND'; text: string }
  | { type: 'HUMAN_SPEAK'; text: string }
  | { type: 'HUMAN_WOLF_SPEAK'; text: string }   // 狼密談發言
  | { type: 'HUMAN_SKIP' }
  | { type: 'HUMAN_READY_VOTE' }
  | { type: 'HUMAN_UNREADY_VOTE' }
  | { type: 'HUMAN_WOLF_READY' }   // 狼密談就緒
  | { type: 'HUMAN_WOLF_UNREADY' }   // 狼密談取消就緒
  | { type: 'HUMAN_VOTE'; targetId: number }
  | { type: 'HUMAN_NIGHT_ACTION'; targetId: number };
