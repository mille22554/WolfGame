/**
 * ai-controller.ts — AI 控制器（ubuntu 分支 stage 2 / M7）
 *
 * 職責：驅動 AI 玩家行動、攔截私訊建立知識、記錄所有 LLM 互動（供報告）。
 * - 引擎回呼 onNightStepActive / onWolfSubphaseChange → 驅動 AI 行動
 * - 攔截 sendTo（ROLE_REVEALED / SEER_RESULT / GUARD_RESULT / MEDIUM_RESULT）建立知識
 * - 攔截 broadcast（WOLF_MESSAGE / MASON_MESSAGE / WOLF_READY / PHASE_CHANGED / NIGHT_RESULT）
 * - 狼會議（規格 §12.3 連續對話制）：
 *   0 首句發言（全狼發一句）→ 0.5 judge 全盲選一篇（broadcast WOLF_SPEECH_SELECTED）
 *   → 1 其他狼表態（接受→toggle ready；反對→接著聊）→ 全 ready → 引擎進 VOTING
 *   → 分歧則 loop（judge 再選最新一輪）；平票由引擎重置回 DISCUSSION（全狼再發一句）
 *   白板累計 100 則未收斂 → 引擎停止（WOLF_MEETING_ABORTED），控制器停止驅動
 * - LLM 失敗（timeout / 5xx / parse 失敗 / 名字對照不到）→ 重試最多 3 次、間隔 2s；
 *   仍失敗 → 該 AI 跳過本次行動但不阻塞（log 記錄 parsed=null），由安全上限兜底
 */
import { Role } from '../types.js';
import { chat, type ChatMessage } from './llm.js';
import {
  loadCharacterProfile,
  parseJsonResponse,
  type CharacterProfile,
} from './ai-player.js';
import type { GameEngine, GamePlayer, NightStep, WolfSubphase } from './game.js';

export interface AiPlayerDef {
  clientId: string;
  nickname: string;
  characterId: string;
}

interface WolfDraft {
  wolf: GamePlayer;
  speech: string;
  stance: string; // "投XXX" 或 "資訊不足"
}

interface MasonDraft {
  mason: GamePlayer;
  speech: string;
  stance: string; // "準備好了" 或 "資訊不足"
}

interface DayDraft {
  player: GamePlayer;
  speech: string;
  stance: string; // "準備好了" 或 "資訊不足"
}

export interface AiLogEntry {
  ts: number;
  clientId: string;
  characterId: string;
  role: string;
  kind: 'WOLF_SPEECH' | 'JUDGE' | 'WOLF_STANCE' | 'WOLF_KILL' | 'SEER_CHECK' | 'GUARD_PROTECT' | 'MASON_TOGGLE' | 'MASON_SPEECH' | 'MASON_STANCE' | 'WOLF_ABORT' | 'DAY_STRATEGY' | 'DAY_SPEECH' | 'DAY_STANCE' | 'DAY_VOTE';
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
  recentMessages: { from: string; text: string }[];
}

interface AiEntry {
  def: AiPlayerDef;
  profile: CharacterProfile | null;
  knowledge: AiKnowledge;
}

const MAX_LLM_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
/** 共有者會議安全上限：白板累計 N 則 MASON_MESSAGE 未收斂 → 停止討論（強制 toggle ON 避免夜間卡死） */
const MASON_MESSAGE_CAP = 100;

export class AiController {
  private entries = new Map<string, AiEntry>();
  private game: GameEngine | null = null;
  private log: AiLogEntry[] = [];
  private destroyed = false;
  private timers: NodeJS.Timeout[] = [];
  private phase: string = 'ROLE_REVEAL';
  private day: number = 1;
  /** 狼白板（本夜全部 WOLF_MESSAGE；每夜重置） */
  private wolfBoard: { from: string; text: string }[] = [];
  /** 白板游標：「最新一輪」= wolfBoard.slice(boardCursor)（judge 選完後推進） */
  private boardCursor: number = 0;
  /** judge 選言序號（WOLF_SPEECH_SELECTED.round；本夜遞增） */
  private selectionSeq: number = 0;
  /** wolf clientId -> 是否 toggle ready ON（由攔截的 WOLF_READY 訊息維護） */
  private wolfReadyMap = new Map<string, boolean>();
  /** wolf clientId -> 當前 stance（"投XXX" / "資訊不足"） */
  private wolfStanceMap = new Map<string, string>();
  /** 共有者白板（本夜全部 MASON_MESSAGE；每夜重置） */
  private masonBoard: { from: string; text: string }[] = [];
  /** 共有者 judge 選言序號（MASON_SPEECH_SELECTED.round；本夜遞增） */
  private masonSelectionSeq: number = 0;
  /** mason clientId -> 是否 toggle ready ON（由攔截的 MASON_READY 訊息維護） */
  private masonReadyMap = new Map<string, boolean>();
  /** mason clientId -> 當前 stance（"準備好了" / "資訊不足"） */
  private masonStanceMap = new Map<string, string>();
  /** 白天公頻訊息（本天；AI 知識用） */
  private dayBoard: { from: string; text: string }[] = [];
  /** AI clientId -> 是否 toggle 準備投票 ON */
  private dayReadyMap = new Map<string, boolean>();

  private readonly messageCap: number;
  constructor(defs: AiPlayerDef[], opts?: { messageCap?: number }) {
    this.messageCap = opts?.messageCap ?? 0; // 0 = 無上限（正式）；>0 = 測試用安全上限
    for (const def of defs) {
      this.entries.set(def.clientId, {
        def,
        profile: loadCharacterProfile(def.characterId),
        knowledge: {
          role: '',
          displayName: def.nickname,
          partners: [],
          madman: null,
          privateInfo: '',
          recentMessages: [],
        },
      });
    }
  }

  /** 建立後由 harness 設定遊戲引擎 */
  setGame(game: GameEngine): void {
    this.game = game;
  }

  isAi(clientId: string): boolean {
    return this.entries.has(clientId);
  }

  /** 全部 LLM 互動記錄（依時間序） */
  getLog(): AiLogEntry[] {
    return [...this.log];
  }

  /** resume 用：把前段存檔的 AI log 縫回（跨段報告需完整流程） */
  restoreLog(entries: AiLogEntry[]): void {
    this.log.push(...entries);
  }

  /** 該 AI 的知識快照（供報告／除錯） */
  getKnowledge(clientId: string): AiKnowledge | null {
    const k = this.entries.get(clientId)?.knowledge;
    if (!k) return null;
    return {
      role: k.role,
      displayName: k.displayName,
      partners: [...k.partners],
      madman: k.madman,
      privateInfo: k.privateInfo,
      recentMessages: [...k.recentMessages],
    };
  }

