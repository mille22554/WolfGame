/**
 * ai-scheduler.ts — SpeechScheduler（白板更新驅動迴圈＋AI 決策 flag 收斂）
 *
 * 迴圈（用戶定案）：
 * - 白板更新 → 開工生產（除上輪發言者外全員草稿）＋ CD 重啟。
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
 * - 每輪除上輪發言者外全員寫草稿；候選為空不生產，等真人講話。
 * - 草稿結尾 flag 兩層解析（正規＋寬鬆決策語境關鍵字，不用 LLM）；剝離統一在收草稿回傳前，
 *   broadcast 前再洗一次 expand 輸出；flag 永不進白板。
 * - 安全閥：單一 AI 連續 maxUncertainRounds（預設 100）次資訊不足 → 強制 decided:abstain。
 * - AI decided 且其發言成功播出後 → enqueue AI_READY_VOTE（不帶版本；單向不退；標的可變覆蓋）；
 *   transition 統一檢查全員 ready → 直進投票（無 CLOSING）。
 */

import type { AIScheduler } from './engine.js';
import type { GameState, SchedulerContext } from './types.js';
import { getAlivePlayers } from './assignment.js';
import {
  buildPreSpeechPrompt, buildJudgePrompt, buildExpandPrompt, summarizeDay,
} from './character-session.js';
import { noveltyPenalty } from './novelty.js';
import { shuffleArray } from './utils.js';

// ============================================
// 決策 flag（兩層解析）
// ============================================

export type AIDecision =
  | { status: 'decided'; target: number | 'abstain' }
  | { status: 'uncertain' };

/** 安全閥：單一 AI 連續資訊不足次數上限（防卡死底線；只計真正資訊不足） */
export const MAX_UNCERTAIN_ROUNDS = 100;

/** 正規 flag：[決定:投P3]／[決定:棄票]／[決定:資訊不足]（方括號跳脫、全形/半形冒號、全域匹配） */
export const DECISION_FLAG_RE = /\[決定[:：](投P\s*\d+|棄票|資訊不足)\]/g;
const DECISION_TARGET_RE = /投P\s*(\d+)/;

/** 寬鬆層：決策語境的投 Pn（動詞＋編號才認，避免討論提及誤判） */
const LOOSE_VOTE_RES: RegExp[] = [
  /我投\s*P?\s*(\d+)/,
  /決定投\s*P?\s*(\d+)/,
  /要投\s*P?\s*(\d+)/,
  /打算投\s*P?\s*(\d+)/,
  /想要投\s*P?\s*(\d+)/,
  /會投\s*P?\s*(\d+)/,
  /準備投\s*P?\s*(\d+)/,
  /投票給\s*P?\s*(\d+)/,
];
const LOOSE_ABSTAIN_RE = /棄票|放棄投票|不投票|投棄權/;
const LOOSE_UNCERTAIN_RE = /資訊不足|無法決定|還不能決定|不能決定|不確定|還不確定|再觀察|多聽|還要聽|再聽聽|觀望|難以判斷|沒有想法|沒想法|還沒想法/;

/** 剝離 flag（全域，一律在收草稿回傳前＋broadcast 前各洗一次） */
export function stripDecisionFlags(text: string): string {
  return text
    .replace(DECISION_FLAG_RE, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 兩層解析：先正規，失敗走寬鬆關鍵字；都抓不到 → uncertain（計入安全閥） */
export function parseDecisionFlag(text: string): AIDecision {
  DECISION_FLAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = DECISION_FLAG_RE.exec(text)) !== null) last = m;
  if (last) {
    const body = last[1];
    if (body === '棄票') return { status: 'decided', target: 'abstain' };
    if (body === '資訊不足') return { status: 'uncertain' };
    const tm = DECISION_TARGET_RE.exec(body);
    if (tm) return { status: 'decided', target: parseInt(tm[1], 10) };
    return { status: 'uncertain' };
  }
  for (const re of LOOSE_VOTE_RES) {
    const lm = re.exec(text);
    if (lm) return { status: 'decided', target: parseInt(lm[1], 10) };
  }
  if (LOOSE_ABSTAIN_RE.test(text)) return { status: 'decided', target: 'abstain' };
  if (LOOSE_UNCERTAIN_RE.test(text)) return { status: 'uncertain' };
  return { status: 'uncertain' };
}

// ============================================
// Scheduler
// ============================================

