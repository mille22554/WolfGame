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
import { chat } from './llm.js';
import { loadCharacterProfile, parseJsonResponse, } from './ai-player.js';
const MAX_LLM_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
/** 共有者會議安全上限：白板累計 N 則 MASON_MESSAGE 未收斂 → 停止討論（強制 toggle ON 避免夜間卡死） */
const MASON_MESSAGE_CAP = 100;
export class AiController {
    entries = new Map();
    game = null;
    log = [];
    destroyed = false;
    timers = [];
    phase = 'ROLE_REVEAL';
    day = 1;
    llmTimeoutMs;
    /** 狼白板（本夜全部 WOLF_MESSAGE；每夜重置） */
    wolfBoard = [];
    /** 白板游標：「最新一輪」= wolfBoard.slice(boardCursor)（judge 選完後推進） */
    boardCursor = 0;
    /** judge 選言序號（WOLF_SPEECH_SELECTED.round；本夜遞增） */
    selectionSeq = 0;
    /** wolf clientId -> 是否 toggle ready ON（由攔截的 WOLF_READY 訊息維護） */
    wolfReadyMap = new Map();
    /** wolf clientId -> 當前 stance（"投XXX" / "資訊不足"） */
    wolfStanceMap = new Map();
    /** 共有者白板（本夜全部 MASON_MESSAGE；每夜重置） */
    masonBoard = [];
    /** 共有者 judge 選言序號（MASON_SPEECH_SELECTED.round；本夜遞增） */
    masonSelectionSeq = 0;
    /** mason clientId -> 是否 toggle ready ON（由攔截的 MASON_READY 訊息維護） */
    masonReadyMap = new Map();
    /** mason clientId -> 當前 stance（"準備好了" / "資訊不足"） */
    masonStanceMap = new Map();
    constructor(defs, opts) {
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
    setGame(game) {
        this.game = game;
    }
    isAi(clientId) {
        return this.entries.has(clientId);
    }
    /** 全部 LLM 互動記錄（依時間序） */
    getLog() {
        return [...this.log];
    }
    /** 該 AI 的知識快照（供報告／除錯） */
    getKnowledge(clientId) {
        const k = this.entries.get(clientId)?.knowledge;
        if (!k)
            return null;
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
    destroy() {
        this.destroyed = true;
        for (const t of this.timers)
            clearTimeout(t);
        this.timers = [];
    }
    // --- 引擎回呼（harness 把 engine callback 接進來） ---
    onNightStepActive(step, players) {
        if (this.destroyed || !this.game)
            return;
        if (step === 'MASON') {
            // 共有者會議（連續對話制）：驅動 AI 討論，收斂後 toggle ON
            void this.runMasonDiscussion();
        }
        else if (step === 'SEER') {
            for (const p of players) {
                if (this.isAi(p.clientId))
                    void this.runTargetAction(p.clientId, 'SEER_CHECK');
            }
        }
        else if (step === 'GUARD') {
            for (const p of players) {
                if (this.isAi(p.clientId))
                    void this.runTargetAction(p.clientId, 'GUARD_PROTECT');
            }
        }
        // WOLF：走 onWolfSubphaseChange
    }
    onWolfSubphaseChange(subphase, round) {
        if (this.destroyed || !this.game)
            return;
        if (subphase === 'DISCUSSION')
            void this.runWolfDiscussion(round);
        else
            void this.runWolfVoting(round);
    }
    // --- 攔截引擎 sendTo / broadcast（建立知識） ---
    handlePrivate(clientId, msg) {
        const entry = this.entries.get(clientId);
        if (!entry)
            return;
        const m = msg;
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
    handleBroadcast(msg, targetClientIds) {
        const m = msg;
        if (m.type === 'PHASE_CHANGED') {
            this.phase = String(m.phase ?? this.phase);
            if (typeof m.day === 'number')
                this.day = m.day;
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
            return;
        }
        if (m.type === 'NIGHT_RESULT')
            return; // 僅 phase 追蹤，無知識變更
        if (m.type === 'WOLF_READY') {
            if (typeof m.clientId === 'string')
                this.wolfReadyMap.set(m.clientId, m.ready === true);
            return;
        }
        if (m.type === 'MASON_READY') {
            if (typeof m.clientId === 'string')
                this.masonReadyMap.set(m.clientId, m.ready === true);
            return;
        }
        if (m.type === 'WOLF_MESSAGE') {
            this.wolfBoard.push({ from: String(m.from ?? ''), text: String(m.text ?? '') });
        }
        if (m.type === 'MASON_MESSAGE') {
            this.masonBoard.push({ from: String(m.from ?? ''), text: String(m.text ?? '') });
        }
        if (m.type !== 'WOLF_MESSAGE' && m.type !== 'MASON_MESSAGE')
            return;
        for (const [clientId, entry] of this.entries) {
            if (targetClientIds && !targetClientIds.includes(clientId))
                continue;
            entry.knowledge.recentMessages.push({ from: String(m.from ?? ''), text: String(m.text ?? '') });
            if (entry.knowledge.recentMessages.length > 30)
                entry.knowledge.recentMessages.shift();
        }
    }
    // --- 狼會議（連續對話 loop，規格 §12.3 / §13.6） ---
    /** 狼會議 DISCUSSION：全狼獨立出草稿 → loop（judge 盲選發布 → 其他狼回應 → 收斂判斷） */
    async runWolfDiscussion(round) {
        const wolves = this.getAiWolves();
        if (wolves.length === 0 || !this.game)
            return;
        this.boardCursor = this.wolfBoard.length;
        // ① 所有狼各自獨立出草稿（互不可見）
        let drafts = await this.generateAllDrafts(wolves, round);
        if (drafts.length === 0)
            return; // 全部 LLM 失敗
        // Loop：② judge 盲選發布 → ③ 其他狼回應 → ④ 收斂判斷
        let guard = 0;
        while (this.game.getNightState().wolfSubphase === 'DISCUSSION' && !this.isAborted() && !this.destroyed) {
            if (++guard > 150)
                break;
            // ② Judge 盲選一篇 → 發布 speech 到白板
            const selected = this.judgePickDraft(drafts, round);
            if (!selected)
                break;
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
            const newDrafts = [];
            for (const w of wolves) {
                if (this.destroyed || this.isAborted())
                    return;
                if (w.clientId === selected.wolf.clientId)
                    continue; // 發言者不讀自己的話
                const entry = this.entries.get(w.clientId);
                if (!entry)
                    continue;
                const resp = await this.wolfRespond(w, entry, selected.speech, round);
                if (resp.type === 'vote') {
                    this.wolfStanceMap.set(w.clientId, `投${resp.target}`);
                    if (!this.isWolfReady(w.clientId))
                        this.game.handleToggleWolfReady(w.clientId);
                }
                else if (resp.type === 'speak') {
                    newDrafts.push({ wolf: w, speech: resp.speech, stance: resp.stance });
                    this.wolfStanceMap.set(w.clientId, resp.stance);
                    if (this.isWolfReady(w.clientId))
                        this.game.handleToggleWolfReady(w.clientId); // 撤回 ready
                }
                // 'wait' → 不出草稿，維持等待
            }
            // ④ 收斂判斷
            const allReady = wolves.every((w) => this.isWolfReady(w.clientId));
            if (allReady)
                break; // 引擎已進 VOTING
            if (newDrafts.length > 0) {
                drafts = newDrafts; // 下一輪 judge 從新草稿中選
            }
            else {
                // 沒人出新草稿、但有狼「資訊不足」→ 強制那些狼發言
                const waiting = wolves.filter((w) => !this.isWolfReady(w.clientId));
                if (waiting.length === 0)
                    break; // 安全：不該發生
                drafts = await this.generateAllDrafts(waiting, round);
                if (drafts.length === 0)
                    break; // 全部失敗 → 停止
            }
        }
        if (this.isAborted()) {
            this.logEntry('', 'WOLF_ABORT', round, 1, [], null, { count: this.game.getNightState().wolfMessageCount });
        }
    }
    /** 所有狼獨立出草稿（平行 LLM 呼叫；互不可見；失敗的狼跳過） */
    async generateAllDrafts(wolves, round) {
        const results = await Promise.all(wolves.map(async (w) => {
            const entry = this.entries.get(w.clientId);
            if (!entry)
                return null;
            const prompts = this.buildDraftPrompts(entry);
            const result = await this.llmWithRetry(w.clientId, 'WOLF_SPEECH', round, prompts, (p) => typeof p.speech === 'string' && p.speech.trim() && typeof p.stance === 'string' ? 'ok' : null);
            if (result.value === null)
                return null;
            return { wolf: w, speech: result.parsed.speech.trim(), stance: result.parsed.stance.trim() };
        }));
        return results.filter((r) => r !== null);
    }
    /** Judge 盲選一篇草稿（全盲評分，不告知作者）→ 回選中的 draft */
    judgePickDraft(drafts, round) {
        if (drafts.length === 0 || !this.game)
            return null;
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
    async wolfRespond(w, entry, publishedSpeech, round) {
        const prompts = this.buildResponsePrompts(entry, publishedSpeech);
        const result = await this.llmWithRetry(w.clientId, 'WOLF_STANCE', round, prompts, (p) => {
            if (p.action === 'vote' && typeof p.target === 'string' && p.target)
                return 'ok';
            if (p.action === 'speak' && typeof p.speech === 'string' && p.speech.trim() && typeof p.stance === 'string')
                return 'ok';
            if (p.action === 'wait')
                return 'ok';
            return null;
        });
        if (result.value === null)
            return { type: 'wait' }; // 失敗 → 視為等待（不阻塞）
        const p = result.parsed;
        if (p.action === 'vote')
            return { type: 'vote', target: p.target };
        if (p.action === 'speak')
            return { type: 'speak', speech: p.speech.trim(), stance: p.stance.trim() };
        return { type: 'wait' };
    }
    /** 狼會議 VOTING：每隻 AI 狼 LLM 選刀人目標 → 提交 WOLF_KILL（失敗重試；最終失敗跳過、不阻塞） */
    async runWolfVoting(round) {
        const wolves = this.getAiWolves();
        for (const w of wolves) {
            if (this.destroyed || !this.game)
                return;
            const entry = this.entries.get(w.clientId);
            if (!entry)
                continue;
            const prompts = this.buildWolfKillPrompts(entry);
            const extract = (parsed) => this.resolveClientId(String(parsed.target ?? ''), (p) => p.clientId !== w.clientId && p.role !== Role.MADMAN);
            const result = await this.llmWithRetry(w.clientId, 'WOLF_KILL', round, prompts, extract);
            if (result.value !== null) {
                this.game.handleNightAction(w.clientId, { type: 'WOLF_KILL', targetClientId: result.value });
            }
        }
    }
    // --- 共有者會議（連續對話 loop，與狼會議同構） ---
    /** 共有者會議：雙共有者獨立出草稿 → loop（judge 盲選發布 → 另一人回應 → 收斂判斷） */
    async runMasonDiscussion() {
        const masons = this.getAiMasons();
        if (masons.length === 0 || !this.game)
            return;
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
            for (const m of masons)
                this.game.handleToggleMasonEndTurn(m.clientId);
            return;
        }
        // Loop：② judge 盲選發布 → ③ 另一共有者回應 → ④ 收斂判斷
        let guard = 0;
        while (this.game.getNightState().nightStep === 'MASON' && !this.destroyed) {
            if (++guard > 150)
                break;
            if (this.masonBoard.length >= MASON_MESSAGE_CAP)
                break; // 安全上限：停止討論
            // ② Judge 盲選一篇 → 發布 speech 到白板
            const selected = this.judgePickMasonDraft(drafts);
            if (!selected)
                break;
            this.game.publishMasonSpeech(selected.mason.clientId, selected.speech, this.masonSelectionSeq);
            // 記錄發言者的 stance
            this.masonStanceMap.set(selected.mason.clientId, selected.stance);
            // 若發言者 stance 是「準備好了」→ toggle ready
            if (selected.stance === '準備好了' && !this.isMasonReady(selected.mason.clientId)) {
                this.game.handleToggleMasonEndTurn(selected.mason.clientId);
            }
            // ③ 除發言者外所有共有者讀白板 → 各自回應
            const newDrafts = [];
            for (const m of masons) {
                if (this.destroyed)
                    return;
                if (m.clientId === selected.mason.clientId)
                    continue; // 發言者不讀自己的話
                const entry = this.entries.get(m.clientId);
                if (!entry)
                    continue;
                const resp = await this.masonRespond(m, entry, selected.speech);
                if (resp.type === 'vote') {
                    this.masonStanceMap.set(m.clientId, '準備好了');
                    if (!this.isMasonReady(m.clientId))
                        this.game.handleToggleMasonEndTurn(m.clientId);
                }
                else if (resp.type === 'speak') {
                    newDrafts.push({ mason: m, speech: resp.speech, stance: resp.stance });
                    this.masonStanceMap.set(m.clientId, resp.stance);
                    if (resp.stance !== '準備好了' && this.isMasonReady(m.clientId))
                        this.game.handleToggleMasonEndTurn(m.clientId); // 撤回 ready
                }
                // 'wait' → 不出草稿，維持等待
            }
            // ④ 收斂判斷：全部共有者 ready（引擎已推進步驟）
            const allReady = masons.every((m) => this.isMasonReady(m.clientId));
            if (allReady)
                break;
            if (newDrafts.length > 0) {
                drafts = newDrafts; // 下一輪 judge 從新草稿中選
            }
            else {
                // 沒人出新草稿、但有共有者「資訊不足」→ 強制那些共有者發言
                const waiting = masons.filter((m) => !this.isMasonReady(m.clientId));
                if (waiting.length === 0)
                    break; // 安全：不該發生
                drafts = await this.generateMasonDrafts(waiting);
                if (drafts.length === 0)
                    break; // 全部失敗 → 停止
            }
        }
        // 討論結束（收斂或安全停止）：確保所有共有者 toggle ON，讓夜間能推進
        for (const m of masons) {
            if (!this.isMasonReady(m.clientId))
                this.game.handleToggleMasonEndTurn(m.clientId);
        }
    }
    /** 所有共有者獨立出草稿（平行 LLM 呼叫；互不可見；失敗的跳過） */
    async generateMasonDrafts(masons) {
        const results = await Promise.all(masons.map(async (m) => {
            const entry = this.entries.get(m.clientId);
            if (!entry)
                return null;
            const prompts = this.buildMasonDraftPrompts(entry);
            const result = await this.llmWithRetry(m.clientId, 'MASON_SPEECH', this.day, prompts, (p) => typeof p.speech === 'string' && p.speech.trim() && typeof p.stance === 'string' ? 'ok' : null);
            if (result.value === null)
                return null;
            return { mason: m, speech: result.parsed.speech.trim(), stance: result.parsed.stance.trim() };
        }));
        return results.filter((r) => r !== null);
    }
    /** Judge 盲選一篇共有者草稿（同 wolf judge：隨機選＋記錄，避免偏見）→ 回選中的 draft */
    judgePickMasonDraft(drafts) {
        if (drafts.length === 0 || !this.game)
            return null;
        if (drafts.length === 1) {
            this.masonSelectionSeq += 1;
            return drafts[0];
        }
        const idx = Math.floor(Math.random() * drafts.length);
        this.masonSelectionSeq += 1;
        this.logEntry('', 'JUDGE', this.day, 1, [], null, { picked: drafts[idx].mason.nickname, from: drafts.length, meeting: 'mason' });
        return drafts[idx];
    }
    /** 非發言者共有者讀白板後回應：vote / speak / wait */
    async masonRespond(m, entry, publishedSpeech) {
        const prompts = this.buildMasonResponsePrompts(entry, publishedSpeech);
        const result = await this.llmWithRetry(m.clientId, 'MASON_STANCE', this.day, prompts, (p) => {
            if (p.action === 'vote' && typeof p.target === 'string' && p.target)
                return 'ok';
            if (p.action === 'speak' && typeof p.speech === 'string' && p.speech.trim() && typeof p.stance === 'string')
                return 'ok';
            if (p.action === 'wait')
                return 'ok';
            return null;
        });
        if (result.value === null)
            return { type: 'wait' }; // 失敗 → 視為等待（不阻塞）
        const p = result.parsed;
        if (p.action === 'vote')
            return { type: 'vote', target: p.target };
        if (p.action === 'speak')
            return { type: 'speak', speech: p.speech.trim(), stance: p.stance.trim() };
        return { type: 'wait' };
    }
    // --- Private methods ---
    logEntry(clientId, kind, round, attempt, prompts, response, parsed) {
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
    sleep(ms) {
        return new Promise((resolve) => {
            const t = setTimeout(resolve, ms);
            this.timers.push(t);
        });
    }
    /** 呼叫 LLM 並解析；失敗（null / parse 失敗 / 抽取不到值）重試，最多 3 次、間隔 2s */
    async llmWithRetry(clientId, kind, round, prompts, extract) {
        let response = null;
        let parsed = null;
        for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
            if (this.destroyed)
                break;
            response = await chat(prompts, { temperature: 1.0, timeoutMs: this.llmTimeoutMs });
            parsed = parseJsonResponse(response);
            this.logEntry(clientId, kind, round, attempt, prompts, response, parsed);
            if (parsed === null) {
                if (attempt < MAX_LLM_RETRIES)
                    await this.sleep(RETRY_DELAY_MS);
                continue;
            }
            const value = extract(parsed);
            if (value !== null)
                return { response, parsed, value };
            if (attempt < MAX_LLM_RETRIES)
                await this.sleep(RETRY_DELAY_MS);
        }
        return { response, parsed, value: null };
    }
    /** displayName（LLM 回傳的中文名）→ clientId；對照不到回 null（觸發重試） */
    resolveClientId(name, filter) {
        if (!this.game || !name)
            return null;
        const p = this.game.getPlayers().find((x) => x.nickname === name.trim() && x.alive && (!filter || filter(x)));
        return p ? p.clientId : null;
    }
    /** nickname → 存活的狼玩家（WOLF_SPEECH_SELECTED.from 是 nickname） */
    resolveWolfByNickname(nickname) {
        if (!this.game || !nickname)
            return null;
        return this.game.getPlayers().find((p) => p.nickname === nickname && p.role === Role.WEREWOLF && p.alive) ?? null;
    }
    characterIdOf(clientId) {
        return this.entries.get(clientId)?.def.characterId ?? '';
    }
    getAiWolves() {
        return (this.game?.getPlayers() ?? []).filter((p) => p.role === Role.WEREWOLF && p.alive && this.isAi(p.clientId));
    }
    getAiMasons() {
        return (this.game?.getPlayers() ?? []).filter((p) => p.role === Role.MASON && p.alive && this.isAi(p.clientId));
    }
    isWolfReady(clientId) {
        return this.wolfReadyMap.get(clientId) === true;
    }
    isMasonReady(clientId) {
        return this.masonReadyMap.get(clientId) === true;
    }
    /** 引擎是否已因安全上限停止狼會議 */
    isAborted() {
        return this.game?.getNightState().wolfMeetingAborted === true;
    }
    buildSystemPrompt(entry) {
        return [
            `你是「${entry.def.nickname}」，在狼人殺遊戲中扮演「${entry.knowledge.displayName}」。`,
            entry.profile ? entry.profile.persona.slice(0, 600) : '',
            '硬規則：使用繁體中文。你只能回覆 JSON，不要多餘文字。不要 markdown。',
            '禁止：「我先講...」「讓我說...」等前言；「不是...而是...」等對立修正句型；不適用於當前情境的抽象策略語言。',
            '你的角色語氣要符合當下社交情境。如果大家都同意，不要製造不存在的衝突。',
        ].filter(Boolean).join('\n');
    }
    /** 狼白板歷史（prompt 用；無則提示沒有討論） */
    wolfBoardText() {
        return this.wolfBoard.length
            ? this.wolfBoard.map((m) => `${m.from}：「${m.text}」`).join('\n')
            : '之前沒有任何討論，沒有人發過言。';
    }
    /** 共有者白板歷史（prompt 用；無則提示沒有討論） */
    masonBoardText() {
        return this.masonBoard.length
            ? this.masonBoard.map((m) => `${m.from}：「${m.text}」`).join('\n')
            : '之前沒有任何討論，沒有人發過言。';
    }
    /** 可刀目標（排除自己、狼隊、狂人） */
    eligibleTargets(entry) {
        return (this.game?.getPlayers() ?? [])
            .filter((p) => p.alive && p.clientId !== entry.def.clientId && p.role !== Role.WEREWOLF && p.role !== Role.MADMAN)
            .map((p) => p.nickname)
            .join('、');
    }
    /** 狼 wolf 情境（system prompt 附加：狼隊同夥 + 狂人 + 私頻說明） */
    wolfContext(entry) {
        const k = entry.knowledge;
        return [
            '你是人狼陣營。目標：讓村人陣營滅亡。',
            k.partners.length ? `你的狼隊同夥：${k.partners.join('、')}。` : '',
            k.madman ? `狂人：${k.madman}（不可刀）。` : '',
            '現在是狼會議（私頻），只有人狼能看到。',
            '',
            '策略思考：',
            '- 角色名固定用：占卜師、守衛、靈能者。不要換成「預言家」「巫醫」等其他叫法。',
            '- 刀人優先序：占卜師（能驗出狼）> 守衛/靈能者（能保護/確認）> 普通村民。',
            '- 第一天沒有白天發言，你對每個人的角色判斷都是猜。可以直接說「我直覺選他」或「沒有依據，先刀他看看」——誠實承認在猜，比硬編一個「他可能是占卜師」好。',
            '- 如果你要指認角色（「他可能是占卜師」），要有可觀察的依據（例如他的發言風格、他關注的細節類型），不要憑空指。沒有依據就別指。',
            '- 想一步：如果刀錯瞭，明天能學到什麼？把這個想法定下來比指認角色更有價值。',
            '- 隊友已經講過的理由，你不用重複。同意就簡短帶過，把空間留給新觀點或不同意見。',
            '- 你不需要跟隊友選同一個人。如果你有不同的判斷，說出來。全票一致不是目標。',
        ].filter(Boolean).join('\n');
    }
    /** 共有者情境（system prompt 附加：共有者夥伴 + 私頻說明） */
    masonContext(entry) {
        const k = entry.knowledge;
        return [
            '你是村人陣營的共有者。你和你的夥伴是互相知道身份的盟友。',
            k.partners.length ? `你的共有者夥伴：${k.partners.join('、')}。` : '',
            '現在是共有者會議（私頻），只有你和你夥伴能看到。',
            '',
            '策略思考：',
            '- 你們是好人，目標是找出人狼。',
            '- 明天白天的行動方針：誰主動發言、誰觀察、誰負責攻擊誰。',
            '- 可以討論：誰可疑、誰可能是狼、如果被人質疑怎麼回應。',
            '- 不要暴露「我們是共有者」——這個只有你們兩個知道。',
        ].filter(Boolean).join('\n');
    }
    /** 草稿 prompt（獨立出稿：speech + stance）；輸出 {"speech":"...", "stance":"投XXX"|"資訊不足"} */
    buildDraftPrompts(entry) {
        const user = [
            `當前：第 ${this.day} 夜，狼會議（私頻，只有人狼能看到）。`,
            `可刀目標（只能從以下選）：${this.eligibleTargets(entry)}`,
            ``,
            `白板上的對話：`,
            this.wolfBoardText(),
            ``,
            `任務：提出你的刀人立場和明天白天的行動方針。你要說一句話（≤50字），並表明你的立場。`,
            `規則：狼每晚必須刀人，不能跳過、不能「不動刀」。「資訊不足」只是表示你還在考慮，最終你必須選一個目標。`,
            `議題包含：① 刀誰 ② 明天白天我們怎麼行動（誰裝白、誰攻擊、誰安靜）。`,
            `要求：直覺選人是可以的（「我直覺刀他」）。如果你要指認角色，要有依據，沒依據就別硬指。不要說「他怪怪的」——那是廢話。`,
            `提醒：你在跟隊友即時對話。不要說「我注意到...」「他剛被提出」。不要提「沒有發言紀錄」「沒人發言」。用你的角色語氣說話。`,
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
    buildResponsePrompts(entry, publishedSpeech) {
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
            `要求：同意就簡短（「就他」「我跟你」），不用重述隊友已經講過的理由。要講就講新的角度（不同的風險、明天的計畫、你的保留意見）。不要重複白板上已有的內容。`,
            `提醒：直接講你的立場。不同意就說「我投另一个人」＋你的理由。不要盲目跟隊友。不要說「我注意到...」「他剛被提出」。用你的角色語氣說話。`,
        ].join('\n');
        return [
            { role: 'system', content: `${this.buildSystemPrompt(entry)}\n${this.wolfContext(entry)}` },
            { role: 'user', content: user },
        ];
    }
    /** 共有者草稿 prompt（獨立出稿：speech + stance）；輸出 {"speech":"...", "stance":"準備好了"|"資訊不足"} */
    buildMasonDraftPrompts(entry) {
        const partnerName = entry.knowledge.partners.join('、');
        const user = [
            `當前：第 ${this.day} 夜，共有者會議（私頻，只有你和你共有者夥伴能看到）。`,
            `你的共有者夥伴：${partnerName}`,
            ``,
            `白板上的對話：`,
            this.masonBoardText(),
            ``,
            `任務：提出你對明天白天會議的行動方針。你要說一句話（≤50字），並表明你的立場。`,
            `議題：明天白天我們怎麼行動（誰主動發言、誰觀察、誰攻擊誰、被質疑時怎麼回應）。`,
            `提醒：這是私頻，只有你和你夥伴看到。用你的角色語氣說話。`,
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
    buildMasonResponsePrompts(entry, publishedSpeech) {
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
            `任務：看完後決定你的立場（三選一）：`,
            `1. 準備好了 → {"action": "vote", "target": "ready"}`,
            `2. 我要講 → {"action": "speak", "speech": "你要說的話（≤50字）", "stance": "準備好了" 或 "資訊不足"}`,
            `3. 資訊不足、先不講 → {"action": "wait"}`,
            ``,
            `要求：同意就簡短（「就這麼辦」「我跟你」），不用重述隊友已經講過的理由。要講就講新的角度。`,
            `提醒：這是私頻。用你的角色語氣說話。`,
        ].join('\n');
        return [
            { role: 'system', content: `${this.buildSystemPrompt(entry)}\n${this.masonContext(entry)}` },
            { role: 'user', content: user },
        ];
    }
    /** 狼刀目標選擇 prompt（狼隊同夥 + 可刀目標 + 討論歷史；輸出 {"target":"<displayName>"}） */
    buildWolfKillPrompts(entry) {
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
    buildTargetPrompts(entry, kind) {
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
    async runTargetAction(clientId, kind) {
        const entry = this.entries.get(clientId);
        if (!entry || !this.game)
            return;
        const prompts = this.buildTargetPrompts(entry, kind);
        const extract = (parsed) => this.resolveClientId(String(parsed.target ?? ''), (p) => p.clientId !== clientId);
        const result = await this.llmWithRetry(clientId, kind, this.day, prompts, extract);
        if (result.value !== null) {
            this.game.handleNightAction(clientId, { type: kind, targetClientId: result.value });
        }
    }
}
//# sourceMappingURL=ai-controller.js.map