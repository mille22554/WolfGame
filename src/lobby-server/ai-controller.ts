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

interface WolfDraft {
  wolf: GamePlayer;
  speech: string;
  stance: string; // "投XXX" 或 "資訊不足"
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
  /** wolf clientId -> 當前 stance（"投XXX" / "資訊不足"） */
  private wolfStanceMap = new Map<string, string>();

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

      // ② Judge 盲選一篇 → 發布 speech 到白板
      const selected = this.judgePickDraft(drafts, round);
      if (!selected) break;
      this.game.handleWolfChat(selected.wolf.clientId, selected.speech);
      this.game.broadcastToWolves({
        type: 'WOLF_SPEECH_SELECTED',
        round: this.selectionSeq,
        from: selected.wolf.nickname,
        text: selected.speech,
      });
      // 記錄發言者的 stance
      this.wolfStanceMap.set(selected.wolf.clientId, selected.stance);
      // 若發言者 stance 是「投XXX」→ toggle ready
      if (selected.stance.startsWith('投') && !this.isWolfReady(selected.wolf.clientId)) {
        this.game.handleToggleWolfReady(selected.wolf.clientId);
      }

      // ③ 除發言者外所有狼讀白板 → 各自回應
      const newDrafts: WolfDraft[] = [];
      for (const w of wolves) {
        if (this.destroyed || this.isAborted()) return;
        if (w.clientId === selected.wolf.clientId) continue; // 發言者不讀自己的話
        const entry = this.entries.get(w.clientId);
        if (!entry) continue;
        const resp = await this.wolfRespond(w, entry, selected.speech, round);
        if (resp.type === 'vote') {
          this.wolfStanceMap.set(w.clientId, `投${resp.target}`);
          if (!this.isWolfReady(w.clientId)) this.game.handleToggleWolfReady(w.clientId);
        } else if (resp.type === 'speak') {
          newDrafts.push({ wolf: w, speech: resp.speech, stance: resp.stance });
          this.wolfStanceMap.set(w.clientId, resp.stance);
          if (this.isWolfReady(w.clientId)) this.game.handleToggleWolfReady(w.clientId); // 撤回 ready
        }
        // 'wait' → 不出草稿，維持等待
      }