  /** 取消進行中的重試排程（進行中的 fetch 無法中斷，但其結果會被丟棄） */
  destroy(): void {
    this.destroyed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  // --- 引擎回呼（harness 把 engine callback 接進來） ---

  onNightStepActive(step: NightStep, players: GamePlayer[]): void {
    if (this.destroyed || !this.game) return;
    if (step === 'MASON') {
      // 共有者會議（連續對話制）：驅動 AI 討論，收斂後 toggle ON
      void this.runMasonDiscussion();
    } else if (step === 'SEER') {
      for (const p of players) {
        if (this.isAi(p.clientId)) void this.runTargetAction(p.clientId, 'SEER_CHECK');
      }
    } else if (step === 'GUARD') {
      for (const p of players) {
        if (this.isAi(p.clientId)) void this.runTargetAction(p.clientId, 'GUARD_PROTECT');
      }
    }
    // WOLF：走 onWolfSubphaseChange
  }

  onWolfSubphaseChange(subphase: WolfSubphase, round: number): void {
    if (this.destroyed || !this.game) return;
    if (subphase === 'DISCUSSION') void this.runWolfDiscussion(round);
    else void this.runWolfVoting(round);
  }

  // --- 攔截引擎 sendTo / broadcast（建立知識） ---

  handlePrivate(clientId: string, msg: any): void {
    const entry = this.entries.get(clientId);
    if (!entry) return;
    const m = msg as Record<string, any>;
    switch (m.type) {
      case 'ROLE_REVEALED':
        entry.knowledge.role = String(m.role ?? '');
        entry.knowledge.displayName = String(m.displayName ?? entry.def.nickname);
        entry.knowledge.partners = Array.isArray(m.partners) ? m.partners.map((x) => String(x)) : [];
        entry.knowledge.madman = typeof m.madman === 'string' ? m.madman : null;
        break;
      case 'SEER_RESULT':
        entry.knowledge.privateInfo += `\n第${this.day}夜查驗：${m.nickname} 是 ${m.result === 'werewolf' ? '人狼' : '村人'}。`;
        break;
      case 'GUARD_RESULT':
        entry.knowledge.privateInfo += `\n第${this.day}夜守護：${m.nickname}（${m.blocked ? '成功擋下狼刀' : '未遇狼刀'}）。`;
        break;
      case 'MEDIUM_RESULT':
        entry.knowledge.privateInfo += `\n黎明得知：${m.nickname} 是 ${m.result === 'werewolf' ? '人狼' : '村人'}。`;
        break;
      default:
        break;
    }
  }

  handleBroadcast(msg: any, targetClientIds?: string[]): void {
    const m = msg as Record<string, any>;
    if (m.type === 'PHASE_CHANGED') {
      this.phase = String(m.phase ?? this.phase);
      if (typeof m.day === 'number') this.day = m.day;
      // 新夜開始：重置白板、游標、judge 序號、ready 追蹤
      if (m.phase === 'NIGHT') {
        this.wolfBoard = [];
        this.boardCursor = 0;
        this.selectionSeq = 0;
        this.wolfReadyMap.clear();
        this.masonBoard = [];
        this.masonSelectionSeq = 0;
        this.masonReadyMap.clear();
        this.masonStanceMap.clear();
      }
      if (m.phase === 'DAY_DISCUSSION') {
        this.dayBoard = [];
        this.dayReadyMap.clear();
        void this.runDayDiscussion();
      }
      if (m.phase === 'DAY_VOTING') {
        void this.runDayVoting();
      }
      return;
    }
    if (m.type === 'NIGHT_RESULT') return; // 僅 phase 追蹤，無知識變更
    if (m.type === 'WOLF_READY') {
      if (typeof m.clientId === 'string') this.wolfReadyMap.set(m.clientId, m.ready === true);
      return;
    }
    if (m.type === 'MASON_READY') {
      if (typeof m.clientId === 'string') this.masonReadyMap.set(m.clientId, m.ready === true);
      return;
    }
    if (m.type === 'WOLF_MESSAGE') {
      this.wolfBoard.push({ from: String(m.from ?? ''), text: String(m.text ?? '') });
    }
    if (m.type === 'MASON_MESSAGE') {
      this.masonBoard.push({ from: String(m.from ?? ''), text: String(m.text ?? '') });
    }
    if (m.type === 'MESSAGE') {
      this.dayBoard.push({ from: String(m.from ?? ''), text: String(m.text ?? '') });
      if (this.dayBoard.length > 50) this.dayBoard.shift();
      return;
    }
    if (m.type !== 'WOLF_MESSAGE' && m.type !== 'MASON_MESSAGE' && m.type !== 'MESSAGE') return;
    for (const [clientId, entry] of this.entries) {
      if (targetClientIds && !targetClientIds.includes(clientId)) continue;
      entry.knowledge.recentMessages.push({ from: String(m.from ?? ''), text: String(m.text ?? '') });
      if (entry.knowledge.recentMessages.length > 30) entry.knowledge.recentMessages.shift();
    }
  }

  // --- 狼會議（連續對話 loop，規格 §12.3 / §13.6） ---

  /** 狼會議 DISCUSSION：全狼獨立出草稿 → loop（judge 盲選發布 → 其他狼回應 → 收斂判斷） */
  private async runWolfDiscussion(round: number): Promise<void> {
    const wolves = this.getAiWolves();
    if (wolves.length === 0 || !this.game) return;
    this.boardCursor = this.wolfBoard.length;

    // ① 所有狼各自獨立出草稿（互不可見）
    let drafts = await this.generateAllDrafts(wolves, round);
    if (drafts.length === 0) return; // 全部 LLM 失敗

    // Loop：② judge 盲選發布 → ③ 其他狼回應 → ④ 收斂判斷
    let guard = 0;
    while (this.game.getNightState().wolfSubphase === 'DISCUSSION' && !this.isAborted() && !this.destroyed) {
      if (++guard > 150) break;

      // ② Judge 盲選一篇（LLM 盲評）→ 發布 speech 到白板
      const selected = await this.judgePickDraft(drafts, round);
      if (!selected) break;
      this.game.handleWolfChat(selected.wolf.clientId, selected.speech);
      this.game.broadcastToWolves({
        type: 'WOLF_SPEECH_SELECTED',
        round: this.selectionSeq,
        from: selected.wolf.nickname,
        text: selected.speech,
      });
      // 記錄發言者的 stance + 本地 ready 追蹤（不呼叫 game.handleToggleWolfReady——會觸發 premature VOTING）
      // stance 正規化：speech 已點名刀人目標但 stance 漏寫「投」前綴 → 補上，視為已承諾（避免發布者被誤判為資訊不足而強制重出稿）
      const publishedStance = this.normalizePublishedStance(selected.wolf, selected.speech, selected.stance);
      this.wolfStanceMap.set(selected.wolf.clientId, publishedStance);
      if (publishedStance.startsWith('投')) {
        this.wolfReadyMap.set(selected.wolf.clientId, true);
        this.game.broadcastToWolves({ type: 'WOLF_READY', clientId: selected.wolf.clientId, ready: true });
      }

      // ③ 除發言者外所有狼讀白板 → 各自回應（全併發）
      const newDrafts: WolfDraft[] = [];
      await Promise.all(wolves.filter((w) => w.clientId !== selected.wolf.clientId).map(async (w, i) => {
        if (this.destroyed || this.isAborted()) return;
        const entry = this.entries.get(w.clientId);
        if (!entry) return;
        const resp = await this.wolfRespond(w, entry, selected.speech, round, 100 + i);
        if (!this.game) return;
        if (resp.type === 'vote') {
          this.wolfStanceMap.set(w.clientId, `投${resp.target}`);
          this.wolfReadyMap.set(w.clientId, true);
          this.game.broadcastToWolves({ type: 'WOLF_READY', clientId: w.clientId, ready: true });
        } else if (resp.type === 'speak') {
          newDrafts.push({ wolf: w, speech: resp.speech, stance: resp.stance });
          this.wolfStanceMap.set(w.clientId, resp.stance);
          this.wolfReadyMap.set(w.clientId, false);
          this.game.broadcastToWolves({ type: 'WOLF_READY', clientId: w.clientId, ready: false });
        }
      }));

      // ④ 收斂判斷：全狼 ready 且沒人想再講
      const allReady = wolves.every((w) => this.isWolfReady(w.clientId));
      if (allReady && newDrafts.length === 0) break; // 收斂

      if (newDrafts.length > 0) {
        drafts = newDrafts; // 下一輪 judge 從新草稿中選
      } else {
        // 沒人出新草稿、但有狼「資訊不足」→ 強制那些狼發言
        const waiting = wolves.filter((w) => !this.isWolfReady(w.clientId));
        if (waiting.length === 0) break; // 安全：不該發生
        drafts = await this.generateAllDrafts(waiting, round);
        if (drafts.length === 0) break; // 全部失敗 → 停止
      }
    }
    // 收斂後：同步 game state（觸發 VOTING 轉換）
    for (const w of wolves) {
      if (this.wolfReadyMap.get(w.clientId) === true) {
        this.game.handleToggleWolfReady(w.clientId);
      }
    }
    if (this.isAborted()) {
      this.logEntry('', 'WOLF_ABORT', round, 1, [], null, { count: this.game.getNightState().wolfMessageCount });
    }
  }

  /** 所有狼獨立出草稿（平行 LLM 呼叫；互不可見；失敗的狼跳過） */
  private async generateAllDrafts(wolves: GamePlayer[], round: number): Promise<WolfDraft[]> {
    const results = await Promise.all(wolves.map(async (w, i) => {
      const entry = this.entries.get(w.clientId);
      if (!entry) return null;
      const prompts = this.buildDraftPrompts(entry);
      const result = await this.llmWithRetry(w.clientId, 'WOLF_SPEECH', round, prompts, (p) =>
        typeof p.speech === 'string' && p.speech.trim() && typeof p.stance === 'string' ? 'ok' : null, 100 + i);
      if (result.value === null) return null;
      return { wolf: w, speech: (result.parsed!.speech as string).trim(), stance: (result.parsed!.stance as string).trim() };
    }));
    return results.filter((r): r is WolfDraft => r !== null);
  }

  /** 組裝 judge 盲評 prompt：system「你是裁判，全盲評分以下發言，不考慮作者」；user 列出所有 speech（編號，不標作者），要求 JSON 回 {"scores":[...],"best":index} */
  private buildJudgePrompts(speeches: string[]): ChatMessage[] {
    const numbered = speeches.map((s, i) => `[${i + 1}]: ${s}`).join('\n');
    const user = [
      `以下是 ${speeches.length} 篇發言（不標明作者）：`,
      numbered,
      `請給每篇打分（1-10 分），並選出最佳的一篇。`,
      `回覆 JSON：{"scores": [n, n, ...], "best": index}`,
      `（index 從 0 開始）`,
    ].join('\n');
    return [
      { role: 'system', content: '你是裁判，全盲評分以下發言，不考慮作者' },
      { role: 'user', content: user },
    ];
  }

  /** Judge 盲評（LLM）：給所有 speech 打分（1-10），回最高分的 index；LLM 失敗 → 隨機 fallback（不阻塞）。
   *  LLM 呼叫本身由 llmWithRetry 記錄 log。 */
  private async judgeScoreIndex(speeches: string[], round: number): Promise<number> {
    if (speeches.length <= 1) return 0;
    const prompts = this.buildJudgePrompts(speeches);
    const result = await this.llmWithRetry('', 'JUDGE', round, prompts, (p) =>
      Array.isArray(p.scores) && p.scores.length === speeches.length ? 'ok' : null);
    if (result.value !== null && result.parsed) {
      const scores = (result.parsed.scores as unknown[]).map((s) => (typeof s === 'number' && Number.isFinite(s) ? s : 0));
      let maxScore = -Infinity;
      let idx = 0;
      for (let i = 0; i < scores.length; i++) {
        if (scores[i] > maxScore) { maxScore = scores[i]; idx = i; }
      }
      if (maxScore > 0) return idx;
    }
    // LLM 失敗或全 0 分 → 隨機 fallback（不阻塞）
    return Math.floor(Math.random() * speeches.length);
  }

  /** Judge 盲選一篇草稿（LLM 全盲評分，不告知作者）→ 回選中的 draft */
  private async judgePickDraft(drafts: WolfDraft[], round: number): Promise<WolfDraft | null> {
    if (drafts.length === 0 || !this.game) return null;
    if (drafts.length === 1) {
      this.selectionSeq += 1;
      this.logEntry('', 'JUDGE', round, 1, [], null, { picked: drafts[0].wolf.nickname, from: 1 });
      return drafts[0];
    }
    const idx = await this.judgeScoreIndex(drafts.map((d) => d.speech), round);
    this.selectionSeq += 1;
    this.logEntry('', 'JUDGE', round, 1, [], null, { picked: drafts[idx].wolf.nickname, from: drafts.length });
    return drafts[idx];
  }

  /** 發布稿 stance 正規化（對齊 spec §12.3：stance 只有「投XXX」或「資訊不足」二值）：
   *  speech 已明確點名刀人目標時，視為已承諾——補上「投<目標>」；沒有目標才維持原樣（資訊不足）。 */
  private normalizePublishedStance(wolf: GamePlayer, speech: string, stance: string): string {
    const s = stance.trim();
    if (s.startsWith('投')) return s;
    const targets = (this.game?.getPlayers() ?? [])
      .filter((p) => p.alive && p.clientId !== wolf.clientId && p.role !== Role.WEREWOLF && p.role !== Role.MADMAN);
    const named = targets.find((p) => speech.includes(p.nickname));
    return named ? `投${named.nickname}` : s;
  }

  /** 非發言者狼讀白板後回應：vote / speak / wait */
  private async wolfRespond(
    w: GamePlayer,
    entry: AiEntry,
    publishedSpeech: string,
    round: number,
    priority?: number,
  ): Promise<{ type: 'vote'; target: string } | { type: 'speak'; speech: string; stance: string } | { type: 'wait' }> {
    const prompts = this.buildResponsePrompts(entry, publishedSpeech);
    const result = await this.llmWithRetry(w.clientId, 'WOLF_STANCE', round, prompts, (p) => {
      if (p.action === 'vote' && typeof p.target === 'string' && p.target) return 'ok';
      if (p.action === 'speak' && typeof p.speech === 'string' && p.speech.trim() && typeof p.stance === 'string') return 'ok';
      if (p.action === 'wait') return 'ok';
      return null;
    }, priority);
    if (result.value === null) return { type: 'wait' }; // 失敗 → 視為等待（不阻塞）
    const p = result.parsed!;
    if (p.action === 'vote') return { type: 'vote', target: p.target as string };
    if (p.action === 'speak') return { type: 'speak', speech: (p.speech as string).trim(), stance: (p.stance as string).trim() };
    return { type: 'wait' };
  }

  /** 狼會議 VOTING：每隻 AI 狼 LLM 選刀人目標 → 提交 WOLF_KILL（全併發） */
  private async runWolfVoting(round: number): Promise<void> {
    const wolves = this.getAiWolves();
    await Promise.all(wolves.map(async (w, i) => {
      if (this.destroyed || !this.game) return;
      const entry = this.entries.get(w.clientId);
      if (!entry) return;
      const prompts = this.buildWolfKillPrompts(entry);
      const extract = (parsed: Record<string, any>): string | null =>
        this.resolveClientId(String(parsed.target ?? ''), (p) => p.clientId !== w.clientId && p.role !== Role.MADMAN);
      const result = await this.llmWithRetry(w.clientId, 'WOLF_KILL', round, prompts, extract, 100 + i);
      if (result.value !== null) {
        this.game.handleNightAction(w.clientId, { type: 'WOLF_KILL', targetClientId: result.value });
      }
    }));
  }

  // --- 共有者會議（連續對話 loop，與狼會議同構） ---

  /** 共有者會議：雙共有者獨立出草稿 → loop（judge 盲選發布 → 另一人回應 → 收斂判斷） */
  private async runMasonDiscussion(): Promise<void> {
    const masons = this.getAiMasons();
    if (masons.length === 0 || !this.game) return;
    if (masons.length < 2) {
      // 存活共有者不足 2 人：無會議，直接 toggle ON
      for (const m of masons) {
        this.logEntry(m.clientId, 'MASON_TOGGLE', this.day, 1, [], null, null);
        this.game.handleToggleMasonEndTurn(m.clientId);
      }
      return;
    }

    // ① 所有共有者各自獨立出草稿（互不可見）
    let drafts = await this.generateMasonDrafts(masons);
    if (drafts.length === 0) {
      // 全部 LLM 失敗：強制 toggle ON，避免夜間卡死
      for (const m of masons) this.game.handleToggleMasonEndTurn(m.clientId);
      return;
    }

    // Loop：② judge 盲選發布 → ③ 另一共有者回應 → ④ 收斂判斷
    let guard = 0;
    while (this.game.getNightState().nightStep === 'MASON' && !this.destroyed) {
      if (++guard > 150) break;
      if (this.messageCap > 0 && this.masonBoard.length >= this.messageCap) break; // 安全上限（僅測試）：停止討論

      // ② Judge 盲選一篇（LLM 盲評）→ 發布 speech 到白板
      const selected = await this.judgePickMasonDraft(drafts);
      if (!selected) break;
      this.game.publishMasonSpeech(selected.mason.clientId, selected.speech, this.masonSelectionSeq);
      // 記錄發言者的 stance（toggle 延後到回應之後，避免引擎提前推進）
      this.masonStanceMap.set(selected.mason.clientId, selected.stance);

      // ③ 除發言者外所有共有者讀白板 → 各自回應
      const newDrafts: MasonDraft[] = [];
      for (const m of masons) {
        if (this.destroyed) return;
        if (m.clientId === selected.mason.clientId) continue; // 發言者不讀自己的話
        const entry = this.entries.get(m.clientId);
        if (!entry) continue;
        const resp = await this.masonRespond(m, entry, selected.speech);
        if (resp.type === 'vote') {
          this.masonStanceMap.set(m.clientId, '準備好了');
          if (!this.isMasonReady(m.clientId)) this.game.handleToggleMasonEndTurn(m.clientId);
        } else if (resp.type === 'speak') {
          newDrafts.push({ mason: m, speech: resp.speech, stance: resp.stance });
          this.masonStanceMap.set(m.clientId, resp.stance);
          if (this.isMasonReady(m.clientId)) this.game.handleToggleMasonEndTurn(m.clientId); // 發言＝還沒結束，撤回 ready 讓對方有機會回應
        }
        // 'wait' → 不出草稿，維持等待
      }

      // ③.5 發言者 toggle（在回應之後，避免引擎在對方回應前就推進）
      if (selected.stance === '準備好了' && !this.isMasonReady(selected.mason.clientId)) {
        this.game.handleToggleMasonEndTurn(selected.mason.clientId);
      }

      // ④ 收斂判斷：全部共有者 ready
      const allReady = masons.every((m) => this.isMasonReady(m.clientId));
      if (allReady) break;

      if (newDrafts.length > 0) {
        drafts = newDrafts; // 下一輪 judge 從新草稿中選
      } else {
        // 沒人出新草稿、但有共有者「資訊不足」→ 強制那些共有者發言
        const waiting = masons.filter((m) => !this.isMasonReady(m.clientId));
        if (waiting.length === 0) break; // 安全：不該發生
        drafts = await this.generateMasonDrafts(waiting);
        if (drafts.length === 0) break; // 全部失敗 → 停止
      }
    }
    // 討論結束（收斂或安全停止）：確保所有共有者 toggle ON，讓夜間能推進
    for (const m of masons) {
      if (!this.isMasonReady(m.clientId)) this.game.handleToggleMasonEndTurn(m.clientId);
    }
  }

  /** 所有共有者獨立出草稿（平行 LLM 呼叫；互不可見；失敗的跳過） */
  private async generateMasonDrafts(masons: GamePlayer[]): Promise<MasonDraft[]> {
    const results = await Promise.all(masons.map(async (m, i) => {
      const entry = this.entries.get(m.clientId);
      if (!entry) return null;
      const prompts = this.buildMasonDraftPrompts(entry);
      const result = await this.llmWithRetry(m.clientId, 'MASON_SPEECH', this.day, prompts, (p) =>
        typeof p.speech === 'string' && p.speech.trim() && typeof p.stance === 'string' ? 'ok' : null, 100 + i);
      if (result.value === null) return null;
      return { mason: m, speech: (result.parsed!.speech as string).trim(), stance: (result.parsed!.stance as string).trim() };
    }));
    return results.filter((r): r is MasonDraft => r !== null);
  }

  /** Judge 盲選一篇共有者草稿（LLM 全盲評分，同 wolf judge）→ 回選中的 draft */
  private async judgePickMasonDraft(drafts: MasonDraft[]): Promise<MasonDraft | null> {
    if (drafts.length === 0 || !this.game) return null;
    if (drafts.length === 1) {
      this.masonSelectionSeq += 1;
      return drafts[0];
    }
    const idx = await this.judgeScoreIndex(drafts.map((d) => d.speech), this.day);
    this.masonSelectionSeq += 1;
    this.logEntry('', 'JUDGE', this.day, 1, [], null, { picked: drafts[idx].mason.nickname, from: drafts.length, meeting: 'mason' });
    return drafts[idx];
  }

  /** 非發言者共有者讀白板後回應：vote / speak / wait */
  private async masonRespond(
    m: GamePlayer,
    entry: AiEntry,
    publishedSpeech: string,
  ): Promise<{ type: 'vote'; target: string } | { type: 'speak'; speech: string; stance: string } | { type: 'wait' }> {
    const prompts = this.buildMasonResponsePrompts(entry, publishedSpeech);
    const result = await this.llmWithRetry(m.clientId, 'MASON_STANCE', this.day, prompts, (p) => {
      if (p.action === 'vote' && typeof p.target === 'string' && p.target) return 'ok';
      if (p.action === 'speak' && typeof p.speech === 'string' && p.speech.trim() && typeof p.stance === 'string') return 'ok';
      if (p.action === 'wait') return 'ok';
      return null;
    });
    if (result.value === null) return { type: 'wait' }; // 失敗 → 視為等待（不阻塞）
    const p = result.parsed!;
    if (p.action === 'vote') return { type: 'vote', target: p.target as string };
    if (p.action === 'speak') return { type: 'speak', speech: (p.speech as string).trim(), stance: (p.stance as string).trim() };
    return { type: 'wait' };
  }

  // --- 白天討論（策略先行 + toggle 制） ---

  /** 白天開始時：每個 AI 依角色生成策略 → 寫入全局 memory（全併發） */
  private async generateDayStrategies(aiPlayers: GamePlayer[]): Promise<void> {
    await Promise.all(aiPlayers.map(async (p, i) => {
      if (this.destroyed) return;
      const entry = this.entries.get(p.clientId);
      if (!entry) return;
      const prompts = this.buildStrategyPrompt(entry, p);
      const result = await this.llmWithRetry(p.clientId, 'DAY_STRATEGY', this.day, prompts, (p2) => {
        return typeof p2.strategy === 'string' && p2.strategy.trim() ? 'ok' : null;
      }, 100 + i);
      if (result.value === 'ok' && result.parsed) {
        const strategy = (result.parsed.strategy as string).trim();
        this.appendMemory(p.clientId, `[Day${this.day} 策略] ${strategy}`);
        this.logEntry(p.clientId, 'DAY_STRATEGY', this.day, 0, [], null, { strategy });
      }
    }));
  }

  /** 依角色生成策略 prompt */
  private buildStrategyPrompt(entry: AiEntry, player: GamePlayer): ChatMessage[] {
    const k = entry.knowledge;
    const aliveList = (this.game?.getPlayers() ?? []).filter((p) => p.alive).map((p) => p.nickname).join('、');
    const role = player.role;
    let roleSpecific: string;
    if (role === 'seer') {
      roleSpecific = `你是占卜師。你的情報：${k.privateInfo || '（尚無查驗結果）'}。今天白天討論，你該怎麼引導會議讓村民贏？要不要公開身份（CO）？什麼時機 CO 最有利？`;
    } else if (role === 'mason') {
      const partner = (this.game?.getPlayers() ?? []).find((p) => p.clientId === player.masonPartnerId);
      const masonCtx = this.masonBoard.length ? this.masonBoard.map((m) => `${m.from}：「${m.text}」`).join('\n') : '（昨晚未討論）';
      roleSpecific = `你是共有者，夥伴是${partner?.nickname ?? '（未知）'}。昨晚你們的討論：\n${masonCtx}\n今天白天你怎麼發話執行方針？CO 是否有利？`;
    } else if (role === 'werewolf') {
      const wolves = (this.game?.getPlayers() ?? []).filter((p) => p.role === 'werewolf' && p.alive).map((p) => p.nickname).join('、');
      const wolfCtx = this.wolfBoard.length ? this.wolfBoard.map((m) => `${m.from}：「${m.text}」`).join('\n') : '（無）';
      const target = this.game?.getNightState().wolfTargetId;
      const targetName = target ? (this.game?.getPlayers() ?? []).find((p) => p.clientId === target)?.nickname : '（未定）';
      roleSpecific = `你是狼。狼隊：${wolves}。昨晚刀了${targetName}。狼隊會議結論：\n${wolfCtx}\n今天白天你怎麼引導討論讓狼隊存活？要不要假 CO？把嫌疑導向誰？`;
    } else {
      roleSpecific = `你是${k.displayName}。目前存活：${aliveList}。${k.privateInfo ? `你的情報：${k.privateInfo}` : ''}你從目前情況觀察到什麼？今天發言要達成什麼效果——自保、指人、還是跟風？`;
    }
    const user = [
      `當前：第 ${this.day} 天 白天討論開始。`,
      `存活玩家：${aliveList}`,
      k.privateInfo ? `你的情報：${k.privateInfo}` : '',
      roleSpecific,
      ``,
      `白天策略必須具體：點名你打算質疑/觀察的玩家（從存活玩家中選），或說明你今天站誰、跟誰、防誰。`,
      `但點名只能針對「已經發過言」的玩家——沒發言的人沒有立場可質疑。若目前沒人發言，策略請寫你打算先從誰開始問、想聽誰的表態。`,
      `禁止空泛策略：「觀察局勢」「引導討論」「見機行事」「呼籲冷靜」這類都算不合格。`,
      `禁止把「假設某人的立場」當作策略——例如「不跟佐雪的立場走」是無效的，因為佐雪根本沒發表過立場。`,
      ``,
      `用一句話（≤50字）寫下你今天白天的策略。`,
      `回覆格式（JSON）：{"strategy": "你的策略"}`,
    ].filter(Boolean).join('\n');
    return [
      { role: 'system', content: this.buildSystemPrompt(entry) },
      { role: 'user', content: user },
    ];
  }

  /** 白天討論：策略先行 → AI 輪流發言（judge 盲選）→ 收斂（全 AI toggle ON）後結束 */
  private async runDayDiscussion(): Promise<void> {
    const aiPlayers = this.getAiAlivePlayers();
    if (aiPlayers.length === 0 || !this.game) return;

    // 接續模式：從 game state 重建 dayBoard + dayReadyMap（resume 時已有內容）
    const dayState = this.game.getDayState();
    for (const m of dayState.dayMessages) {
      if (!this.dayBoard.some((b) => b.from === m.from && b.text === m.text)) {
        this.dayBoard.push({ from: m.from, text: m.text });
      }
    }
    for (const p of aiPlayers) {
      const ready = dayState.dayReady.get(p.clientId);
      if (ready !== undefined) this.dayReadyMap.set(p.clientId, ready);
    }

    // 策略先行：每個 AI 生成/更新策略寫入 memory
    await this.generateDayStrategies(aiPlayers);

    // 接續：跳過已 ready 的 AI，只讓未 ready 的出草稿
    const pendingPlayers = aiPlayers.filter((p) => !this.dayReadyMap.get(p.clientId));
    if (pendingPlayers.length === 0) {
      // 全部已 ready（resume 後直接收斂）
      return;
    }

    // ① 未 ready 的 AI 各自獨立出草稿
    let drafts = await this.generateDayDrafts(pendingPlayers);
    if (drafts.length === 0) {
      // 全部 LLM 失敗：強制 toggle ON，避免卡死
      for (const p of pendingPlayers) this.game.handleToggleVoteReady(p.clientId);
      return;
    }

    // Loop：② judge 盲選發布 → ③ 其他 AI 回應 → ④ 收斂判斷
    let guard = 0;
    while (this.phase === 'DAY_DISCUSSION' && !this.destroyed) {
      if (++guard > 50) break; // 安全上限

      // ② Judge 盲選一篇（LLM 盲評）→ 該 AI 發言（公頻）
      const selected = await this.judgePickDayDraft(drafts);
      if (!selected) break;
      this.game.sendDayMessage(selected.player.clientId, selected.speech);
      // 發言者已發言 → toggle ready（無條件；dayReadyMap 同步：ON→true、OFF→false）
      this.dayReadyMap.set(selected.player.clientId, !this.dayReadyMap.get(selected.player.clientId));
      this.game.handleToggleVoteReady(selected.player.clientId);

      // ③ 除發言者外所有 AI 讀白板 → 各自回應（全併發）
      const newDrafts: DayDraft[] = [];
      await Promise.all(aiPlayers.filter((p) => p.clientId !== selected.player.clientId).map(async (p, i) => {
        if (this.destroyed) return;
        const entry = this.entries.get(p.clientId);
        if (!entry) return;
        const resp = await this.dayRespond(p, entry, selected.speech, 100 + i);
        if (!this.game) return;
        if (resp.type === 'ready') {
          this.dayReadyMap.set(p.clientId, !this.dayReadyMap.get(p.clientId));
          this.game.handleToggleVoteReady(p.clientId);
        } else if (resp.type === 'speak') {
          newDrafts.push({ player: p, speech: resp.speech, stance: resp.stance });
          if (this.dayReadyMap.get(p.clientId) === true) {
            this.dayReadyMap.set(p.clientId, false);
            this.game.handleToggleVoteReady(p.clientId);
          }
        }
      }));

      // ④ 收斂判斷：全部 AI ready
      if (aiPlayers.every((p) => this.dayReadyMap.get(p.clientId))) break;

      if (newDrafts.length > 0) {
        drafts = newDrafts;
      } else {
        // 沒人出新草稿、但有 AI 還沒 ready → 強制那些 AI 發言
        const waiting = aiPlayers.filter((p) => !this.dayReadyMap.get(p.clientId));
        if (waiting.length === 0) break;
        drafts = await this.generateDayDrafts(waiting);
        if (drafts.length === 0) break;
      }
    }
    // 討論結束：確保所有 AI toggle ON
    for (const p of aiPlayers) {
      if (!this.dayReadyMap.get(p.clientId)) {
        this.dayReadyMap.set(p.clientId, true);
        this.game.handleToggleVoteReady(p.clientId);
      }
    }
  }

  /** 白天投票：每個 AI 玩家 LLM 決定投誰（或棄票）→ 提交 CAST_VOTE */
  private async runDayVoting(): Promise<void> {
    const aiPlayers = this.getAiAlivePlayers();
    await Promise.all(aiPlayers.map(async (p, i) => {
      if (this.destroyed || !this.game) return;
      const entry = this.entries.get(p.clientId);
      if (!entry) return;
      const prompts = this.buildDayVotePrompts(entry);
      const extract = (parsed: Record<string, any>): string | null => {
        const target = parsed.target;
        if (target === null || target === undefined || target === '') return 'ABSTAIN';
        return this.resolveClientId(String(target), (p2) => p2.clientId !== p.clientId);
      };
      const result = await this.llmWithRetry(p.clientId, 'DAY_VOTE', this.day, prompts, extract, 100 + i);
      if (result.value !== null) {
        if (result.value === 'ABSTAIN') {
          this.game.handleVote(p.clientId, null);
        } else {
          this.game.handleVote(p.clientId, result.value);
        }
      }
    }));
  }

  // --- Private methods ---

  private logEntry(clientId: string, kind: AiLogEntry['kind'], round: number, attempt: number, prompts: ChatMessage[], response: string | null, parsed: any): void {
    const entry = this.entries.get(clientId);
    this.log.push({
      ts: Date.now(),
      clientId,
      characterId: entry?.def.characterId ?? '',
      role: entry?.knowledge.role ?? '',
      kind,
      round,
      attempt,
      prompts,
      response,
      parsed,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.timers.push(t);
    });
  }

  /** 呼叫 LLM 並解析；失敗（null / parse 失敗 / 抽取不到值）重試，最多 3 次、間隔 2s */
  private async llmWithRetry(
    clientId: string,
    kind: AiLogEntry['kind'],
    round: number,
    prompts: ChatMessage[],
    extract: (parsed: Record<string, any>) => string | null,
    priority?: number,
  ): Promise<{ response: string | null; parsed: Record<string, any> | null; value: string | null }> {
    let response: string | null = null;
    let parsed: Record<string, any> | null = null;
    for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
      if (this.destroyed) break;
      response = await chat(prompts, { temperature: 1.0, priority });
      parsed = parseJsonResponse(response);
      this.logEntry(clientId, kind, round, attempt, prompts, response, parsed);
      if (parsed === null) {
        if (attempt < MAX_LLM_RETRIES) await this.sleep(RETRY_DELAY_MS);
        continue;
      }
      const value = extract(parsed);
      if (value !== null) return { response, parsed, value };
      if (attempt < MAX_LLM_RETRIES) await this.sleep(RETRY_DELAY_MS);
    }
    return { response, parsed, value: null };
  }

