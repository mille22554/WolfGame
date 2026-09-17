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
  buildJudgePrompt,
  type CharacterProfile,
} from './ai-player.js';
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
  recentMessages: { from: string; text: string }[];
}

interface AiEntry {
  def: AiPlayerDef;
  profile: CharacterProfile | null;
  knowledge: AiKnowledge;
}

const MAX_LLM_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export class AiController {
  private entries = new Map<string, AiEntry>();
  private game: GameEngine | null = null;
  private log: AiLogEntry[] = [];
  private destroyed = false;
  private timers: NodeJS.Timeout[] = [];
  private phase: string = 'ROLE_REVEAL';
  private day: number = 1;
  private readonly llmTimeoutMs: number;
  /** 狼白板（本夜全部 WOLF_MESSAGE；每夜重置） */
  private wolfBoard: { from: string; text: string }[] = [];
  /** 白板游標：「最新一輪」= wolfBoard.slice(boardCursor)（judge 選完後推進） */
  private boardCursor: number = 0;
  /** judge 選言序號（WOLF_SPEECH_SELECTED.round；本夜遞增） */
  private selectionSeq: number = 0;
  /** wolf clientId -> 是否 toggle ready ON（由攔截的 WOLF_READY 訊息維護） */
  private wolfReadyMap = new Map<string, boolean>();

  constructor(defs: AiPlayerDef[], opts?: { llmTimeoutMs?: number }) {
    this.llmTimeoutMs = opts?.llmTimeoutMs ?? 60000;
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
      // 共有者無需 LLM 決策：直接 toggle ON
      for (const p of players) {
        if (!this.isAi(p.clientId)) continue;
        this.logEntry(p.clientId, 'MASON_TOGGLE', 0, 1, [], null, null);
        this.game.handleToggleMasonEndTurn(p.clientId);
      }
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
      }
      return;
    }
    if (m.type === 'NIGHT_RESULT') return; // 僅 phase 追蹤，無知識變更
    if (m.type === 'WOLF_READY') {
      if (typeof m.clientId === 'string') this.wolfReadyMap.set(m.clientId, m.ready === true);
      return;
    }
    if (m.type === 'WOLF_MESSAGE') {
      this.wolfBoard.push({ from: String(m.from ?? ''), text: String(m.text ?? '') });
    }
    if (m.type !== 'WOLF_MESSAGE' && m.type !== 'MASON_MESSAGE') return;
    for (const [clientId, entry] of this.entries) {
      if (targetClientIds && !targetClientIds.includes(clientId)) continue;
      entry.knowledge.recentMessages.push({ from: String(m.from ?? ''), text: String(m.text ?? '') });
      if (entry.knowledge.recentMessages.length > 30) entry.knowledge.recentMessages.shift();
    }
  }

  // --- 狼會議（連續對話制，規格 §12.3 / §13.6） ---

  /** 狼會議 DISCUSSION：0 全狼發一句 → loop（0.5 judge 選言 → 1 表態 → 分歧接著聊）直到全 ready 或停止 */
  private async runWolfDiscussion(round: number): Promise<void> {
    const wolves = this.getAiWolves();
    if (wolves.length === 0 || !this.game) return;
    this.boardCursor = this.wolfBoard.length; // 本輪新訊息從這裡算
    // 狀態 0：所有存活狼各發一句（round 1＝首句；平票後再進 DISCUSSION＝接著聊）
    for (const w of wolves) {
      if (this.destroyed || this.isAborted()) return;
      await this.wolfSpeak(w, round);
    }
    // loop：0.5 judge 選一篇 → 1 其他狼表態（接受→ready／反對→接著聊）→ 全 ready 時引擎已進 VOTING
    let guard = 0;
    while (this.game.getNightState().wolfSubphase === 'DISCUSSION' && !this.isAborted() && !this.destroyed) {
      if (++guard > 150) break; // 雙保險（引擎 100 則上限是主兜底）
      const selected = await this.judgeSelect(round);
      if (!selected) break; // 沒有新訊息（全跳過）→ 停止，避免空轉
      await this.runStancePhase(round, selected);
    }
    if (this.isAborted()) {
      this.logEntry('', 'WOLF_ABORT', round, 1, [], null, { count: this.game.getNightState().wolfMessageCount });
    }
  }

  /** 狀態 0／2：單隻狼發一句（LLM 生成；失敗重試，最終失敗跳過不阻塞） */
  private async wolfSpeak(w: GamePlayer, round: number): Promise<void> {
    const entry = this.entries.get(w.clientId);
    if (!entry || !this.game) return;
    const prompts = this.buildWolfSpeechPrompts(entry, round === 1);
    const result = await this.llmWithRetry(w.clientId, 'WOLF_SPEECH', round, prompts, (p) =>
      typeof p.speech === 'string' && p.speech.trim() ? p.speech.trim() : null);
    if (result.value !== null) this.game.handleWolfChat(w.clientId, result.value);
  }

  /** 狀態 0.5：judge 全盲評分「最新一輪」發言、選最高分 → broadcast WOLF_SPEECH_SELECTED（回選中發言；無新訊息回 null） */
  private async judgeSelect(round: number): Promise<{ from: string; text: string } | null> {
    const latest = this.wolfBoard.slice(this.boardCursor);
    if (latest.length === 0 || !this.game) return null;
    const texts = latest.map((m) => m.text);
    const prompts = buildJudgePrompt(texts);
    const result = await this.llmWithRetry('', 'JUDGE', round, prompts, (p) =>
      Array.isArray(p.scores) ? 'ok' : null);
    // 選最高分（同分取先）；judge 最終失敗 → 兜底選第一篇（不阻塞流程）
    const scores: number[] = result.parsed?.scores ?? texts.map(() => 0);
    let idx = 0;
    for (let i = 1; i < texts.length; i++) {
      if ((scores[i] ?? 0) > (scores[idx] ?? 0)) idx = i;
    }
    const selected = latest[idx];
    if (!selected) return null;
    this.boardCursor = this.wolfBoard.length;
    this.selectionSeq += 1;
    this.game.broadcastToWolves({
      type: 'WOLF_SPEECH_SELECTED',
      round: this.selectionSeq,
      from: selected.from,
      text: selected.text,
    });
    return { from: selected.from, text: selected.text };
  }

  /** 狀態 1：代表狼 toggle ready；其他未 ready 狼表態（接受→ready；反對→接著聊；失敗→跳過） */
  private async runStancePhase(round: number, selected: { from: string; text: string }): Promise<void> {
    const game = this.game;
    if (!game) return;
    const rep = this.resolveWolfByNickname(selected.from);
    if (rep && this.isAi(rep.clientId) && !this.isWolfReady(rep.clientId)) {
      game.handleToggleWolfReady(rep.clientId);
    }
    for (const w of this.getAiWolves()) {
      if (this.destroyed || this.isAborted()) return;
      if (w.clientId === rep?.clientId) continue; // 代表狼已表態（同意自己的發言）
      if (this.isWolfReady(w.clientId)) continue; // 之前已接受的狼不重複表態
      const entry = this.entries.get(w.clientId);
      if (!entry) continue;
      const prompts = this.buildWolfStancePrompts(entry, selected);
      const result = await this.llmWithRetry(w.clientId, 'WOLF_STANCE', round, prompts, (p) =>
        typeof p.accept === 'boolean' ? (p.accept ? 'accept' : 'reject') : null);
      if (result.value === 'accept') {
        game.handleToggleWolfReady(w.clientId);
      } else if (result.value === 'reject') {
        // 狀態 2：接著聊（新訊息建立在白板之前的對話上）；speech 缺失 → 視為跳過
        const speech = result.parsed?.speech;
        if (typeof speech === 'string' && speech.trim()) game.handleWolfChat(w.clientId, speech.trim());
      }
      // 最終失敗（value === null）→ 該狼跳過（不阻塞，由安全上限兜底）
    }
  }

  /** 狼會議 VOTING：每隻 AI 狼 LLM 選刀人目標 → 提交 WOLF_KILL（失敗重試；最終失敗跳過、不阻塞） */
  private async runWolfVoting(round: number): Promise<void> {
    const wolves = this.getAiWolves();
    for (const w of wolves) {
      if (this.destroyed || !this.game) return;
      const entry = this.entries.get(w.clientId);
      if (!entry) continue;
      const prompts = this.buildWolfKillPrompts(entry);
      const extract = (parsed: Record<string, any>): string | null =>
        this.resolveClientId(String(parsed.target ?? ''), (p) => p.clientId !== w.clientId && p.role !== Role.MADMAN);
      const result = await this.llmWithRetry(w.clientId, 'WOLF_KILL', round, prompts, extract);
      if (result.value !== null) {
        this.game.handleNightAction(w.clientId, { type: 'WOLF_KILL', targetClientId: result.value });
      }
    }
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
  ): Promise<{ response: string | null; parsed: Record<string, any> | null; value: string | null }> {
    let response: string | null = null;
    let parsed: Record<string, any> | null = null;
    for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
      if (this.destroyed) break;
      response = await chat(prompts, { temperature: 1.0, timeoutMs: this.llmTimeoutMs });
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

  private isWolfReady(clientId: string): boolean {
    return this.wolfReadyMap.get(clientId) === true;
  }

  /** 引擎是否已因安全上限停止狼會議 */
  private isAborted(): boolean {
    return this.game?.getNightState().wolfMeetingAborted === true;
  }

  private buildSystemPrompt(entry: AiEntry): string {
    return [
      `你是「${entry.def.nickname}」，在狼人殺遊戲中扮演「${entry.knowledge.displayName}」。`,
      entry.profile ? entry.profile.persona.slice(0, 600) : '',
      '硬規則：使用繁體中文。你只能回覆 JSON，不要多餘文字。不要 markdown。',
      '禁止：「我先講...」「讓我說...」等前言；「不是...而是...」等對立修正句型；不適用於當前情境的抽象策略語言。',
      '你的角色語氣要符合當下社交情境。如果大家都同意，不要製造不存在的衝突。',
    ].filter(Boolean).join('\n');
  }

  /** 狼白板歷史（prompt 用；無則提示沒有討論） */
  private wolfBoardText(): string {
    return this.wolfBoard.length
      ? this.wolfBoard.map((m) => `${m.from}：「${m.text}」`).join('\n')
      : '之前沒有任何討論，沒有人發過言。';
  }

  /** 可刀目標（排除自己、狼隊、狂人） */
  private eligibleTargets(entry: AiEntry): string {
    return (this.game?.getPlayers() ?? [])
      .filter((p) => p.alive && p.clientId !== entry.def.clientId && p.role !== Role.WEREWOLF && p.role !== Role.MADMAN)
      .map((p) => p.nickname)
      .join('、');
  }

  /** 狼 wolf 情境（system prompt 附加：狼隊同夥 + 狂人 + 私頻說明） */
  private wolfContext(entry: AiEntry): string {
    const k = entry.knowledge;
    return [
      '你是人狼陣營。',
      k.partners.length ? `你的狼隊同夥：${k.partners.join('、')}。` : '',
      k.madman ? `狂人：${k.madman}（不可刀）。` : '',
      '現在是狼會議（私頻），只有人狼能看到。',
    ].filter(Boolean).join('\n');
  }

  /** 狀態 0／2 發言 prompt（首句：提刀人目標＋理由；接著聊：建立在白板對話上）；輸出 {"speech"} */
  private buildWolfSpeechPrompts(entry: AiEntry, isFirstRound: boolean): ChatMessage[] {
    const task = isFirstRound
      ? '任務：提出一個刀人目標並簡述理由（≤50字）。'
      : '任務：接著白板討論，表明你現在對刀人目標的立場（≤50字）。可以引用或回應白板上的發言。';
    const user = [
      `當前：第 ${this.day} 夜，狼會議（私頻，只有人狼能看到）。`,
      `可刀目標（只能從以下選）：${this.eligibleTargets(entry)}`,
      ``,
      `白板歷史：`,
      this.wolfBoardText(),
      ``,
      task,
      `提醒：理由只能引用上面「白板歷史」裡實際出現的內容。若是第一次討論，就提出你的初始建議，不要回應不存在的發言。「沒有人發言」是第一天夜裡的預設狀態，不是任何人的特徵，不能當作刀他的理由。沒有具體資訊就直說「我直覺選他」。用你的角色語氣說話。`,
      `回覆格式：{"speech": "..."}`,
    ].join('\n');
    return [
      { role: 'system', content: `${this.buildSystemPrompt(entry)}\n${this.wolfContext(entry)}` },
      { role: 'user', content: user },
    ];
  }

  /** 狀態 1 表態 prompt（代表狼發言＋白板歷史；輸出 {"accept":bool, "speech"?:...}） */
  private buildWolfStancePrompts(entry: AiEntry, selected: { from: string; text: string }): ChatMessage[] {
    const user = [
      `當前：第 ${this.day} 夜，狼會議（私頻，只有人狼能看到）。`,
      `可刀目標（只能從以下選）：${this.eligibleTargets(entry)}`,
      ``,
      `白板歷史：`,
      this.wolfBoardText(),
      ``,
      `代表發言（judge 選出）：${selected.from} 說：「${selected.text}」`,
      ``,
      `任務：判斷是否接受這個刀人提案。資訊夠、同意 → accept；不同意或還有事要討論 → reject 並簡述理由（≤50字）。`,
      `回覆格式：{"accept": true} 或 {"accept": false, "speech": "..."}`,
    ].join('\n');
    return [
      { role: 'system', content: `${this.buildSystemPrompt(entry)}\n${this.wolfContext(entry)}` },
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
}