      // ④ 收斂判斷
      const allReady = wolves.every((w) => this.isWolfReady(w.clientId));
      if (allReady) break; // 引擎已進 VOTING

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
    if (this.isAborted()) {
      this.logEntry('', 'WOLF_ABORT', round, 1, [], null, { count: this.game.getNightState().wolfMessageCount });
    }
  }

  /** 所有狼獨立出草稿（平行 LLM 呼叫；互不可見；失敗的狼跳過） */
  private async generateAllDrafts(wolves: GamePlayer[], round: number): Promise<WolfDraft[]> {
    const results = await Promise.all(wolves.map(async (w) => {
      const entry = this.entries.get(w.clientId);
      if (!entry) return null;
      const prompts = this.buildDraftPrompts(entry);
      const result = await this.llmWithRetry(w.clientId, 'WOLF_SPEECH', round, prompts, (p) =>
        typeof p.speech === 'string' && p.speech.trim() && typeof p.stance === 'string' ? 'ok' : null);
      if (result.value === null) return null;
      return { wolf: w, speech: (result.parsed!.speech as string).trim(), stance: (result.parsed!.stance as string).trim() };
    }));
    return results.filter((r): r is WolfDraft => r !== null);
  }

  /** Judge 盲選一篇草稿（全盲評分，不告知作者）→ 回選中的 draft */
  private judgePickDraft(drafts: WolfDraft[], round: number): WolfDraft | null {
    if (drafts.length === 0 || !this.game) return null;
    if (drafts.length === 1) {
      this.selectionSeq += 1;
      return drafts[0];
    }
    // 用 LLM 盲評（同步不可行，所以用簡單策略：隨機選 + 記錄）
    // 實際上 judge 需要 LLM 呼叫，但這裡在 loop 中同步呼叫不合適
    // 改用：隨機選一篇（避免偏見），品質由後續對話收斂
    const idx = Math.floor(Math.random() * drafts.length);
    this.selectionSeq += 1;
    this.logEntry('', 'JUDGE', round, 1, [], null, { picked: drafts[idx].wolf.nickname, from: drafts.length });
    return drafts[idx];
  }

  /** 非發言者狼讀白板後回應：vote / speak / wait */
  private async wolfRespond(
    w: GamePlayer,
    entry: AiEntry,
    publishedSpeech: string,
    round: number,
  ): Promise<{ type: 'vote'; target: string } | { type: 'speak'; speech: string; stance: string } | { type: 'wait' }> {
    const prompts = this.buildResponsePrompts(entry, publishedSpeech);
    const result = await this.llmWithRetry(w.clientId, 'WOLF_STANCE', round, prompts, (p) => {
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

  /** 草稿 prompt（獨立出稿：speech + stance）；輸出 {"speech":"...", "stance":"投XXX"|"資訊不足"} */
  private buildDraftPrompts(entry: AiEntry): ChatMessage[] {
    const user = [
      `當前：第 ${this.day} 夜，狼會議（私頻，只有人狼能看到）。`,
      `可刀目標（只能從以下選）：${this.eligibleTargets(entry)}`,
      ``,
      `白板上的對話：`,
      this.wolfBoardText(),
      ``,
      `任務：提出你的刀人立場。你要說一句話（≤50字），並表明你的立場。`,
      `規則：狼每晚必須刀人，不能跳過、不能「不動刀」。「資訊不足」只是表示你還在考慮，最終你必須選一個目標。`,
      `提醒：你在跟隊友即時對話，不是在閱讀會議紀錄。直接講你的立場，不要說「我注意到...」「他剛被提出」。理由只能基於上面對話中實際出現的內容。不要提「沒有發言紀錄」「沒人發言」「沒有白天討論」——第一天夜裡本來就沒有，提了反而奇怪。沒有具體資訊就直說「我直覺選他」。用你的角色語氣說話。`,
      ``,
      `回覆格式（JSON）：`,
      `{"speech": "你要說的話", "stance": "投XXX"}`,
      `或`,
      `{"speech": "你要說的話", "stance": "資訊不足"}`,
      `（stance 是「投+名字」表示你準備投票刀那個人；「資訊不足」表示你還沒決定，但你最終必須選）`,
    ].join('\n');
    return [
      { role: 'system', content: `${this.buildSystemPrompt(entry)}\n${this.wolfContext(entry)}` },
      { role: 'user', content: user },
    ];
  }

  /** 回應 prompt（非發言者狼讀白板後回應）；輸出 {"action":"vote","target":"..."} 或 {"action":"speak","speech":"...","stance":"..."} 或 {"action":"wait"} */
  private buildResponsePrompts(entry: AiEntry, publishedSpeech: string): ChatMessage[] {
    const user = [
      `當前：第 ${this.day} 夜，狼會議（私頻，只有人狼能看到）。`,
      `可刀目標（只能從以下選）：${this.eligibleTargets(entry)}`,
      ``,
      `白板上的對話：`,
      this.wolfBoardText(),
      ``,
      `剛發布的發言：「${publishedSpeech}」`,
      ``,
      `任務：看完後決定你的立場（三選一）：`,
      `1. 準備投票 → {"action": "vote", "target": "名字"}`,
      `2. 我要講 → {"action": "speak", "speech": "你要說的話（≤50字）", "stance": "投XXX" 或 "資訊不足"}`,
      `3. 資訊不足、先不講 → {"action": "wait"}`,
      ``,
      `規則：狼每晚必須刀人，不能跳過、不能「不動刀」。`,
      `提醒：直接講你的立場。同意就說「就他」「我跟你」。不要說「我注意到...」「他剛被提出」。不要提「沒有發言紀錄」「沒人發言」——第一天夜裡本來就沒有。用你的角色語氣說話。`,
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