  /** displayName（LLM 回傳的中文名）→ clientId；對照不到回 null（觸發重試） */
  private resolveClientId(name: string, filter?: (p: GamePlayer) => boolean): string | null {
    if (!this.game || !name) return null;
    const p = this.game.getPlayers().find((x) => x.nickname === name.trim() && x.alive && (!filter || filter(x)));
    return p ? p.clientId : null;
  }

  /** nickname → 存活的狼玩家（WOLF_SPEECH_SELECTED.from 是 nickname） */
  private resolveWolfByNickname(nickname: string): GamePlayer | null {
    if (!this.game || !nickname) return null;
    return this.game.getPlayers().find((p) => p.nickname === nickname && p.role === Role.WEREWOLF && p.alive) ?? null;
  }

  private characterIdOf(clientId: string): string {
    return this.entries.get(clientId)?.def.characterId ?? '';
  }

  private getAiWolves(): GamePlayer[] {
    return (this.game?.getPlayers() ?? []).filter((p) => p.role === Role.WEREWOLF && p.alive && this.isAi(p.clientId));
  }

  private getAiMasons(): GamePlayer[] {
    return (this.game?.getPlayers() ?? []).filter((p) => p.role === Role.MASON && p.alive && this.isAi(p.clientId));
  }

  private getAiAlivePlayers(): GamePlayer[] {
    return (this.game?.getPlayers() ?? []).filter((p) => p.alive && this.isAi(p.clientId));
  }