export interface SpeechSchedulerOptions {
  cdMs?: number;               // 預設 60000（真人節奏）；純 AI 局實際以 0 執行
  retryMs?: number;            // 生產失敗重試間隔，預設 60000（env SPEECH_RETRY_MS）
  preSpeechBatch?: number;     // 預設 3（平行預發言數，≤ worker contextCount）
  preSpeechTemp?: number;      // 預設 0.7
  judgeTemp?: number;          // 預設 0.3
  expandTemp?: number;         // 預設 0.8
  topK?: number;               // 預設 3
  recentCompareCount?: number; // 預設 3（新穎性比較的最近訊息數）
  maxUncertainRounds?: number; // 安全閥，預設 100（測試可調小加速收斂）
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

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export class SpeechScheduler implements AIScheduler {
  private readonly ctx: SchedulerContext;
  private readonly options: Required<SpeechSchedulerOptions>;
  private stopped = false;
  private lastSeenBoardVersion = -1;
  private lastDay = -1;
  private prodToken = 0;
  private producing = false;
  private stash: Stash | null = null;
  private cdReady = false;
  private cdTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private uncertainCounts = new Map<number, number>();

  constructor(ctx: SchedulerContext, options?: SpeechSchedulerOptions) {
    this.ctx = ctx;
    this.options = {
      cdMs: options?.cdMs ?? envInt('SPEECH_CD_MS', 60000),
      retryMs: options?.retryMs ?? envInt('SPEECH_RETRY_MS', 60000),
      preSpeechBatch: options?.preSpeechBatch ?? 3,
      preSpeechTemp: options?.preSpeechTemp ?? 0.7,
      judgeTemp: options?.judgeTemp ?? 0.3,
      expandTemp: options?.expandTemp ?? 0.8,
      topK: options?.topK ?? 3,
      recentCompareCount: options?.recentCompareCount ?? 3,
      maxUncertainRounds: options?.maxUncertainRounds ?? MAX_UNCERTAIN_ROUNDS,
    };
  }

  onPhaseEntered(state: GameState): void {
    if (this.stopped) return;
    if (state.phase === 'DAY_DISCUSSION_OPEN') {
      if (state.day !== this.lastDay) {
        this.lastDay = state.day;
        this.uncertainCounts.clear();
      }
      this.lastSeenBoardVersion = state.boardVersion;
      this.resetCycle();
      this.restartCd(state);
      this.startProduction();
    } else {
      this.resetCycle();
      if (state.phase === 'GAME_OVER_FINAL') this.stop();
    }
  }

  onBoardUpdated(state: GameState): void {
    if (this.stopped) return;
    if (state.phase !== 'DAY_DISCUSSION_OPEN') return;
    if (state.boardVersion === this.lastSeenBoardVersion) return;
    // 中間白板又更新 → 暫存作廢＋生產用新白板重跑＋CD 重啟
    this.lastSeenBoardVersion = state.boardVersion;
    this.resetCycle();
    this.restartCd(state);
    this.startProduction();
  }

  /** 清除 timer（server 關閉時） */
  stop(): void {
    this.stopped = true;
    this.resetCycle();
  }

  /** 供測試：目前暫存（有貨／無貨） */
  stashForTest(): Stash | null {
    return this.stash ? { ...this.stash } : null;
  }

  /** 供測試：單一 AI 連續資訊不足次數 */
  uncertainCountForTest(playerId: number): number {
    return this.uncertainCounts.get(playerId) ?? 0;
  }

  private resetCycle(): void {
    this.prodToken++;
    this.producing = false;
    this.stash = null;
    this.cdReady = false;
    if (this.cdTimer) {
      clearTimeout(this.cdTimer);
      this.cdTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private effectiveCdMs(state: GameState): number {
    const humans = getAlivePlayers(state.players).filter((p) => p.controlledBy === 'human').length;
    return humans > 0 ? this.options.cdMs : 0;
  }

  private restartCd(state: GameState): void {
    if (this.cdTimer) {
      clearTimeout(this.cdTimer);
      this.cdTimer = null;
    }
    this.cdReady = false;
    const ms = this.effectiveCdMs(state);
    this.cdTimer = setTimeout(() => {
      this.cdTimer = null;
      this.onCdFired();
    }, ms);
    const t = this.cdTimer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  private onCdFired(): void {
    if (this.stopped) return;
    let state: GameState;
    try {
      state = this.ctx.getState();
    } catch {
      return;
    }
    if (state.phase !== 'DAY_DISCUSSION_OPEN') return;
    this.cdReady = true;
    if (this.stash) void this.broadcastStash();
    // 無貨 → 等做好馬上播（生產完成時見 cdReady 直接播）
  }

  /** 草稿候選：存活 AI 除上輪發言者外全員；為空 → 不生產（等真人） */
  private candidateIds(state: GameState): number[] {
    const aliveAI = getAlivePlayers(state.players)
      .filter((p) => p.controlledBy === 'ai')
      .map((p) => p.id);
    if (aliveAI.length === 0) return [];
    const today = state.discussionLog.filter((d) => d.day === state.day);
    const last = today[today.length - 1];
    if (!last) return [...aliveAI];
    const cands = aliveAI.filter((id) => id !== last.playerId);
    return cands;
  }

  private startProduction(): void {
    if (this.stopped || this.producing) return;
    let state: GameState;
    try {
      state = this.ctx.getState();
    } catch {
      return;
    }
    if (state.phase !== 'DAY_DISCUSSION_OPEN') return;
    const ids = this.candidateIds(state);
    if (ids.length === 0) return;   // 候選為空不生產，等真人講話（掛機計數自然凍結）
    const token = ++this.prodToken;
    this.producing = true;
    void this.runProduction(token, state.boardVersion, ids);
  }

  private async runProduction(token: number, startVersion: number, ids: number[]): Promise<void> {
    try {
      // ---- PRE_SPEECH：全員草稿（分批平行；剝離＋決策更新在 collect 內） ----
      const drafts = await this.collectPreSpeeches(token, ids);
      if (token !== this.prodToken) return;
      const cur1 = this.ctx.getState();
      if (cur1.phase !== 'DAY_DISCUSSION_OPEN') return;
      if (cur1.boardVersion !== startVersion) return;   // 作廢（新一輪已接手）
      if (drafts.length === 0) {
        this.scheduleRetry();
        return;
      }

      // ---- JUDGE：全盲裁判（草稿 ≤3 直接跳過，全部同分純隨機挑，新穎性不生效） ----
      const scores = drafts.length <= 3
        ? new Map(drafts.map((d) => [d.slot, 5]))
        : await this.judge(token, cur1, drafts);
      if (token !== this.prodToken) return;
      const cur2 = this.ctx.getState();
      if (cur2.phase !== 'DAY_DISCUSSION_OPEN') return;
      if (cur2.boardVersion !== startVersion) return;   // 作廢

      // ---- SELECT：新穎性懲罰 + top3 隨機 ----
      const recent = cur2.discussionLog
        .filter((d) => d.day === cur2.day)
        .slice(-this.options.recentCompareCount)
        .map((d) => d.text);
      const ranked = drafts.map((d) => ({
        ...d,
        final: (scores.get(d.slot) ?? 5) - noveltyPenalty(d.text, recent),
      })).sort((a, b) => b.final - a.final);
      const top = ranked.slice(0, Math.max(1, Math.min(this.options.topK, ranked.length)));
      const winner = top[Math.floor(Math.random() * top.length)];
      const commitVersion = this.ctx.getState().boardVersion;

      // ---- EXPAND：產出後清洗 flag（廉價保險），再暫存 ----
      const expandPrompt = buildExpandPrompt(cur2, winner.playerId, winner.text);
      let full: string;
      try {
        full = stripDecisionFlags((await this.ctx.llm.generate(expandPrompt, {
          temperature: this.options.expandTemp,
          maxTokens: 100,
        })).trim());
      } catch {
        this.scheduleRetry();
        return;
      }
      if (token !== this.prodToken) return;
      if (this.ctx.getState().phase !== 'DAY_DISCUSSION_OPEN') return;
      if (!full) {
        this.scheduleRetry();
        return;
      }
      this.stash = {
        playerId: winner.playerId, text: full, boardVersion: commitVersion, decision: winner.decision,
      };
      if (this.cdReady) void this.broadcastStash();
    } catch {
      if (token !== this.prodToken) return;
      this.scheduleRetry();
    } finally {
      if (token === this.prodToken) this.producing = false;
    }
  }

  /** 生產失敗 → N 秒後重試；重試前不播出（無暫存）、不推進掛機計數（transition 只在發言成功時計數） */
  private scheduleRetry(): void {
    if (this.stopped) return;
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.startProduction();
    }, this.options.retryMs);
    const t = this.retryTimer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  private async collectPreSpeeches(token: number, ids: number[]): Promise<Draft[]> {
    const results: Draft[] = [];
    const batch = Math.max(1, this.options.preSpeechBatch);
    for (let i = 0; i < ids.length; i += batch) {
      if (token !== this.prodToken) return [];
      const chunk = ids.slice(i, i + batch);
      const settled = await Promise.all(chunk.map(async (pid) => {
        const prompt = buildPreSpeechPrompt(this.ctx.getState(), pid);
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const raw = (await this.ctx.llm.generate(prompt, {
              temperature: this.options.preSpeechTemp,
              maxTokens: 100,
            })).trim();
            if (!raw) continue;
            const decision = this.updateDecision(pid, parseDecisionFlag(raw));
            const text = stripDecisionFlags(raw);
            if (!text) continue;   // 僅剩 flag 無內容 → 不列入候選
            return { playerId: pid, text, decision };
          } catch { /* 重試 1 次 */ }
        }
        return null;
      }));
      for (const r of settled) {
        if (r) results.push({ slot: 0, ...r });
      }
    }
    // slot 編號依完成順序指派（與裁判看到的順序一致；映射前先打亂）
    const shuffled = shuffleArray(results);
    shuffled.forEach((r, idx) => { r.slot = idx + 1; });
    return shuffled;
  }

  /** 決策更新：decided 覆蓋標的＋清空計數；資訊不足累計，達安全閥強制 decided:abstain */
  private updateDecision(playerId: number, d: AIDecision): AIDecision {
    if (d.status === 'decided') {
      this.uncertainCounts.delete(playerId);
      return d;
    }
    const n = (this.uncertainCounts.get(playerId) ?? 0) + 1;
    if (n >= this.options.maxUncertainRounds) {
      this.uncertainCounts.delete(playerId);
      const forced: AIDecision = { status: 'decided', target: 'abstain' };
      return forced;
    }
    this.uncertainCounts.set(playerId, n);
    return d;
  }

  private async judge(
    token: number,
    state: GameState,
    drafts: Draft[],
  ): Promise<Map<number, number>> {
    const summary = summarizeDay(state, state.day);
    const prompt = buildJudgePrompt(summary, drafts.map((d) => ({ slot: d.slot, text: d.text })));
    let raw = '';
    try {
      raw = await this.ctx.llm.generate(prompt, {
        temperature: this.options.judgeTemp,
        maxTokens: 200,
      });
    } catch {
      return new Map(drafts.map((d) => [d.slot, 5]));
    }
    if (token !== this.prodToken) return new Map();
    const scores = new Map<number, number>();
    const re = /^(\d+)\s*[:：]\s*(\d+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      scores.set(parseInt(m[1], 10), parseInt(m[2], 10));
    }
    const parsed = drafts.filter((d) => scores.has(d.slot)).length;
    if (parsed / drafts.length < 0.5) {
      // 解析率 < 50% → 放棄評分，全部同分（回歸 top3 隨機）
      return new Map(drafts.map((d) => [d.slot, 5]));
    }
    for (const d of drafts) {
      if (!scores.has(d.slot)) scores.set(d.slot, 5);
    }
    return scores;
  }

  /** CD 到有貨 → 播出；播出成功且 decided → enqueue AI_READY_VOTE（統一檢查由 transition 執行） */
  private async broadcastStash(): Promise<void> {
    const s = this.stash;
    if (!s) return;
    this.stash = null;   // 消費暫存
    let state: GameState;
    try {
      state = this.ctx.getState();
    } catch {
      return;
    }
    if (state.phase !== 'DAY_DISCUSSION_OPEN') return;
    if (state.boardVersion !== s.boardVersion) return;   // 版本已動：作廢（新一輪接手）
    this.ctx.enqueue({ type: 'AI_SPEECH_DONE', playerId: s.playerId, text: s.text, boardVersion: s.boardVersion });
    // 發言成功確認：log 落子即成功（engine 同步處理；含版本檢查）
    let cur: GameState;
    try {
      cur = this.ctx.getState();
    } catch {
      return;
    }
    const today = cur.discussionLog.filter((d) => d.day === cur.day);
    const lastEntry = today[today.length - 1];
    const ok = !!lastEntry && lastEntry.playerId === s.playerId && lastEntry.text === s.text;
    if (!ok) {
      // 被拒（版本競態）→ 視為白板活動：重啟 CD＋重跑
      if (cur.phase !== 'DAY_DISCUSSION_OPEN') return;
      this.lastSeenBoardVersion = cur.boardVersion;
      this.restartCd(cur);
      this.startProduction();
      return;
    }
    // 發言成功後 enqueue 新 decided（不帶版本；已在 voteReady 則免）
    if (s.decision.status === 'decided' && !cur.voteReady.includes(s.playerId)) {
      this.ctx.enqueue({ type: 'AI_READY_VOTE', playerId: s.playerId });
    }
    // 收斂直進投票由 transition 統一檢查完成；播出本身即白板更新，迴圈經 onBoardUpdated 回去。
  }
}
