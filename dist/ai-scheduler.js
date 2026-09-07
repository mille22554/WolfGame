/**
 * ai-scheduler.ts — SpeechScheduler（發言選擇機制，實作 AIScheduler）
 *
 * 管線：IDLE → PRE_SPEECH（分批平行）→ JUDGE（全盲裁判）→ SELECT（新穎性懲罰 + top3 隨機）
 *       → EXPAND（commit 後不中斷）→ BROADCAST（保證 ≥ CD 距最後訊息）
 *
 * 版本語意：PRE_SPEECH / JUDGE 完成時版本不符 → 作廢回 IDLE；
 * SELECT 之後 commit，EXPAND 跑完後 enqueue AI_SPEECH_DONE 帶 commit 版本
 * （期間版本變更則由 engine 既有機制丟棄）。
 */
import { getAlivePlayers } from './assignment.js';
import { buildPrompt, buildPreSpeechPrompt, buildJudgePrompt, buildExpandPrompt, summarizeDay, } from './character-session.js';
import { noveltyPenalty } from './novelty.js';
import { shuffleArray } from './utils.js';
function envInt(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) ? v : fallback;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export class SpeechScheduler {
    ctx;
    options;
    timer = null;
    lastMessageTime = 0;
    lastSeenBoardVersion = -1;
    pipelineToken = 0;
    pipelineActive = false;
    stopped = false;
    constructor(ctx, options) {
        this.ctx = ctx;
        this.options = {
            cdMs: options?.cdMs ?? envInt('SPEECH_CD_MS', 60000),
            quietMs: options?.quietMs ?? envInt('QUIET_THRESHOLD_MS', 20000),
            checkIntervalMs: options?.checkIntervalMs ?? 1000,
            preSpeechBatch: options?.preSpeechBatch ?? 3,
            preSpeechTemp: options?.preSpeechTemp ?? 0.7,
            judgeTemp: options?.judgeTemp ?? 0.3,
            expandTemp: options?.expandTemp ?? 0.8,
            topK: options?.topK ?? 3,
            recentCompareCount: options?.recentCompareCount ?? 3,
        };
    }
    onPhaseEntered(state) {
        if (this.stopped)
            return;
        if (state.phase === 'DAY_DISCUSSION_OPEN') {
            const now = Date.now();
            this.lastMessageTime = now;
            this.lastSeenBoardVersion = state.boardVersion;
            this.startTimer();
        }
        else {
            this.cancelPipeline();
            this.clearTimer();
            if (state.phase === 'GAME_OVER_FINAL')
                this.stop();
        }
    }
    onBoardUpdated(state) {
        if (this.stopped)
            return;
        if (state.boardVersion !== this.lastSeenBoardVersion) {
            this.lastSeenBoardVersion = state.boardVersion;
            this.lastMessageTime = Date.now();
        }
    }
    /** 清除 timer（server 關閉時） */
    stop() {
        this.stopped = true;
        this.cancelPipeline();
        this.clearTimer();
    }
    startTimer() {
        if (this.timer || this.stopped)
            return;
        this.timer = setInterval(() => this.tick(), this.options.checkIntervalMs);
        const t = this.timer;
        if (typeof t.unref === 'function')
            t.unref();
    }
    clearTimer() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    cancelPipeline() {
        this.pipelineToken++;
        this.pipelineActive = false;
    }
    tick() {
        if (this.stopped || this.pipelineActive)
            return;
        let state;
        try {
            state = this.ctx.getState();
        }
        catch {
            return;
        }
        if (state.phase !== 'DAY_DISCUSSION_OPEN')
            return;
        // tick 層級版本偵測（涵蓋所有 board 變更，含管線自身廣播與真人發言）
        if (state.boardVersion !== this.lastSeenBoardVersion) {
            this.lastSeenBoardVersion = state.boardVersion;
            this.lastMessageTime = Date.now();
            return;
        }
        if (Date.now() - this.lastMessageTime >= this.options.quietMs) {
            void this.runPipeline();
        }
    }
    aliveAIIds(state) {
        return getAlivePlayers(state.players)
            .filter((p) => p.controlledBy === 'ai')
            .map((p) => p.id);
    }
    async runPipeline() {
        const token = ++this.pipelineToken;
        this.pipelineActive = true;
        try {
            const startState = this.ctx.getState();
            if (startState.phase !== 'DAY_DISCUSSION_OPEN')
                return;
            const startVersion = startState.boardVersion;
            const ids = this.aliveAIIds(startState);
            if (ids.length === 0)
                return;
            if (ids.length <= 2) {
                await this.runDirect(token, ids);
                return;
            }
            // ---- PRE_SPEECH：分批平行 ----
            const drafts = await this.collectPreSpeeches(token, startState, ids);
            if (token !== this.pipelineToken)
                return;
            const cur1 = this.ctx.getState();
            if (cur1.phase !== 'DAY_DISCUSSION_OPEN')
                return;
            if (cur1.boardVersion !== startVersion)
                return; // 作廢
            if (drafts.length === 0)
                return; // 全部失敗
            // ---- JUDGE：全盲裁判 ----
            const scores = await this.judge(token, cur1, drafts);
            if (token !== this.pipelineToken)
                return;
            const cur2 = this.ctx.getState();
            if (cur2.phase !== 'DAY_DISCUSSION_OPEN')
                return;
            if (cur2.boardVersion !== startVersion)
                return; // 作廢
            // ---- SELECT：新穎性懲罰 + top3 隨機 → commit ----
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
            // ---- EXPAND：commit 後不中斷 ----
            const expandPrompt = buildExpandPrompt(cur2, winner.playerId, winner.text);
            let full;
            try {
                full = (await this.ctx.llm.generate(expandPrompt, {
                    temperature: this.options.expandTemp,
                })).trim();
            }
            catch {
                return;
            }
            if (token !== this.pipelineToken)
                return;
            if (this.ctx.getState().phase !== 'DAY_DISCUSSION_OPEN')
                return;
            if (!full)
                return;
            await this.broadcastAfterCd(token, winner.playerId, full, commitVersion);
        }
        finally {
            if (token === this.pipelineToken)
                this.pipelineActive = false;
        }
    }
    /** 存活 AI ≤ 2：跳過管線，直接隨機選一展開 */
    async runDirect(token, ids) {
        const picked = ids[Math.floor(Math.random() * ids.length)];
        const state = this.ctx.getState();
        let draft = '';
        try {
            draft = (await this.ctx.llm.generate(buildPreSpeechPrompt(state, picked), {
                temperature: this.options.preSpeechTemp,
                maxTokens: 100,
            })).trim();
        }
        catch {
            draft = '';
        }
        if (token !== this.pipelineToken)
            return;
        if (this.ctx.getState().phase !== 'DAY_DISCUSSION_OPEN')
            return;
        const prompt = draft
            ? buildExpandPrompt(state, picked, draft)
            : buildExpandPromptFallback(state, picked);
        let full;
        try {
            full = (await this.ctx.llm.generate(prompt, {
                temperature: this.options.expandTemp,
            })).trim();
        }
        catch {
            return;
        }
        if (token !== this.pipelineToken)
            return;
        if (this.ctx.getState().phase !== 'DAY_DISCUSSION_OPEN')
            return;
        if (!full)
            return;
        await this.broadcastAfterCd(token, picked, full, state.boardVersion);
    }
    async collectPreSpeeches(token, state, ids) {
        const results = [];
        const batch = Math.max(1, this.options.preSpeechBatch);
        for (let i = 0; i < ids.length; i += batch) {
            if (token !== this.pipelineToken)
                return [];
            const chunk = ids.slice(i, i + batch);
            const settled = await Promise.all(chunk.map(async (pid) => {
                const prompt = buildPreSpeechPrompt(this.ctx.getState(), pid);
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        const text = (await this.ctx.llm.generate(prompt, {
                            temperature: this.options.preSpeechTemp,
                            maxTokens: 100,
                        })).trim();
                        if (text)
                            return { playerId: pid, text };
                    }
                    catch { /* 重試 1 次 */ }
                }
                return null;
            }));
            for (const r of settled) {
                if (r)
                    results.push({ slot: 0, playerId: r.playerId, text: r.text });
            }
        }
        // slot 編號依完成順序指派（與裁判看到的順序一致；映射前先打亂）
        const shuffled = shuffleArray(results);
        shuffled.forEach((r, idx) => { r.slot = idx + 1; });
        void state;
        return shuffled;
    }
    async judge(token, state, drafts) {
        const summary = summarizeDay(state, state.day);
        const prompt = buildJudgePrompt(summary, drafts.map((d) => ({ slot: d.slot, text: d.text })));
        let raw = '';
        try {
            raw = await this.ctx.llm.generate(prompt, {
                temperature: this.options.judgeTemp,
                maxTokens: 300,
            });
        }
        catch {
            return new Map(drafts.map((d) => [d.slot, 5]));
        }
        if (token !== this.pipelineToken)
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
    /** 廣播保證 ≥ CD 距最後訊息；commit 語意：等待後照常 enqueue（帶 commit 版本） */
    async broadcastAfterCd(token, playerId, text, commitVersion) {
        const remaining = this.options.cdMs - (Date.now() - this.lastMessageTime);
        if (remaining > 0)
            await sleep(remaining);
        if (token !== this.pipelineToken)
            return;
        if (this.ctx.getState().phase !== 'DAY_DISCUSSION_OPEN')
            return;
        this.ctx.enqueue({ type: 'AI_SPEECH_DONE', playerId, text, boardVersion: commitVersion });
        this.lastMessageTime = Date.now();
        this.lastSeenBoardVersion = this.ctx.getState().boardVersion;
    }
}
/** direct 路徑草稿失敗時的後備：標準 speech prompt + 空草稿附加 */
function buildExpandPromptFallback(state, playerId) {
    const base = buildPrompt(state, playerId, 'speech');
    return `${base}\n\n【你的預發言草稿】（無草稿，請直接發言 30-60 字）。`;
}
//# sourceMappingURL=ai-scheduler.js.map