  private isWolfReady(clientId: string): boolean {
    return this.wolfReadyMap.get(clientId) === true;
  }

  private isMasonReady(clientId: string): boolean {
    return this.masonReadyMap.get(clientId) === true;
  }

  /** 引擎是否已因安全上限停止狼會議 */
  private isAborted(): boolean {
    return this.game?.getNightState().wolfMeetingAborted === true;
  }

  private buildSystemPrompt(entry: AiEntry): string {
    return [
      `你是「${entry.def.nickname}」，在狼人殺遊戲中扮演「${entry.knowledge.displayName}」。`,
      entry.profile ? entry.profile.persona.slice(0, 600) : '',
      entry.profile?.memory ? `你的記憶：\n${entry.profile.memory}` : '',
      '硬規則：使用繁體中文。只回 JSON，不要多餘文字。禁止「我先講...」「讓我說...」前言、「不是...而是...」對立修正。語氣符合當下情境，不製造不存在的衝突。',
      '',
      '【說話（硬規則）】',
      '- 說人話：完整通順口語，禁單詞質問（「少講？」）、破碎斷句、突兀插入語。',
      '- 直接進內容：**嚴禁任何「宣告你在回應對方」的開頭**——「我接」「你那句我接」「這句話我接」「我收到了」「同意你這說法」「你說得對」「了解」都是同族，一律禁止。開頭就直接說你的判斷或動作。',
      '- 刪鋪陳：接受分派就直接講你負責的動作內容，不用宣告「我接」；禁「打法沒毛病」「大家一張白紙」這類場面話。',
      '- 動作要具體：要能寫出執行內容；「追問他」「盯緊他」＝空話禁說。',
      '- 全繁體中文：禁日文漢字（占い師）與簡體（当场）混入。',
      '- 排版：超過 50 字換行分段，≤3 段，順序＝判斷/結論→動作→給隊友提醒。',
      '',
      '## 場上證據邊界',
      '純口頭推理：唯一資訊是發言、表態、投票；無時間線/地點/行蹤/在場證明。禁假設玩家持某立場，除非白板發言實際出現過。',
    ].filter(Boolean).join('\n');
  }

