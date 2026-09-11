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
 * - 安全閥：單一 AI 連續 maxUncertainRounds（預設 50）次資訊不足 → 強制 decided:abstain。
 * - AI decided 且其發言成功播出後 → enqueue AI_READY_VOTE（不帶版本；單向不退；標的可變覆蓋）；
 *   transition 統一檢查全員 ready → 直進投票（無 CLOSING）。
 */
import { Role } from './types.js';
import { getAlivePlayers, getAliveWerewolves } from './assignment.js';
import { stripSpeechPrefix } from './game-state.js';
import { buildPreSpeechPrompt, buildJudgePrompt, buildExpandPrompt, summarizeDay, buildWolfPreSpeechPrompt, buildWolfExpandPrompt, summarizeWolfDiscussion, } from './character-session.js';
import { noveltyPenalty } from './novelty.js';
import { shuffleArray } from './utils.js';
/** 安全閥：單一 AI 連續資訊不足次數上限（防卡死底線；只計真正資訊不足） */
export const MAX_UNCERTAIN_ROUNDS = 50;
/** 正規 flag：[決定:投P3]／[決定:殺P3]／[決定:棄票]／[決定:資訊不足]（方括號跳脫、全形/半形冒號、全域匹配） */
export const DECISION_FLAG_RE = /\[決定[:：](投P\s*\d+|殺P\s*\d+|棄票|資訊不足)\]/g;
const DECISION_TARGET_RE = /(?:投|殺)P\s*(\d+)/;
/** 寬鬆層：決策語境的投 Pn（動詞＋編號才認，避免討論提及誤判） */
const LOOSE_VOTE_RES = [
    /我投\s*P?\s*(\d+)/,
    /決定投\s*P?\s*(\d+)/,
    /要投\s*P?\s*(\d+)/,
    /打算投\s*P?\s*(\d+)/,
    /想要投\s*P?\s*(\d+)/,
    /會投\s*P?\s*(\d+)/,
    /準備投\s*P?\s*(\d+)/,
    /投票給\s*P?\s*(\d+)/,
    /決定殺\s*P?\s*(\d+)/,
    /要殺\s*P?\s*(\d+)/,
    /襲擊\s*P?\s*(\d+)/,
];
const LOOSE_ABSTAIN_RE = /棄票|放棄投票|不投票|投棄權/;
const LOOSE_UNCERTAIN_RE = /資訊不足|無法決定|還不能決定|不能決定|不確定|還不確定|再觀察|多聽|還要聽|再聽聽|觀望|難以判斷|沒有想法|沒想法|還沒想法/;
/** 剝離 flag（全域，一律在收草稿回傳前＋broadcast 前各洗一次） */
export function stripDecisionFlags(text) {
    return text
        .replace(DECISION_FLAG_RE, '')
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
/** 兩層解析：先正規，失敗走寬鬆關鍵字；都抓不到 → uncertain（計入安全閥） */
export function parseDecisionFlag(text) {
    DECISION_FLAG_RE.lastIndex = 0;
    let m;
    let last = null;
    while ((m = DECISION_FLAG_RE.exec(text)) !== null)
        last = m;
    if (last) {
        const body = last[1];
        if (body === '棄票')
            return { status: 'decided', target: 'abstain' };
        if (body === '資訊不足')
            return { status: 'uncertain' };
        const tm = DECISION_TARGET_RE.exec(body);
        if (tm)
            return { status: 'decided', target: parseInt(tm[1], 10) };
        return { status: 'uncertain' };
    }
    for (const re of LOOSE_VOTE_RES) {
        const lm = re.exec(text);
        if (lm)
            return { status: 'decided', target: parseInt(lm[1], 10) };
    }
    if (LOOSE_ABSTAIN_RE.test(text))
        return { status: 'decided', target: 'abstain' };
    if (LOOSE_UNCERTAIN_RE.test(text))
        return { status: 'uncertain' };
    return { status: 'uncertain' };
}
function envInt(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) ? v : fallback;
}
export class SpeechScheduler {
    ctx;
    options;
    stopped = false;
    lastSeenBoardVersion = -1;
    lastDay = -1;
    prodToken = 0;
    producing = false;
    stash = null;
    cdReady = false;
    cdTimer = null;
    retryTimer = null;
    uncertainCounts = new Map();
    decisions = new Map(); // 每玩家最新有效決策（含安全閥強制 abstain）
    constructor(ctx, options) {
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
    onPhaseEntered(state) {
        if (this.stopped)
            return;
        if (state.phase === 'DAY_DISCUSSION_OPEN' || state.phase === 'NIGHT_DISCUSSION_OPEN') {
            // 模式一律由 state.phase 推導（NIGHT_DISCUSSION_OPEN = 狼），不另存可過期的 mode 欄位
            if (state.day !== this.lastDay) {
                this.lastDay = state.day;
                this.uncertainCounts.clear();
                this.decisions.clear();
            }
            this.lastSeenBoardVersion = state.boardVersion;
            this.resetCycle();
            this.restartCd(state);
            this.startProduction();
        }
        else {
            this.resetCycle();
            if (state.phase === 'GAME_OVER_FINAL')
                this.stop();
        }
    }
    onBoardUpdated(state) {
        if (this.stopped)
            return;
        if (state.phase !== 'DAY_DISCUSSION_OPEN' && state.phase !== 'NIGHT_DISCUSSION_OPEN')
            return;
        if (state.boardVersion === this.lastSeenBoardVersion)
            return;
        // 中間白板又更新 → 暫存作廢＋生產用新白板重跑＋CD 重啟
        this.lastSeenBoardVersion = state.boardVersion;
        this.resetCycle();
        this.restartCd(state);
        this.startProduction();
    }
    /** 清除 timer（server 關閉時） */
    stop() {
        this.stopped = true;
        this.resetCycle();
    }
    /** 供測試：目前暫存（有貨／無貨） */
    stashForTest() {
        return this.stash ? { ...this.stash } : null;
    }
    /** 供測試：單一 AI 連續資訊不足次數 */
    uncertainCountForTest(playerId) {
        return this.uncertainCounts.get(playerId) ?? 0;
    }
    resetCycle() {
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
    effectiveCdMs(state) {
        const humans = getAlivePlayers(state.players).filter((p) => p.controlledBy === 'human').length;
        return humans > 0 ? this.options.cdMs : 0;
    }
    restartCd(state) {
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
        const t = this.cdTimer;
        if (typeof t.unref === 'function')
            t.unref();
    }
    onCdFired() {
        if (this.stopped)
            return;
        let state;
        try {
            state = this.ctx.getState();
        }
        catch {
            return;
        }
        if (state.phase !== 'DAY_DISCUSSION_OPEN' && state.phase !== 'NIGHT_DISCUSSION_OPEN')
            return;
        this.cdReady = true;
        if (this.stash)
            void this.broadcastStash();
        // 無貨 → 等做好馬上播（生產完成時見 cdReady 直接播）
    }
    /** 草稿候選：存活 AI 除上輪發言者外全員（狼模式僅存活狼 AI）；為空 → 不生產（等真人） */
    candidateIds(state) {
        const isWolf = state.phase === 'NIGHT_DISCUSSION_OPEN';
        const aliveAI = getAlivePlayers(state.players)
            .filter((p) => p.controlledBy === 'ai' && (!isWolf || p.role === Role.WEREWOLF))
            .map((p) => p.id);
        if (aliveAI.length === 0)
            return [];
        const log = isWolf ? state.wolfDiscussionLog : state.discussionLog;
        const today = log.filter((d) => d.day === state.day);
        const last = today[today.length - 1];
        if (!last)
            return [...aliveAI];
        const cands = aliveAI.filter((id) => id !== last.playerId);
        return cands;
    }
    startProduction() {
        if (this.stopped || this.producing)
            return;
        let state;
        try {
            state = this.ctx.getState();
        }
        catch {
            return;
        }
        if (state.phase !== 'DAY_DISCUSSION_OPEN' && state.phase !== 'NIGHT_DISCUSSION_OPEN')
            return;
        const ids = this.candidateIds(state);
        if (ids.length === 0)
            return; // 候選為空不生產，等真人講話（掛機計數自然凍結）
        const token = ++this.prodToken;
        this.producing = true;
        void this.runProduction(token, state.boardVersion, ids);
    }
    async runProduction(token, startVersion, ids) {
        try {
            // ---- PRE_SPEECH：全員草稿（分批平行；剝離＋決策更新在 collect 內） ----
            const drafts = await this.collectPreSpeeches(token, ids);
            if (token !== this.prodToken)
                return;
            const cur1 = this.ctx.getState();
            if (cur1.phase !== 'DAY_DISCUSSION_OPEN' && cur1.phase !== 'NIGHT_DISCUSSION_OPEN')
                return;
            if (cur1.boardVersion !== startVersion)
                return; // 作廢（新一輪已接手）
            if (drafts.length === 0) {
                this.scheduleRetry();
                return;
            }
            // ---- JUDGE：全盲裁判（草稿 ≤3 直接跳過，全部同分純隨機挑，新穎性不生效） ----
            const scores = drafts.length <= 3
                ? new Map(drafts.map((d) => [d.slot, 5]))
                : await this.judge(token, cur1, drafts);
            if (token !== this.prodToken)
                return;
            const cur2 = this.ctx.getState();
            if (cur2.phase !== 'DAY_DISCUSSION_OPEN' && cur2.phase !== 'NIGHT_DISCUSSION_OPEN')
                return;
            if (cur2.boardVersion !== startVersion)
                return; // 作廢
            // ---- SELECT：新穎性懲罰 + top3 隨機 ----
            const isWolfMode = cur2.phase === 'NIGHT_DISCUSSION_OPEN';
            const discussLog = isWolfMode ? cur2.wolfDiscussionLog : cur2.discussionLog;
            const recent = discussLog
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
            const expandPrompt = isWolfMode
                ? buildWolfExpandPrompt(cur2, winner.playerId, winner.text)
                : buildExpandPrompt(cur2, winner.playerId, winner.text);
            let full;
            let decision = winner.decision;
            try {
                const rawExpand = (await this.ctx.llm.generate(expandPrompt, {
                    temperature: this.options.expandTemp,
                    maxTokens: 100,
                })).trim();
                const expandDecision = parseDecisionFlag(rawExpand);
                full = stripSpeechPrefix(stripDecisionFlags(rawExpand));
                // 狼模式：expand 是對外最終承諾，其決策優先（無效目標→棄票）；expand 未決定→沿用草稿決策。
                // 矛盾防護：expand 旗標目標與草稿決策目標不一致（模型旗標填寫失誤，如正文說殺P5旗標卻寫P15）
                // → 不採信 expand 旗標，沿用草稿決策（草稿已通過 validateWolfTarget）
                if (isWolfMode && expandDecision.status === 'decided' && expandDecision.target !== 'abstain') {
                    const draftDecided = winner.decision.status === 'decided' && winner.decision.target !== 'abstain';
                    const consistent = !draftDecided || expandDecision.target === winner.decision.target;
                    if (consistent) {
                        decision = this.updateDecision(winner.playerId, this.validateWolfTarget(cur2, winner.playerId, expandDecision));
                    }
                    else {
                        decision = this.updateDecision(winner.playerId, winner.decision);
                    }
                }
            }
            catch {
                this.scheduleRetry();
                return;
            }
            if (token !== this.prodToken)
                return;
            if (this.ctx.getState().phase !== 'DAY_DISCUSSION_OPEN' && this.ctx.getState().phase !== 'NIGHT_DISCUSSION_OPEN')
                return;
            if (!full) {
                this.scheduleRetry();
                return;
            }
            this.stash = {
                playerId: winner.playerId, text: full, boardVersion: commitVersion, decision,
            };
            if (this.cdReady)
                void this.broadcastStash();
        }
        catch {
            if (token !== this.prodToken)
                return;
            this.scheduleRetry();
        }
        finally {
            if (token === this.prodToken)
                this.producing = false;
        }
    }
    /** 生產失敗 → N 秒後重試；重試前不播出（無暫存）、不推進掛機計數（transition 只在發言成功時計數） */
    scheduleRetry() {
        if (this.stopped)
            return;
        if (this.retryTimer)
            return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.startProduction();
        }, this.options.retryMs);
        const t = this.retryTimer;
        if (typeof t.unref === 'function')
            t.unref();
    }
    async collectPreSpeeches(token, ids) {
        const results = [];
        const batch = Math.max(1, this.options.preSpeechBatch);
        for (let i = 0; i < ids.length; i += batch) {
            if (token !== this.prodToken)
                return [];
            const chunk = ids.slice(i, i + batch);
            const settled = await Promise.all(chunk.map(async (pid) => {
                const st = this.ctx.getState();
                const isWolf = st.phase === 'NIGHT_DISCUSSION_OPEN';
                const prompt = isWolf
                    ? buildWolfPreSpeechPrompt(st, pid)
                    : buildPreSpeechPrompt(st, pid);
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        const raw = (await this.ctx.llm.generate(prompt, {
                            temperature: this.options.preSpeechTemp,
                            maxTokens: 100,
                        })).trim();
                        if (!raw)
                            continue;
                        const parsed = parseDecisionFlag(raw);
                        const decision = this.updateDecision(pid, isWolf ? this.validateWolfTarget(st, pid, parsed) : parsed);
                        const text = stripDecisionFlags(raw);
                        if (!text)
                            continue; // 僅剩 flag 無內容 → 不列入候選
                        return { playerId: pid, text, decision };
                    }
                    catch { /* 重試 1 次 */ }
                }
                return null;
            }));
            for (const r of settled) {
                if (r)
                    results.push({ slot: 0, ...r });
            }
        }
        // slot 編號依完成順序指派（與裁判看到的順序一致；映射前先打亂）
        const shuffled = shuffleArray(results);
        shuffled.forEach((r, idx) => { r.slot = idx + 1; });
        return shuffled;
    }
    /** 驗證狼襲擊目標合法性：存活、非自己、非狼同盟；不合法 → 視為棄票（狼放棄這票，不擋會議；夜晚結算另有過濾） */
    validateWolfTarget(state, playerId, d) {
        if (d.status === 'decided' && d.target !== 'abstain') {
            const target = state.players.find((p) => p.id === d.target);
            const allies = getAliveWerewolves(state.players).map((w) => w.id);
            if (!target || !target.alive || target.id === playerId || allies.includes(target.id)) {
                return { status: 'decided', target: 'abstain' };
            }
        }
        return d;
    }
    /** 決策更新：decided 覆蓋標的＋清空計數；資訊不足累計，達安全閥強制 decided:abstain */
    updateDecision(playerId, d) {
        if (d.status === 'decided') {
            this.uncertainCounts.delete(playerId);
            this.decisions.set(playerId, d);
            return d;
        }
        const n = (this.uncertainCounts.get(playerId) ?? 0) + 1;
        if (n >= this.options.maxUncertainRounds) {
            this.uncertainCounts.delete(playerId);
            const forced = { status: 'decided', target: 'abstain' };
            this.decisions.set(playerId, forced);
            return forced;
        }
        this.uncertainCounts.set(playerId, n);
        this.decisions.set(playerId, d);
        return d;
    }
    /** GM 除錯用：每輪 AI 決策 flag 統計（每玩家最新決策，非累計筆數；決定投誰／棄票／資訊不足各幾筆） */
    flagStats() {
        let decided = 0;
        let abstain = 0;
        let uncertain = 0;
        for (const d of this.decisions.values()) {
            if (d.status === 'uncertain')
                uncertain++;
            else if (d.target === 'abstain')
                abstain++;
            else
                decided++;
        }
        return { decided, abstain, uncertain };
    }
    async judge(token, state, drafts) {
        const summary = state.phase === 'NIGHT_DISCUSSION_OPEN'
            ? summarizeWolfDiscussion(state, state.day)
            : summarizeDay(state, state.day);
        const prompt = buildJudgePrompt(summary, drafts.map((d) => ({ slot: d.slot, text: d.text })));
        let raw = '';
        try {
            raw = await this.ctx.llm.generate(prompt, {
                temperature: this.options.judgeTemp,
                maxTokens: 200,
            });
        }
        catch {
            return new Map(drafts.map((d) => [d.slot, 5]));
        }
        if (token !== this.prodToken)
            return new Map();
        const scores = new Map();
        const re = /^(\d+)\s*[:：]\s*(\d+)$/gm;
        let m;
        while ((m = re.exec(raw)) !== null) {
            scores.set(parseInt(m[1], 10), parseInt(m[2], 10));
        }
        const parsed = drafts.filter((d) => scores.has(d.slot)).length;
        if (parsed / drafts.length < 0.5) {
            // 解析率 < 50% → 放棄評分，全部同分（回歸 top3 隨機）
            return new Map(drafts.map((d) => [d.slot, 5]));
        }
        for (const d of drafts) {
            if (!scores.has(d.slot))
                scores.set(d.slot, 5);
        }
        return scores;
    }
    /** CD 到有貨 → 播出；播出成功且 decided → enqueue AI_READY_VOTE（統一檢查由 transition 執行） */
    async broadcastStash() {
        const s = this.stash;
        if (!s)
            return;
        this.stash = null; // 消費暫存
        let state;
        try {
            state = this.ctx.getState();
        }
        catch {
            return;
        }
        if (state.phase !== 'DAY_DISCUSSION_OPEN' && state.phase !== 'NIGHT_DISCUSSION_OPEN')
            return;
        if (state.boardVersion !== s.boardVersion)
            return; // 版本已動：作廢（新一輪接手）
        const isWolf = state.phase === 'NIGHT_DISCUSSION_OPEN';
        this.ctx.enqueue(isWolf
            ? { type: 'AI_WOLF_SPEECH_DONE', playerId: s.playerId, text: s.text, boardVersion: s.boardVersion }
            : { type: 'AI_SPEECH_DONE', playerId: s.playerId, text: s.text, boardVersion: s.boardVersion });
        // 發言成功確認：log 落子即成功（engine 同步處理；含版本檢查）
        let cur;
        try {
            cur = this.ctx.getState();
        }
        catch {
            return;
        }
        const log = isWolf ? cur.wolfDiscussionLog : cur.discussionLog;
        const today = log.filter((d) => d.day === cur.day);
        const lastEntry = today[today.length - 1];
        const ok = !!lastEntry && lastEntry.playerId === s.playerId && lastEntry.text === s.text;
        if (!ok) {
            // 被拒（版本競態）→ 視為白板活動：重啟 CD＋重跑
            if (cur.phase !== 'DAY_DISCUSSION_OPEN' && cur.phase !== 'NIGHT_DISCUSSION_OPEN')
                return;
            this.lastSeenBoardVersion = cur.boardVersion;
            this.restartCd(cur);
            this.startProduction();
            return;
        }
        // 發言成功後 enqueue 新 decided（不帶版本；已在 ready 則免）
        if (s.decision.status === 'decided') {
            if (isWolf) {
                if (!cur.wolfReady.includes(s.playerId)) {
                    this.ctx.enqueue({ type: 'AI_WOLF_READY', playerId: s.playerId });
                }
            }
            else if (!cur.voteReady.includes(s.playerId)) {
                this.ctx.enqueue({ type: 'AI_READY_VOTE', playerId: s.playerId });
            }
        }
        // 收斂直進投票由 transition 統一檢查完成；播出本身即白板更新，迴圈經 onBoardUpdated 回去。
    }
}
//# sourceMappingURL=ai-scheduler.js.map