  /** 追加到 AI 的全局 memory（跨階段不重置；4000 字上限，超出砍最舊） */
  appendMemory(clientId: string, text: string): void {
    const entry = this.entries.get(clientId);
    if (!entry?.profile) return;
    entry.profile.memory += `\n${text}`;
    if (entry.profile.memory.length > 4000) {
      entry.profile.memory = entry.profile.memory.slice(-4000);
    }
  }

  /** 狼白板歷史（prompt 用；無則提示沒有討論） */
  private wolfBoardText(): string {
    return this.wolfBoard.length
      ? this.wolfBoard.map((m) => `${m.from}：「${m.text}」`).join('\n')
      : '之前沒有任何討論，沒有人發過言。';
  }

  /** 共有者白板歷史（prompt 用；無則提示沒有討論） */
  private masonBoardText(): string {
    return this.masonBoard.length
      ? this.masonBoard.map((m) => `${m.from}：「${m.text}」`).join('\n')
      : '之前沒有任何討論，沒有人發過言。';
  }

  /** 可刀目標（排除自己、狼隊、狂人） */
  private eligibleTargets(entry: AiEntry): string {
    return (this.game?.getPlayers() ?? [])
      .filter((p) => p.alive && p.clientId !== entry.def.clientId && p.role !== Role.WEREWOLF && p.role !== Role.MADMAN)
      .map((p) => p.nickname)
      .join('、');
  }

  /** 狼 wolf 情境（system prompt 附加：Two-Level Split 結構） */
  private wolfContext(entry: AiEntry): string {
    const k = entry.knowledge;
    const deadNames = (this.game?.getPlayers() ?? []).filter((p) => !p.alive).map((p) => p.nickname).join('、') || '（無）';
    return [
      '## Level 1 策略核心（優先於角色表現）',
      `你是狼。目標：讓村民陣營滅亡。狼隊同夥：${k.partners.join('、')}。${k.madman ? `狂人：${k.madman}（不可刀）。` : ''}${deadNames !== '（無）' ? `已死亡（不在場）：${deadNames}。` : ''}`,
      '刀人優先序：占卜師 > 守衛/靈能者 > 村民。第一天無白天發言，角色判斷都是猜，選誰都可，禁「氣場」「感覺不對」當理由。**第 1 天刀人不用寫理由——沒有任何發言可參考，寫理由就是廢話，直接選定一個。**',
      '',
      '【說謊是狼的本職】假跳查驗結果隨便你編，村民不知道真假直到有人反駁；禁「我們沒依據」當反對理由——編一個就好。',
      '【演技決定成敗】雙CO 拆穿是機率不是必然，勝負看「這謊怎麼圓」，不是「反正會被拆穿」。',
      '【對跳結構＋天數（硬）】',
      '1. 真占反跳必有真實查驗結果，永遠報得出；他不會答不出、不會改口、不會自亂陣腳——「等他講錯」不存在，要贏靠你演得像、態度穩、把場面變成雙CO對決。',
      '2. 雙CO 成局＝村民二選一，勝負在結果可信度＋演技＋一致性。',
      '3. 假跳的價值在白天：釣真占現身（確認誰是真占、可引導村民白天處決他）＋讓村民在雙CO 二選一。**禁止把「晚上刀反跳者」當計畫**：雙CO 爭議期間反跳者夜裡死，村民看到「反跳方夜死、假跳方還活著」＝等於你承認他是真的、你是假的——自爆。刀人照會議另選目標，不受白天反跳影響。',
      '4. 天數：第1天無「過程」可追（真占答「我隨手挑的」就過，追問＝空拳），只能打演技/態度/一致性；第2天起才能追「你昨天懷疑誰、今天查誰」。',
      '【對跳期白天票鎖定】白天票鎖假跳宣稱目標（同夥說「X是人狼」→鎖X）；禁「真占點誰跟誰」——他可能點到你自己人。夜晚刀人照會議決議，兩回事。',
      '',
      '**禁止：** 白天策略對象＝你今晚刀的人；用代詞；speech 帶編號/機制用語（白板/會議）；「目標還沒發言」「先觀察」當理由。',
      '**正確：** 白天針對存活玩家、具體動作；刀人目標≠白天討論對象。',
      '',
      '## 戰術字典',
      '- 控票帶節奏：一隻狼帶頭點軟目標，其他狼附和。',
      '- 假跳/對跳占卜師：編查驗結果製造雙CO混亂→把真占逼出來；成敗看演技與圓謊。',
      '- 賣狼換信任、自刀：前兩天不划算。',
      '',
      '## 勝利綁定',
      '每步服務兩軸之一：夜間消耗（刀人優先序）／白天存活＋引導（票往錯方向走）。',
      '',
      '## Level 2 角色',
      '用角色語氣，2-4 句，用名字稱呼隊友。說「占卜師」不說「預言家」。',
    ].filter(Boolean).join('\n');
  }

  /** 共有者情境（system prompt 附加：共有者夥伴 + 私頻說明） */
  private masonContext(entry: AiEntry): string {
    const k = entry.knowledge;
    return [
      '你是村人陣營的共有者。你和你的夥伴是互相知道身份的盟友。',
      k.partners.length ? `你的共有者夥伴：${k.partners.join('、')}。` : '',
      '現在是共有者會議（私頻），只有你和你夥伴能看到。',
      '',
      '',
      '勝利條件（共有者版）：',
      '- 好人的勝利 = 白天處決出所有狼。共有者沒有驗人能力，你們跟普通村民一樣，只能靠白天討論找狼。',
      '- 共有者唯一的優勢：場上有兩個互相信任、可以說實話的人——村民多半孤軍奮戰，你們不是。',
      '- 兩大風險：① 被誤投（好人白死）② 身分暴露（被當刀目標）。',
      '',
      '共有者戰術字典（都是可選項，你要自己評估用不用）：',
      '1. CO（公開「我是共有者」）：',
      '   - 誘刀價值：CO 後狼傾向刀你——這對村民是好事，狼花一刀處理你，就沒刀處理占卜師/靈能者。你可以用 CO 換取保護真驗人角色。',
      '   - 錨點價值：CO 給村民兩個互信錨點，討論有方向；不 CO 則保持隱蔽，狼不知道你們是誰。',
      '   - 風險：CO 後失去隱蔽、發言被雙倍檢驗；兩個都 CO = 兩名好人一次暴露給狼。',
      '   - 時機：第一天就 CO（搶錨點、防假跳）／被質疑到無法自證時 CO（止血）／不 CO（隱匿）。',
      '2. 反假跳：若白天有人跳共有者而你或夥伴未 CO，你就是全場唯一能確認他是狼的人。但反證 = 揭露自己身分——用「揭露身分」換「確認一匹狼」，值不值要評估。',
      '3. 互信分工：一人拋話題、一人觀察反應；被咬時搭檔要救，但救法要自然，太大力會暴露同盟。',
      '4. 白天先求活：被誤投 = 白死，活著才有影響力。',
      '',
      '勝利路徑（共有者）：',
      '- 引導風向必須有依據：質疑誰，就要引用他「實際發過什麼言」。第一天大家剛開始講話，沒有內容可以質疑時，「攻擊誰」是空砲——第一天該做的是觀察，不是攻擊。',
      '- CO 與否是明天最重要的決策，出稿前必須主動評估（各種時機的利弊見戰術字典）——不要預設答案。',
    ].filter(Boolean).join('\n');
  }

  /** 草稿 prompt（獨立出稿：speech + stance）；輸出 {"speech":"...", "stance":"投XXX"|"資訊不足"} */
  private buildDraftPrompts(entry: AiEntry): ChatMessage[] {
    const aliveList = (this.game?.getPlayers() ?? []).filter((p) => p.alive).map((p) => p.nickname).join('、');
    const user = [
      `第 ${this.day} 夜，狼會議（私頻）。`,
      ``,
      `存活玩家：${aliveList}`,
      `可刀目標（只能從以下選）：${this.eligibleTargets(entry)}`,
      ``,
      `會議紀錄：`,
      this.wolfBoardText() || '（目前沒有發言）',
      ``,
      `任務：說一句話——① 你刀誰（會議已有共識目標時可省略）② 你明天白天做什麼（針對存活玩家）③ 你預期這個動作讓會議怎麼發展（潛伏時可省略）。`,
      `狼每晚必須刀人。「資訊不足」＝你還在考慮，最終必須選。`,
      ``,
      `出稿前先想清楚四件事，再寫 speech：`,
      `① 刀的目標服務哪個軸（夜間消耗/白天存活＋引導）？**第 1 天刀人不用寫理由**——沒有任何發言可參考，寫理由就是廢話，直接選定一個；第 2 天起，理由若有觀察依據再寫。`,
      `② 明天的白天動作選哪個：潛伏（三個都活著優先、最安全）／引導投票（把票導向某人、好處大但暴露風險高）／製造假資訊（發言讓村民互猜）／假跳或對跳占卜師（編查驗結果、製造雙CO混亂）？記住：第 1 天雙CO 時沒有過程可追、只能打演技戰。`,
      `③ 你的行動必須跟所選模式一致：`,
      `- 潛伏：狼隊不發起集體攻勢（禁止「誰帶頭點名＋誰補刀」的配合劇本）；三個狼藏法要分化——一個少講、一個正常參與但不可帶風向、一個被質疑時自衛。個別狼正常發言或自衛不違反潛伏。`,
      `- 引導投票：只有你明天有實際發言抓手（對方明天的發言矛盾）才選；寫出導向誰、抓他哪句。沒有抓手就選潛伏，不要為了有動作而點名。`,
      `- 製造假資訊：寫具體要放什麼假訊息、針對誰。`,
      `- 假跳/對跳：寫清楚編什麼查驗結果、誰來跳、怎麼圓謊、拆穿風險多高。`,
      `④ 收場推演：若選引導或假資訊，推演明天會議走向——被質疑的人怎麼回應、村民怎麼解讀（跟著懷疑還是反過來懷疑帶頭）、狼隊暴露風險；若選潛伏則不用推演，speech 直接寫分工就好。`,
      ``,
      `⚠️ 你選的刀人目標今晚就死，明天不在場。你的白天動作只能針對其他存活玩家。`,
      `⚠️ 用名字，不用代詞。具體動作，不用模糊觀察。`,
      `⚠️ 會議上已有刀人目標且無人反對時：speech 不要再重新宣布/附和「我刀誰」，直接聚焦明天戰術安排（誰帶節奏、質疑誰、怎麼配合）。`,
      ``,
      `JSON：{"speech": "...", "stance": "投[今晚刀的人名]"} 或 {"speech": "...", "stance": "資訊不足"}`,
      `**stance 硬規則：** stance＝**今晚刀人目標**（「投[人名]」），不是白天想投的人；白天想帶票（例：鎖假跳宣稱目標）只寫在 speech，不寫進 stance。`,
    ].join('\n');
    return [
      { role: 'system', content: `${this.buildSystemPrompt(entry)}\n${this.wolfContext(entry)}` },
      { role: 'user', content: user },
    ];
  }

  /** 回應 prompt（非發言者狼讀白板後回應）；輸出 {"action":"vote","target":"..."} 或 {"action":"speak","speech":"...","stance":"..."} 或 {"action":"wait"} */
  private buildResponsePrompts(entry: AiEntry, publishedSpeech: string): ChatMessage[] {
    const aliveList = (this.game?.getPlayers() ?? []).filter((p) => p.alive).map((p) => p.nickname).join('、');
    const user = [
      `第 ${this.day} 夜，狼會議（私頻）。`,
      ``,
      `存活玩家：${aliveList}`,
      `可刀目標（只能從以下選）：${this.eligibleTargets(entry)}`,
      ``,
      `會議紀錄（白板，全部發言）：`,
      this.wolfBoardText(),
      ``,
      `剛發布：「${publishedSpeech}」`,
      ``,
      `回應前先評估眼前這個刀人方案＋假跳計畫，再決定：`,
      `- 狩獵價值：這目標值不值得今晚用掉一刀？（占卜師 > 守衛/靈能者 > 村民）`,
      `- 執行風險：他明天可能反咬、被保護、或讓狼隊暴露嗎？你被分派的白天任務（若有的話）可行嗎？`,
      `- 白天推演：明天想質疑的對象，跟今晚刀的人有沒有重疊？`,
      `- 戰術比較：假跳/對跳占卜師有沒有更划算？該跳就說清楚編什麼結果、誰來跳、怎麼圓謊、拆穿風險多高。`,
      `- 對跳提醒：第 1 天雙CO 追問「為什麼查他」是空拳（真占答「我隨手挑的」就過），只能打演技/態度/一致性；真占不會改口不會自亂陣腳。**晚上禁止刀反跳者＝自爆**（反跳者夜裡死、假跳方還活著＝你承認他是真的），刀人照會議另選目標。白天帶票鎖假跳宣稱目標，和今晚刀誰是兩回事。`,
      `評估完沒問題 → 純附和（vote）完全沒問題。評估發現問題 → speak 指出問題＋替代方案。`,
      ``,
      `隊友的發言若在回應你之前的問題或分派你任務——先直接回應（接受/拒絕＋理由），再談其他。接受分派就用一句話確認，不必複述她的計畫。`,
      `假設性戰術討論視為已成立——直接面對「真發生時該怎麼做」，不要用「現在還沒發生」反駁。`,
      `論點品質關卡：每句先自問兩關——(1) 村民聽到的第一反應會不會是「這廢話/這我看得見」？(2) 對方或旁觀村民有沒有輕而易舉的反駁？任何一關過不了就不准說。只覆蓋高機率分支（真占反跳、報出自己的查驗結果），禁止鑽低機率連鎖假設。`,
      ``,
      `**stance 硬規則：** stance＝**今晚刀人目標**（「投[人名]」），不是白天想投的人；白天想帶票（例：鎖假跳宣稱目標）只寫在 speech，不寫進 stance。`,
      ``,
      `任務：看完後決定你的立場（三選一）：`,
      `1. 同意（方案完整，準備投票）→ {"action": "vote", "target": "今晚刀人目標的名字"}`,
      `2. 我要補充（有新角度或要改變立場）→ {"action": "speak", "speech": "完整通順口語、角色語氣、全繁體中文；開頭直接講判斷或動作，禁止任何「我接/我收到/同意你」類宣告開頭；超過50字須換行分段（≤3段）", "stance": "投[今晚刀的人名]"}`,
      `3. 資訊不足、先不講 → {"action": "wait"}`,
      ``,
      `⚠️ target 永遠是「今晚要刀的玩家」（從可刀目標裡選）——不是提案者、不是發言人、不是白天質疑對象、更不是狼隊友。`,
      `⚠️ 如果你之前已在會議上表態過（白板有你的名字+投XXX），且新發言不改變你的判斷 → 用 action="vote" 確認，不要用 wait。wait 只給還沒表態過的狼。`,
      `⚠️ 刀人目標今晚就死，白天動作只針對存活玩家。用名字，不用代詞。此頻道只有狼，不引用白板外發言。`,
      `⚠️ 會議已有共識刀人目標時，speech 不再重宣布刀誰（「我同意刀X」「支持刀X」這類）——只想重申既定目標／沒有新戰術 → 直接 action="vote"。speech 只能用來提明天的新戰術安排（誰帶節奏、質疑誰、怎麼配合、有沒有要改戰術）。`,
    ].join('\n');
    return [
      { role: 'system', content: `${this.buildSystemPrompt(entry)}\n${this.wolfContext(entry)}` },
      { role: 'user', content: user },
    ];
  }

  /** 共有者草稿 prompt（獨立出稿：speech + stance）；輸出 {"speech":"...", "stance":"準備好了"|"資訊不足"} */
  private buildMasonDraftPrompts(entry: AiEntry): ChatMessage[] {
    const partnerName = entry.knowledge.partners.join('、');
    const user = [
      `當前：第 ${this.day} 夜，共有者會議（私頻，只有你和你共有者夥伴能看到）。`,
      `你的共有者夥伴：${partnerName}`,
      ``,
      `白板上的對話：`,
      this.masonBoardText(),
      ``,
      `任務：提出你對明天白天會議的行動方針。你要說一句話（≤50字），並表明你的立場。`,
      `議題：明天白天我們怎麼行動——誰先拋話題、誰觀察大家的反應、被質疑時怎麼應對、要不要 CO（公開共有者身分）。`,
      ``,
      `出稿前先想清楚四件事，再寫 speech：`,
      `① 明天的動作服務哪個勝利條件：讓自己活下去（別被誤投）？保護關鍵角色（誘刀）？還是引導大家找到狼？`,
      `② CO 還是不 CO？為什麼？（CO 有誘刀＋錨點價值，但暴露自己；不 CO 隱蔽但不是錯誤——兩邊都要真正想過再選，不要因為害怕就預設不 CO）`,
      `③ 第一天大家才剛開始發言，還沒有內容可以「攻擊」——質疑必須引用實際發言，沒依據的攻擊是空砲還會暴露自己。所以第一天到底是攻擊還是觀察？`,
      `④ 具體怎麼做：誰做什麼、怎麼配合才不會讓別人看出你們是同盟？被質疑時要怎麼回應？`,
      ``,
      `回覆格式（JSON）：`,
      `{"speech": "你要說的話", "stance": "準備好了"}`,
      `或`,
      `{"speech": "你要說的話", "stance": "資訊不足"}`,
      `（stance 是「準備好了」表示你對明天有方針了；「資訊不足」表示你還沒想好）`,
    ].join('\n');
    return [
      { role: 'system', content: `${this.buildSystemPrompt(entry)}\n${this.masonContext(entry)}` },
      { role: 'user', content: user },
    ];
  }

  /** 共有者回應 prompt（非發言者讀白板後回應）；輸出 {"action":"vote","target":"ready"} 或 {"action":"speak","speech":"...","stance":"..."} 或 {"action":"wait"} */
  private buildMasonResponsePrompts(entry: AiEntry, publishedSpeech: string): ChatMessage[] {
    const partnerName = entry.knowledge.partners.join('、');
    const user = [
      `當前：第 ${this.day} 夜，共有者會議（私頻，只有你和你共有者夥伴能看到）。`,
      `你的共有者夥伴：${partnerName}`,
      ``,
      `白板上的對話：`,
      this.masonBoardText(),
      ``,
      `剛發布的發言：「${publishedSpeech}」`,
      ``,
      `回應前先評估夥伴的方案（用戰術字典對照），再決定：`,
      `- 分工合理嗎（誰做什麼）？CO/隱蔽的選擇符合戰術字典嗎（會雙重暴露嗎）？`,
      `- 第一天還沒有發言內容，他有沒有為了「攻擊」而鎖定一個還沒發言的人？（不行——質疑必須有實際發言依據）`,
      `- 這方案有沒有讓人看出你們是同盟的風險？`,
      `- 被質疑時有應對嗎？若指派你任務，你接受的具體任務是什麼？`,
      `評估完沒問題 → 簡短同意（「就這麼辦」「我跟你」）。評估發現問題 → speak 帶新角度。`,
      ``,
      `任務：看完後決定你的立場（三選一）：`,
      `1. 準備好了 → {"action": "vote", "target": "ready"}`,
      `2. 我要講 → {"action": "speak", "speech": "你要說的話（≤50字）", "stance": "準備好了" 或 "資訊不足"}`,
      `3. 資訊不足、先不講 → {"action": "wait"}`,
      ``,
      `要求：同意就簡短（「就這麼辦」「我跟你」），不用重述隊友已經講過的理由。要講就講新的角度。`,
      `提醒：這是私頻。用你的角色語氣說話。不要說「沒人發言」「目前沒人發言」「白板是空的」——直接回應。`,
    ].join('\n');
    return [
      { role: 'system', content: `${this.buildSystemPrompt(entry)}\n${this.masonContext(entry)}` },
      { role: 'user', content: user },
    ];
  }

  /** 白天討論草稿 prompt；輸出 {"speech":"...", "stance":"準備好了"|"資訊不足"} */
  private buildDayDraftPrompts(entry: AiEntry): ChatMessage[] {
    const k = entry.knowledge;
    const aliveList = (this.game?.getPlayers() ?? []).filter((p) => p.alive).map((p) => p.nickname).join('、');
    const boardText = this.dayBoard.length
      ? this.dayBoard.map((m) => `${m.from}：「${m.text}」`).join('\n')
      : '目前沒有人發過言。';
    const user = [
      `當前：第 ${this.day} 天 白天討論。`,
      `存活玩家：${aliveList}`,
      k.privateInfo ? `你的情報：${k.privateInfo}` : '',
      ``,
      `目前的討論：`,
      boardText,
      ``,
      `任務：發表你的看法（一句話，≤50字），並表明你是否準備投票了。`,
      `要求：用你的角色語氣說話。不要說「沒人發言」「目前沒人發言」。要有具體內容（質疑、分析、表態）。`,
      `⚠️ 這是純口頭推論遊戲。沒有路徑、軌跡、不在場證明、操作記錄。唯一證據：發言內容、邏輯矛盾、表態變化、投票行為。`,
      `⚠️ 發言要針對「具體玩家」：質疑誰、支持誰、分析誰的發言。點名從存活玩家中選。`,
      `但只能質疑「已發過言」的玩家的實際內容。若目前沒人發言，就談你觀察到什麼、想先聽誰表態——不要質疑沒發言的人，更不要假設任何人的立場。`,
      `⚠️ 禁止只談討論方法（「我們先定規則」「逐條比對」「口徑要公開」）——那是空轉，不算有效發言。要講就講對某個玩家的看法。`,
      ``,
      `發言前：根據目前白板狀況，你的策略要微調嗎？要的話先寫出更新。`,
      ``,
      `回覆格式（JSON）：`,
      `{"strategy_update": "更新後的策略" 或 null, "speech": "你要說的話", "stance": "準備好了"}`,
      `或`,
      `{"strategy_update": null, "speech": "你要說的話", "stance": "資訊不足"}`,
      `（「準備好了」＝你講完了，準備投票；「資訊不足」＝你還想再聽聽；strategy_update 為 null 表示策略不變）`,
    ].filter(Boolean).join('\n');
    return [
      { role: 'system', content: this.buildSystemPrompt(entry) },
      { role: 'user', content: user },
    ];
  }

  /** 白天討論回應 prompt；輸出含 strategy_update + action(ready/speak/wait) */
  private buildDayResponsePrompts(entry: AiEntry, publishedSpeech: string): ChatMessage[] {
    const k = entry.knowledge;
    const boardText = this.dayBoard.length
      ? this.dayBoard.map((m) => `${m.from}：「${m.text}」`).join('\n')
      : '目前沒有人發過言。';
    const user = [
      `當前：第 ${this.day} 天 白天討論。`,
      `存活玩家：${(this.game?.getPlayers() ?? []).filter((p) => p.alive).map((p) => p.nickname).join('、')}`,
      ``,
      `目前的討論：`,
      boardText,
      ``,
      `剛發表的發言：「${publishedSpeech}」`,
      ``,
      `聽完這段發言，你的策略需要調整嗎？需要就寫出更新。`,
      `然後決定你的反應（三選一）：`,
      `1. 我講完了，準備投票 → {"action": "ready"}`,
      `2. 我要補充 → {"action": "speak", "speech": "你要說的話（≤50字）", "stance": "準備好了" 或 "資訊不足"}`,
      `3. 我先聽聽 → {"action": "wait"}`,
      ``,
      `要求：同意就簡短。要講就講新的角度，不要重複別人講過的。用你的角色語氣。`,
      `⚠️ 純口頭推論遊戲。沒有路徑、軌跡、不在場證明、操作記錄。唯一證據：發言、矛盾、表態、投票。`,
      `⚠️ 發言要針對「具體玩家」：質疑誰/支持誰/分析誰。禁止只談討論方法（定規則、訂口徑、逐條比對）——那是空轉，不推進討論。`,
      `只能質疑「已發過言」的玩家的實際內容；不要假設沒發言的人的立場，也不要編造別人講過的話。`,
      `⚠️ 若某段發言沒有指名任何玩家、只是在談規則，不要附和它——把討論拉回人身上：誰可疑、誰可信。`,
      ``,
      `回覆格式（JSON）：`,
      `{"strategy_update": "更新後的策略" 或 null, "action": "ready"}`,
      `或 {"strategy_update": null, "action": "speak", "speech": "...", "stance": "..."}`,
      `或 {"strategy_update": null, "action": "wait"}`,
    ].join('\n');
    return [
      { role: 'system', content: this.buildSystemPrompt(entry) },
      { role: 'user', content: user },
    ];
  }

  /** 狼刀目標選擇 prompt（狼隊同夥 + 可刀目標 + 討論歷史；輸出 {"target":"<displayName>"}） */
  private buildWolfKillPrompts(entry: AiEntry): ChatMessage[] {
    const k = entry.knowledge;
    const history = k.recentMessages.length
      ? k.recentMessages.map((m) => `${m.from}：「${m.text}」`).join('\n')
      : '之前沒有任何討論。';
    const user = [
      `當前：第 ${this.day} 夜，狼會議投票。你是 ${k.displayName}（人狼）。`,
      k.partners.length ? `你的狼隊同夥：${k.partners.join('、')}。` : '',
      k.madman ? `狂人：${k.madman}（不可刀）。` : '',
      `可刀目標（只能從以下選）：${this.eligibleTargets(entry)}`,
      ``,
      `之前的討論：`,
      history,
      ``,
      `任務：選一個你要刀的人。`,
      `回覆格式：{"target": "<displayName>"}`,
    ].filter(Boolean).join('\n');
    return [
      { role: 'system', content: this.buildSystemPrompt(entry) },
      { role: 'user', content: user },
    ];
  }

  /** 白天投票 prompt；輸出 {"target":"<displayName>"} 或 {"target":null}（棄票） */
  private buildDayVotePrompts(entry: AiEntry): ChatMessage[] {
    const k = entry.knowledge;
    const aliveList = (this.game?.getPlayers() ?? [])
      .filter((p) => p.alive && p.clientId !== entry.def.clientId)
      .map((p) => p.nickname)
      .join('、');
    const boardText = this.dayBoard.length
      ? this.dayBoard.map((m) => `${m.from}：「${m.text}」`).join('\n')
      : '今天沒有討論。';
    const user = [
      `當前：第 ${this.day} 天 投票階段。你是 ${k.displayName}。`,
      `存活玩家（可投票對象）：${aliveList}`,
      k.privateInfo ? `你的情報：${k.privateInfo}` : '',
      ``,
      `今天的討論：`,
      boardText,
      ``,
      `任務：選一個你要投票淘汰的玩家。如果你不確定，可以棄票。`,
      `依據：根據今天白天討論的內容投票——誰的發言最可疑、誰被多人質疑、誰在討論中自相矛盾。`,
      `如果今天討論中你曾明確質疑某人，優先投他。不要投給「只談規則但沒被質疑」的人。`,
      `回覆格式：{"target": "<displayName>"} 或 {"target": null}（棄票）`,
    ].filter(Boolean).join('\n');
    return [
      { role: 'system', content: this.buildSystemPrompt(entry) },
      { role: 'user', content: user },
    ];
  }

  /** 占い／守衛目標選擇 prompt（角色 + 存活玩家 + 過去行動；輸出 {"target":"<displayName>"}） */
  private buildTargetPrompts(entry: AiEntry, kind: 'SEER_CHECK' | 'GUARD_PROTECT'): ChatMessage[] {
    const k = entry.knowledge;
    const aliveList = (this.game?.getPlayers() ?? [])
      .filter((p) => p.alive)
      .map((p) => p.nickname)
      .join('、');
    const task = kind === 'SEER_CHECK'
      ? '任務：選一個你要查驗的人（不可選自己）。'
      : '任務：選一個你要守護的人（不可選自己）。';
    const user = [
      `當前：第 ${this.day} 夜。你是 ${k.displayName}。`,
      `存活玩家：${aliveList}`,
      k.privateInfo ? `你的情報：${k.privateInfo}` : '',
      task,
      `回覆格式：{"target": "<displayName>"}`,
    ].filter(Boolean).join('\n');
    return [
      { role: 'system', content: this.buildSystemPrompt(entry) },
      { role: 'user', content: user },
    ];
  }

  /** 占い／守衛：LLM 選目標 → 提交夜間行動（失敗重試；最終失敗跳過、不阻塞） */
  private async runTargetAction(clientId: string, kind: 'SEER_CHECK' | 'GUARD_PROTECT'): Promise<void> {
    const entry = this.entries.get(clientId);
    if (!entry || !this.game) return;
    const prompts = this.buildTargetPrompts(entry, kind);
    const extract = (parsed: Record<string, any>): string | null =>
      this.resolveClientId(String(parsed.target ?? ''), (p) => p.clientId !== clientId);
    const result = await this.llmWithRetry(clientId, kind, this.day, prompts, extract);
    if (result.value !== null) {
      this.game.handleNightAction(clientId, { type: kind, targetClientId: result.value });
    }
  }

  /** 所有 AI 獨立出草稿（全併發 LLM 呼叫） */
  private async generateDayDrafts(players: GamePlayer[]): Promise<DayDraft[]> {
    const results = await Promise.all(players.map(async (p, i) => {
      if (this.destroyed) return null;
      const entry = this.entries.get(p.clientId);
      if (!entry) return null;
      const prompts = this.buildDayDraftPrompts(entry);
      const result = await this.llmWithRetry(p.clientId, 'DAY_SPEECH', this.day, prompts, (p2) =>
        typeof p2.speech === 'string' && p2.speech.trim() && typeof p2.stance === 'string' ? 'ok' : null, 100 + i);
      if (result.parsed?.strategy_update && typeof result.parsed.strategy_update === 'string') {
        this.appendMemory(p.clientId, `[Day${this.day}] ${result.parsed.strategy_update.trim()}`);
      }
      if (result.value === null) return null;
      return { player: p, speech: (result.parsed!.speech as string).trim(), stance: (result.parsed!.stance as string).trim() } as DayDraft;
    }));
    return results.filter((d): d is DayDraft => d !== null);
  }

  /** Judge 盲選一篇白天草稿（LLM 全盲評分） */
  private async judgePickDayDraft(drafts: DayDraft[]): Promise<DayDraft | null> {
    if (drafts.length === 0) return null;
    if (drafts.length === 1) return drafts[0];
    const idx = await this.judgeScoreIndex(drafts.map((d) => d.speech), this.day);
    this.logEntry('', 'JUDGE', this.day, 1, [], null, { picked: drafts[idx].player.nickname, from: drafts.length, meeting: 'day' });
    return drafts[idx];
  }

  /** 非發言者 AI 讀白板後回應：ready / speak / wait */
  private async dayRespond(
    p: GamePlayer,
    entry: AiEntry,
    publishedSpeech: string,
    priority?: number,
  ): Promise<{ type: 'ready' } | { type: 'speak'; speech: string; stance: string } | { type: 'wait' }> {
    const prompts = this.buildDayResponsePrompts(entry, publishedSpeech);
    const result = await this.llmWithRetry(p.clientId, 'DAY_STANCE', this.day, prompts, (p2) => {
      if (p2.action === 'ready') return 'ok';
      if (p2.action === 'speak' && typeof p2.speech === 'string' && p2.speech.trim() && typeof p2.stance === 'string') return 'ok';
      if (p2.action === 'wait') return 'ok';
      return null;
    }, priority);
    // 滾動策略調整：若 LLM 回傳 strategy_update，append 到 memory
    if (result.parsed?.strategy_update && typeof result.parsed.strategy_update === 'string') {
      this.appendMemory(p.clientId, `[Day${this.day}] ${result.parsed.strategy_update.trim()}`);
    }
    if (result.value === null) return { type: 'wait' };
    const p2 = result.parsed!;
    if (p2.action === 'ready') return { type: 'ready' };
    if (p2.action === 'speak') return { type: 'speak', speech: (p2.speech as string).trim(), stance: (p2.stance as string).trim() };
    return { type: 'wait' };
  }
}
