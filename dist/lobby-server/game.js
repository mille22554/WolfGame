/**
 * game.ts — 單一房間的遊戲引擎（ubuntu 分支 M5 + stage 2 狼會議）
 *
 * 簡化 phase 狀態機：phase timer + 直接 state mutation（不用 event queue，見規格 §12.10）。
 *
 * 流程：ROLE_REVEAL(10s) → NIGHT(不限時，依序解鎖) → NIGHT_RESULT(10s) → DAY_DISCUSSION(120s)
 *       → DAY_VOTING(60s) → DAY_RESULT(10s) →（勝利判定）→ 下一夜... → GAME_OVER
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
import { Role, Team, ROLE_CONFIG, ROLE_TEAM, getDisplayName, getDescription, seerSeesAs } from '../types.js';
import { MAX_MESSAGE_LEN } from './types.js';
export class GameEngine {
    roomCode;
    players;
    callbacks;
    wolfMessageCap;
    state;
    timers = [];
    countdownInterval;
    constructor(roomCode, players, callbacks, wolfMessageCap = 0) {
        this.roomCode = roomCode;
        this.players = players;
        this.callbacks = callbacks;
        this.wolfMessageCap = wolfMessageCap;
        this.state = {
            phase: 'ROLE_REVEAL',
            day: 1,
            players: [],
            nightActions: [],
            votes: [],
            deathHistory: [],
            winner: null,
            lastVoteDeathClientId: null,
            nightStep: null,
            nightSteps: [],
            masonReady: new Map(),
            dayReady: new Map(),
            wolfReady: new Map(),
            wolfSubphase: null,
            wolfVotes: new Map(),
            wolfMeetingRound: 1,
            wolfTargetId: null,
            wolfMessageCount: 0,
            wolfMeetingAborted: false,
        };
    }
    /** 開始遊戲：分配角色、私發 ROLE_REVEALED、進入 phase 循環 */
    start() {
        this.assignRoles();
        const madman = this.state.players.find((p) => p.role === Role.MADMAN);
        for (const p of this.state.players) {
            const partners = [];
            if (p.role === Role.WEREWOLF) {
                for (const id of p.wolfPartnerIds) {
                    const w = this.getPlayerByClientId(id);
                    if (w)
                        partners.push(w.nickname);
                }
            }
            else if (p.role === Role.MASON && p.masonPartnerId) {
                const m = this.getPlayerByClientId(p.masonPartnerId);
                if (m)
                    partners.push(m.nickname);
            }
            const msg = {
                type: 'ROLE_REVEALED',
                role: p.role,
                displayName: getDisplayName(p.role),
                description: getDescription(p.role),
                partners,
            };
            // 規格 §12.2：人狼知道狂人是誰（AI 需據此排除狂人不可刀）
            if (p.role === Role.WEREWOLF && madman)
                msg.madman = madman.nickname;
            this.callbacks.sendTo(p.clientId, msg);
        }
        this.transitionTo('ROLE_REVEAL');
    }
    /** 處理夜間行動提交（依序解鎖：各行動只在對應 nightStep 時受理） */
    handleNightAction(clientId, action) {
        if (this.state.phase !== 'NIGHT')
            return;
        const player = this.getPlayerByClientId(clientId);
        if (!player || !player.alive)
            return;
        // 行動類型必須符合角色
        if (action.type === 'WOLF_KILL' && player.role !== Role.WEREWOLF)
            return;
        if (action.type === 'SEER_CHECK' && player.role !== Role.SEER)
            return;
        if (action.type === 'GUARD_PROTECT' && player.role !== Role.GUARD)
            return;
        // 依序解鎖：WOLF_KILL 只在狼會議投票環節受理；SEER/GUARD 只在各自步驟受理
        if (action.type === 'WOLF_KILL' && (this.state.nightStep !== 'WOLF' || this.state.wolfSubphase !== 'VOTING'))
            return;
        if (action.type === 'SEER_CHECK' && this.state.nightStep !== 'SEER')
            return;
        if (action.type === 'GUARD_PROTECT' && this.state.nightStep !== 'GUARD')
            return;
        // 守衛 Day1 不可行動
        if (action.type === 'GUARD_PROTECT' && this.state.day === 1)
            return;
        // 目標驗證：不可是自己、目標必須存在且存活；人狼不可選狂人
        if (action.targetClientId === clientId)
            return;
        const target = this.getPlayerByClientId(action.targetClientId);
        if (!target || !target.alive)
            return;
        if (action.type === 'WOLF_KILL' && target.role === Role.MADMAN)
            return;
        if (action.type === 'WOLF_KILL') {
            // 狼投票：存 wolfVotes（覆蓋式）；所有存活狼皆已提交 → 計票
            this.state.wolfVotes.set(clientId, action.targetClientId);
            if (this.allWolvesVoted())
                this.resolveWolfVote();
            return;
        }
        // GUARD_PROTECT / SEER_CHECK：單人行動，存 nightActions（覆蓋式）→ 推進下一步
        const entry = { actorClientId: clientId, type: action.type, targetClientId: action.targetClientId };
        const idx = this.state.nightActions.findIndex((a) => a.actorClientId === clientId && a.type === action.type);
        if (idx >= 0)
            this.state.nightActions[idx] = entry;
        else
            this.state.nightActions.push(entry);
        this.completeNightStep();
    }
    /** 共有者 toggle 回合結束（開/關）；雙人都 ON → 解鎖下一步 */
    handleToggleMasonEndTurn(clientId) {
        if (this.state.phase !== 'NIGHT' || this.state.nightStep !== 'MASON')
            return;
        const player = this.getPlayerByClientId(clientId);
        if (!player || player.role !== Role.MASON || !player.alive)
            return;
        const ready = !(this.state.masonReady.get(clientId) ?? false);
        this.state.masonReady.set(clientId, ready);
        this.callbacks.broadcast({ type: 'MASON_READY', clientId, ready });
        if (this.allMasonsReady())
            this.completeNightStep();
    }
    /** 人狼 toggle「準備投票」（開/關）；全 ready → 進入 VOTING */
    handleToggleWolfReady(clientId) {
        if (this.state.phase !== 'NIGHT' || this.state.nightStep !== 'WOLF' || this.state.wolfSubphase !== 'DISCUSSION')
            return;
        if (this.state.wolfMeetingAborted)
            return; // 安全上限已觸發：停止受理
        const player = this.getPlayerByClientId(clientId);
        if (!player || player.role !== Role.WEREWOLF || !player.alive)
            return;
        const ready = !(this.state.wolfReady.get(clientId) ?? false);
        this.state.wolfReady.set(clientId, ready);
        this.callbacks.broadcast({ type: 'WOLF_READY', clientId, ready }, this.getAliveWolves().map((p) => p.clientId));
        if (this.allWolvesReady()) {
            this.state.wolfSubphase = 'VOTING';
            this.callbacks.onWolfSubphaseChange?.('VOTING', this.state.wolfMeetingRound);
        }
    }
    /** 處理投票（targetClientId = null → 棄票） */
    handleVote(clientId, targetClientId) {
        if (this.state.phase !== 'DAY_VOTING')
            return;
        const player = this.getPlayerByClientId(clientId);
        if (!player || !player.alive)
            return;
        if (targetClientId !== null) {
            if (targetClientId === clientId)
                return; // 不可投自己
            const target = this.getPlayerByClientId(targetClientId);
            if (!target || !target.alive)
                return;
        }
        const idx = this.state.votes.findIndex((v) => v.voterClientId === clientId);
        if (idx >= 0)
            this.state.votes[idx] = { voterClientId: clientId, targetClientId };
        else
            this.state.votes.push({ voterClientId: clientId, targetClientId });
        // 所有存活玩家皆已投票（含棄票）→ 提前結算
        if (this.getAlivePlayers().every((p) => this.state.votes.some((v) => v.voterClientId === p.clientId))) {
            this.resolveVotes();
        }
    }
    /** 房主提前結束討論 */
    handleEndDiscussion(clientId) {
        if (this.state.phase !== 'DAY_DISCUSSION')
            return;
        const hostId = this.callbacks.getHostClientId?.();
        if (hostId !== undefined && hostId !== clientId)
            return; // 只有房主可提前結束
        this.transitionTo('DAY_VOTING');
    }
    /** 玩家 toggle「準備投票」（開/關）；所有存活玩家皆 ON → 推進到 DAY_VOTING */
    handleToggleVoteReady(clientId) {
        if (this.state.phase !== 'DAY_DISCUSSION')
            return;
        const player = this.getPlayerByClientId(clientId);
        if (!player || !player.alive)
            return;
        const ready = !(this.state.dayReady.get(clientId) ?? false);
        this.state.dayReady.set(clientId, ready);
        const alivePlayers = this.getAlivePlayers();
        const readyList = alivePlayers
            .filter((p) => this.state.dayReady.get(p.clientId) === true)
            .map((p) => ({ clientId: p.clientId, nickname: p.nickname }));
        this.callbacks.broadcast({
            type: 'DAY_READY_STATUS',
            ready: readyList,
            total: alivePlayers.length,
        });
        // 所有存活玩家皆已 toggle ON → 推進
        if (alivePlayers.every((p) => this.state.dayReady.get(p.clientId) === true)) {
            this.transitionTo('DAY_VOTING');
        }
    }
    /** AI 白天發言（broadcast MESSAGE 到公頻；复用 lobby 的 MESSAGE 協議） */
    sendDayMessage(clientId, text) {
        const player = this.getPlayerByClientId(clientId);
        if (!player)
            return;
        this.callbacks.broadcast({ type: 'MESSAGE', from: player.nickname, text, ts: Date.now() });
    }
    /** 人狼私頻（僅狼會議步驟可用、僅存活人狼可見）；累計訊息數，達安全上限 → 停止並報告 */
    handleWolfChat(clientId, text) {
        if (this.state.phase !== 'NIGHT' || this.state.nightStep !== 'WOLF')
            return;
        if (this.state.wolfMeetingAborted)
            return; // 安全上限已觸發：停止受理
        const player = this.getPlayerByClientId(clientId);
        if (!player || player.role !== Role.WEREWOLF || !player.alive)
            return;
        const clean = text.trim();
        if (clean.length === 0 || clean.length > MAX_MESSAGE_LEN)
            return;
        this.state.wolfMessageCount += 1;
        this.callbacks.broadcast({ type: 'WOLF_MESSAGE', from: player.nickname, text: clean, ts: Date.now() }, this.getAliveWolves().map((p) => p.clientId));
        // 安全上限（僅測試用；wolfMessageCap > 0 時啟用）
        if (this.wolfMessageCap > 0 && this.state.wolfMessageCount >= this.wolfMessageCap)
            this.abortWolfMeeting();
    }
    /** 狼會議安全上限觸發：標記停止＋broadcast 報告（night 停在 WOLF step，由 harness 觀察 timeout 兜底） */
    abortWolfMeeting() {
        this.state.wolfMeetingAborted = true;
        this.callbacks.broadcast({ type: 'WOLF_MEETING_ABORTED', count: this.state.wolfMessageCount, reason: '白板累計 100 則 WOLF_MESSAGE 未收斂' }, this.getAliveWolves().map((p) => p.clientId));
    }
    /** 廣播給所有存活人狼（AI 控制器用：WOLF_SPEECH_SELECTED 等） */
    broadcastToWolves(msg) {
        this.callbacks.broadcast(msg, this.getAliveWolves().map((p) => p.clientId));
    }
    /** 共有者私頻（僅 MASON step 可用、僅雙方可見） */
    handleMasonChat(clientId, text) {
        if (this.state.phase !== 'NIGHT' || this.state.nightStep !== 'MASON')
            return;
        const player = this.getPlayerByClientId(clientId);
        if (!player || player.role !== Role.MASON || !player.alive)
            return;
        const clean = text.trim();
        if (clean.length === 0 || clean.length > MAX_MESSAGE_LEN)
            return;
        const targets = [player.clientId];
        if (player.masonPartnerId)
            targets.push(player.masonPartnerId);
        this.callbacks.broadcast({ type: 'MASON_MESSAGE', from: player.nickname, text: clean, ts: Date.now() }, targets);
    }
    /** 共有者會議：judge 選言發布（broadcast MASON_MESSAGE ＋ MASON_SPEECH_SELECTED，僅雙共有者可見） */
    publishMasonSpeech(speakerClientId, text, round) {
        if (this.state.phase !== 'NIGHT' || this.state.nightStep !== 'MASON')
            return;
        const player = this.getPlayerByClientId(speakerClientId);
        if (!player || player.role !== Role.MASON || !player.alive)
            return;
        const clean = text.trim();
        if (clean.length === 0 || clean.length > MAX_MESSAGE_LEN)
            return;
        const targets = [player.clientId];
        if (player.masonPartnerId)
            targets.push(player.masonPartnerId);
        this.callbacks.broadcast({ type: 'MASON_MESSAGE', from: player.nickname, text: clean, ts: Date.now() }, targets);
        this.callbacks.broadcast({ type: 'MASON_SPEECH_SELECTED', round, from: player.nickname, text: clean }, targets);
    }
    /** 清除所有 timer（房間回收時呼叫，避免孤兒 timer 讓 process 無法結束） */
    destroy() {
        this.stopCountdown();
        for (const t of this.timers)
            clearTimeout(t);
        this.timers = [];
    }
    /** 夜間狀態快照（供 harness / AI 控制器觀察狼會議進度） */
    getNightState() {
        return {
            phase: this.state.phase,
            nightStep: this.state.nightStep,
            wolfSubphase: this.state.wolfSubphase,
            wolfMeetingRound: this.state.wolfMeetingRound,
            wolfTargetId: this.state.wolfTargetId,
            wolfMessageCount: this.state.wolfMessageCount,
            wolfMeetingAborted: this.state.wolfMeetingAborted,
        };
    }
    /** 全部玩家（AI 控制器用 nickname→clientId 對照 LLM 回傳的中文名） */
    getPlayers() {
        return this.state.players;
    }
    /** 序列化目前遊戲狀態（JSON-safe；用於存檔/分階段測試 resume） */
    saveState() {
        return {
            day: this.state.day,
            players: this.state.players.map((p) => ({
                clientId: p.clientId,
                nickname: p.nickname,
                role: p.role,
                team: p.team,
                alive: p.alive,
                isMasonPartner: p.isMasonPartner,
                masonPartnerId: p.masonPartnerId ?? null,
                wolfPartnerIds: p.wolfPartnerIds,
                seerChecks: p.seerChecks,
                guardProtects: p.guardProtects,
            })),
            deathHistory: this.state.deathHistory,
            lastVoteDeathClientId: this.state.lastVoteDeathClientId,
            winner: this.state.winner,
        };
    }
    /**
     * 從存檔恢復狀態並直接進入 DAY_DISCUSSION（跳過 ROLE_REVEAL / NIGHT）。
     * 用於分階段測試：先跑 night 存檔，再 resume 只跑 day。
     */
    restoreState(snapshot) {
        this.state.day = snapshot.day;
        this.state.players = snapshot.players.map((p) => ({
            clientId: p.clientId,
            nickname: p.nickname,
            role: p.role,
            team: p.team,
            alive: p.alive,
            isMasonPartner: p.isMasonPartner,
            masonPartnerId: p.masonPartnerId ?? undefined,
            wolfPartnerIds: p.wolfPartnerIds ?? [],
            seerChecks: p.seerChecks ?? [],
            guardProtects: p.guardProtects ?? [],
        }));
        this.state.deathHistory = snapshot.deathHistory ?? [];
        this.state.lastVoteDeathClientId = snapshot.lastVoteDeathClientId ?? null;
        this.state.winner = snapshot.winner ?? null;
        // 直接跳進 DAY_DISCUSSION
        this.transitionTo('DAY_DISCUSSION');
    }
    // --- Private methods ---
    assignRoles() {
        const count = this.players.length;
        const config = ROLE_CONFIG[count] ?? ROLE_CONFIG[Math.min(15, Math.max(6, count))];
        const roles = [];
        for (const [role, n] of Object.entries(config)) {
            for (let i = 0; i < (n ?? 0); i++)
                roles.push(role);
        }
        // 防禦：實際人數與表不符時（lobby 保證 6–15）以村民補足／移除村民
        while (roles.length < count)
            roles.push(Role.VILLAGER);
        while (roles.length > count) {
            const idx = roles.lastIndexOf(Role.VILLAGER);
            roles.splice(idx === -1 ? roles.length - 1 : idx, 1);
        }
        // Fisher–Yates shuffle
        for (let i = roles.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [roles[i], roles[j]] = [roles[j], roles[i]];
        }
        this.state.players = this.players.map((p, i) => {
            const role = roles[i];
            return {
                clientId: p.clientId,
                nickname: p.nickname,
                role,
                team: ROLE_TEAM[role],
                alive: true,
                isMasonPartner: role === Role.MASON,
                wolfPartnerIds: [],
                seerChecks: [],
                guardProtects: [],
            };
        });
        // 人狼互設同夥
        const wolves = this.state.players.filter((p) => p.role === Role.WEREWOLF);
        for (const w of wolves) {
            w.wolfPartnerIds = wolves.filter((o) => o.clientId !== w.clientId).map((o) => o.clientId);
        }
        // 共有者（2 人）互設夥伴
        const masons = this.state.players.filter((p) => p.role === Role.MASON);
        for (const m of masons) {
            const partner = masons.find((o) => o.clientId !== m.clientId);
            if (partner)
                m.masonPartnerId = partner.clientId;
        }
    }
    transitionTo(phase) {
        this.state.phase = phase;
        this.callbacks.broadcast({ type: 'PHASE_CHANGED', phase, day: this.state.day });
        switch (phase) {
            case 'ROLE_REVEAL':
                this.schedule(() => this.transitionTo('NIGHT'), 10_000);
                break;
            case 'NIGHT':
                // 夜間重置：行動、ready toggle、狼投票、收斂目標
                this.state.nightActions = [];
                this.state.masonReady.clear();
                this.state.wolfReady.clear();
                this.state.wolfVotes.clear();
                this.state.wolfSubphase = null;
                this.state.wolfTargetId = null;
                this.state.wolfMeetingRound = 1;
                this.state.wolfMessageCount = 0;
                this.state.wolfMeetingAborted = false;
                // 依序解鎖（GUARD→MASON→WOLF→SEER）；規格 §12.3：NIGHT 不限時（無 timeout 截斷）
                this.state.nightSteps = this.computeNightSteps();
                this.state.nightStep = this.state.nightSteps[0] ?? null;
                if (this.state.nightStep)
                    this.activateNightStep();
                else
                    this.resolveNight(); // 無任何夜間行動角色存活 → 直接結算
                break;
            case 'NIGHT_RESULT':
                // 結果 phase 固定 10 秒；勝利判定已在 resolveNight 完成（state.winner 已設定）
                this.schedule(() => {
                    if (this.state.winner)
                        this.transitionTo('GAME_OVER');
                    else
                        this.transitionTo('DAY_DISCUSSION');
                }, 10_000);
                break;
            case 'DAY_DISCUSSION':
                // 初始化所有存活玩家的 dayReady 為 false
                this.state.dayReady = new Map();
                for (const p of this.getAlivePlayers()) {
                    this.state.dayReady.set(p.clientId, false);
                }
                this.callbacks.broadcast({
                    type: 'DAY_READY_STATUS',
                    ready: [],
                    total: this.getAlivePlayers().length,
                });
                break;
            case 'DAY_VOTING':
                this.state.votes = [];
                // 清除昨日票死記錄：霊能者只在黎明得知「昨日」的票死者
                this.state.lastVoteDeathClientId = null;
                this.startCountdown(60);
                this.schedule(() => this.resolveVotes(), 60_000);
                break;
            case 'DAY_RESULT':
                this.schedule(() => {
                    if (this.state.winner)
                        this.transitionTo('GAME_OVER');
                    else {
                        this.state.day += 1;
                        this.transitionTo('NIGHT');
                    }
                }, 10_000);
                break;
            case 'GAME_OVER':
                this.stopCountdown();
                this.callbacks.broadcast({
                    type: 'GAME_OVER',
                    winner: this.state.winner ?? Team.VILLAGE,
                    players: this.state.players.map((p) => ({
                        clientId: p.clientId,
                        nickname: p.nickname,
                        role: p.role,
                        alive: p.alive,
                    })),
                });
                break;
        }
    }
    /** 排定一次性 timer（fire 後自動從清單移除） */
    schedule(fn, ms) {
        const t = setTimeout(() => {
            this.timers = this.timers.filter((x) => x !== t);
            fn();
        }, ms);
        this.timers.push(t);
    }
    /** 倒數提醒：剩餘 <30s 時每 10s 發一次 PHASE_COUNTDOWN（60s phase → 20s、10s） */
    startCountdown(seconds) {
        this.stopCountdown();
        const phase = this.state.phase;
        const deadline = Date.now() + seconds * 1000;
        let lastSent = -1;
        this.countdownInterval = setInterval(() => {
            const remaining = Math.round((deadline - Date.now()) / 1000);
            if (remaining > 0 && remaining < 30 && remaining % 10 === 0 && remaining !== lastSent) {
                lastSent = remaining;
                this.callbacks.broadcast({ type: 'PHASE_COUNTDOWN', phase, secondsLeft: remaining });
            }
        }, 1000);
    }
    stopCountdown() {
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = undefined;
        }
    }
    /** 計算本夜依序要走的步驟（只含存活且該 day 有行動的角色） */
    computeNightSteps() {
        const steps = [];
        const alive = this.getAlivePlayers();
        if (this.state.day > 1 && alive.some((p) => p.role === Role.GUARD))
            steps.push('GUARD');
        if (alive.some((p) => p.role === Role.MASON))
            steps.push('MASON');
        if (alive.some((p) => p.role === Role.WEREWOLF))
            steps.push('WOLF');
        if (alive.some((p) => p.role === Role.SEER))
            steps.push('SEER');
        return steps;
    }
    /** 激活目前夜間步驟：WOLF 步驟進入 DISCUSSION 子階段；通知 AI 控制器 */
    activateNightStep() {
        const step = this.state.nightStep;
        if (!step)
            return;
        if (step === 'WOLF') {
            this.state.wolfSubphase = 'DISCUSSION';
            this.callbacks.onWolfSubphaseChange?.('DISCUSSION', this.state.wolfMeetingRound);
        }
        this.callbacks.onNightStepActive?.(step, this.getStepPlayers(step));
    }
    /** 該步驟對應的存活玩家 */
    getStepPlayers(step) {
        switch (step) {
            case 'GUARD': return this.getAlivePlayers().filter((p) => p.role === Role.GUARD);
            case 'MASON': return this.getAlivePlayers().filter((p) => p.role === Role.MASON);
            case 'WOLF': return this.getAliveWolves();
            case 'SEER': return this.getAlivePlayers().filter((p) => p.role === Role.SEER);
        }
    }
    /** 目前步驟完成 → 推進下一步；無下一步 → 結算夜間 */
    completeNightStep() {
        const current = this.state.nightStep;
        const idx = current === null ? this.state.nightSteps.length : this.state.nightSteps.indexOf(current);
        const next = idx >= 0 ? this.state.nightSteps[idx + 1] : undefined;
        this.state.nightStep = next ?? null;
        if (next)
            this.activateNightStep();
        else
            this.resolveNight();
    }
    /** 所有存活共有者皆已 toggle ON */
    allMasonsReady() {
        const masons = this.getAlivePlayers().filter((p) => p.role === Role.MASON);
        return masons.length > 0 && masons.every((m) => this.state.masonReady.get(m.clientId) === true);
    }
    /** 所有存活狼皆已 toggle ON */
    allWolvesReady() {
        const wolves = this.getAliveWolves();
        return wolves.length > 0 && wolves.every((w) => this.state.wolfReady.get(w.clientId) === true);
    }
    /** 所有存活狼皆已提交 WOLF_KILL */
    allWolvesVoted() {
        const wolves = this.getAliveWolves();
        return wolves.length > 0 && wolves.every((w) => this.state.wolfVotes.has(w.clientId));
    }
    /**
     * 狼投票計票（規格 §12.3）：
     * - 明確多數（2:1、3:0）→ 確定 wolfTargetId，完成 WOLF 步驟
     * - 平票（1:1、1:1:1）→ 回 DISCUSSION：ready 全重置、votes 清空、round+1、broadcast WOLF_VOTE_SPLIT
     */
    resolveWolfVote() {
        const counts = new Map();
        for (const target of this.state.wolfVotes.values())
            counts.set(target, (counts.get(target) ?? 0) + 1);
        let max = 0;
        for (const c of counts.values())
            if (c > max)
                max = c;
        const leaders = [...counts.entries()].filter(([, c]) => c === max).map(([id]) => id);
        if (leaders.length === 1) {
            this.state.wolfTargetId = leaders[0];
            this.completeNightStep();
            return;
        }
        // 平票：回討論重來（不用先提交者/隨機決狼刀）
        for (const key of this.state.wolfReady.keys())
            this.state.wolfReady.set(key, false);
        this.state.wolfVotes.clear();
        this.state.wolfSubphase = 'DISCUSSION';
        this.state.wolfMeetingRound += 1;
        this.callbacks.broadcast({ type: 'WOLF_VOTE_SPLIT', votes: Object.fromEntries(counts.entries()) }, this.getAliveWolves().map((p) => p.clientId));
        this.callbacks.onWolfSubphaseChange?.('DISCUSSION', this.state.wolfMeetingRound);
    }
    /** 夜間結算：守衛 → 人狼（收斂目標）→ 占い師 → 霊能者（黎明）；broadcast 結果後進 NIGHT_RESULT 或 GAME_OVER */
    resolveNight() {
        if (this.state.phase !== 'NIGHT')
            return; // 已提前結算過
        this.stopCountdown();
        this.state.nightStep = null;
        this.state.wolfSubphase = null;
        const wolfTargetId = this.state.wolfTargetId; // 狼會議收斂的刀人目標（平票時為 null）
        const guardedTargetId = this.applyGuard();
        const peacefulNight = wolfTargetId === null || wolfTargetId === guardedTargetId;
        const nightDeath = peacefulNight ? null : this.applyWolfKill(wolfTargetId);
        this.applySeerResult();
        this.sendDawnInfo();
        this.broadcastNightResult(peacefulNight, nightDeath, wolfTargetId, guardedTargetId);
        // 勝利判定
        const winner = this.checkWin();
        this.state.winner = winner;
        if (winner)
            this.transitionTo('GAME_OVER');
        else
            this.transitionTo('NIGHT_RESULT');
    }
    /** 守衛：記錄護衛目標（自護 → 隨機改護他人，防禦性處理）；回傳護衛目標（無則 null） */
    applyGuard() {
        const guardAction = this.state.nightActions.find((a) => a.type === 'GUARD_PROTECT');
        const guard = guardAction ? this.getPlayerByClientId(guardAction.actorClientId) : undefined;
        if (!guardAction || !guard)
            return null;
        let targetId = guardAction.targetClientId;
        if (targetId === guard.clientId) {
            const others = this.getAlivePlayers().filter((p) => p.clientId !== guard.clientId);
            if (others.length > 0)
                targetId = others[Math.floor(Math.random() * others.length)].clientId;
        }
        return targetId;
    }
    /** 人狼：刀收斂的 wolfTargetId（== 護衛目標時由呼叫方判定平安夜）；回傳被殺玩家（無則 null） */
    applyWolfKill(wolfTargetId) {
        if (!wolfTargetId)
            return null;
        const target = this.getPlayerByClientId(wolfTargetId);
        if (!target)
            return null;
        target.alive = false;
        this.state.deathHistory.push({ clientId: target.clientId, nickname: target.nickname, day: this.state.day, cause: 'wolf_kill' });
        return target;
    }
    /** 占い師：查驗結果記錄並只發給占い師 */
    applySeerResult() {
        const seerAction = this.state.nightActions.find((a) => a.type === 'SEER_CHECK');
        const seer = seerAction ? this.getPlayerByClientId(seerAction.actorClientId) : undefined;
        const seerTarget = seerAction ? this.getPlayerByClientId(seerAction.targetClientId) : undefined;
        if (!seerAction || !seer || !seerTarget)
            return;
        seer.seerChecks.push({ targetId: seerTarget.clientId, result: seerSeesAs(seerTarget.role), day: this.state.day });
        this.callbacks.sendTo(seer.clientId, {
            type: 'SEER_RESULT',
            targetClientId: seerTarget.clientId,
            nickname: seerTarget.nickname,
            result: seerSeesAs(seerTarget.role),
        });
    }
    /** 黎明：霊能者得知昨日被票死者身分（Day1 無） */
    sendDawnInfo() {
        const medium = this.state.players.find((p) => p.role === Role.MEDIUM && p.alive);
        const mediumTarget = this.state.day > 1 && this.state.lastVoteDeathClientId
            ? (this.getPlayerByClientId(this.state.lastVoteDeathClientId) ?? null)
            : null;
        if (medium && mediumTarget) {
            this.callbacks.sendTo(medium.clientId, {
                type: 'MEDIUM_RESULT',
                targetClientId: mediumTarget.clientId,
                nickname: mediumTarget.nickname,
                result: seerSeesAs(mediumTarget.role),
            });
        }
    }
    /** 廣播夜間結果：NIGHT_RESULT、GUARD_RESULT（私發）、PLAYER_ELIMINATED */
    broadcastNightResult(peacefulNight, nightDeath, wolfTargetId, guardedTargetId) {
        this.callbacks.broadcast({
            type: 'NIGHT_RESULT',
            peacefulNight,
            deaths: nightDeath ? [{ clientId: nightDeath.clientId, nickname: nightDeath.nickname }] : [],
        });
        if (guardedTargetId) {
            const guardAction = this.state.nightActions.find((a) => a.type === 'GUARD_PROTECT');
            const guard = guardAction ? this.getPlayerByClientId(guardAction.actorClientId) : undefined;
            const gTarget = this.getPlayerByClientId(guardedTargetId);
            if (guard && gTarget) {
                const blocked = wolfTargetId !== null && wolfTargetId === guardedTargetId;
                guard.guardProtects.push({ targetId: gTarget.clientId, day: this.state.day, success: blocked });
                this.callbacks.sendTo(guard.clientId, {
                    type: 'GUARD_RESULT',
                    targetClientId: gTarget.clientId,
                    nickname: gTarget.nickname,
                    blocked,
                });
            }
        }
        if (nightDeath) {
            this.callbacks.broadcast({
                type: 'PLAYER_ELIMINATED',
                clientId: nightDeath.clientId,
                nickname: nightDeath.nickname,
                cause: 'wolf_kill',
            });
        }
    }
    /** 投票結算：票最高者出局（平票 → 無人出局）；broadcast 結果後進 DAY_RESULT 或 GAME_OVER */
    resolveVotes() {
        if (this.state.phase !== 'DAY_VOTING')
            return; // 已提前結算過
        this.stopCountdown();
        // 計票（棄票不計）
        const counts = new Map();
        for (const v of this.state.votes) {
            if (v.targetClientId === null)
                continue;
            counts.set(v.targetClientId, (counts.get(v.targetClientId) ?? 0) + 1);
        }
        let maxCount = 0;
        for (const c of counts.values())
            if (c > maxCount)
                maxCount = c;
        let eliminated = null;
        let tie = false;
        if (maxCount > 0) {
            const leaders = [];
            for (const [id, c] of counts.entries())
                if (c === maxCount)
                    leaders.push(id);
            tie = leaders.length > 1;
            if (!tie) {
                const chosen = leaders[0];
                eliminated = this.getPlayerByClientId(chosen) ?? null;
            }
            // tie → eliminated stays null (無人出局)
        }
        if (eliminated) {
            eliminated.alive = false;
            this.state.deathHistory.push({ clientId: eliminated.clientId, nickname: eliminated.nickname, day: this.state.day, cause: 'vote' });
            this.state.lastVoteDeathClientId = eliminated.clientId;
        }
        this.callbacks.broadcast({
            type: 'VOTE_RESULT',
            votes: Object.fromEntries(counts.entries()),
            eliminatedClientId: eliminated ? eliminated.clientId : null,
            tie,
        });
        if (eliminated) {
            this.callbacks.broadcast({
                type: 'PLAYER_ELIMINATED',
                clientId: eliminated.clientId,
                nickname: eliminated.nickname,
                cause: 'vote',
            });
            // 霊能者得知票死者身分（僅存活時）
            const medium = this.state.players.find((p) => p.role === Role.MEDIUM && p.alive);
            if (medium) {
                this.callbacks.sendTo(medium.clientId, {
                    type: 'MEDIUM_RESULT',
                    targetClientId: eliminated.clientId,
                    nickname: eliminated.nickname,
                    result: seerSeesAs(eliminated.role),
                });
            }
        }
        const winner = this.checkWin();
        this.state.winner = winner;
        if (winner)
            this.transitionTo('GAME_OVER');
        else
            this.transitionTo('DAY_RESULT');
    }
    /** 村勝：存活人狼 == 0；狼勝：存活人狼 ≥ 存活村人陣營（含狂人） */
    checkWin() {
        const aliveWolves = this.getAliveWolves().length;
        const aliveVillagers = this.getAliveVillagers().length;
        if (aliveWolves === 0)
            return Team.VILLAGE;
        if (aliveWolves >= aliveVillagers)
            return Team.WEREWOLF;
        return null;
    }
    getAlivePlayers() {
        return this.state.players.filter((p) => p.alive);
    }
    getAliveWolves() {
        return this.getAlivePlayers().filter((p) => p.role === Role.WEREWOLF);
    }
    getAliveVillagers() {
        return this.getAlivePlayers().filter((p) => p.team === Team.VILLAGE); // 含狂人
    }
    getPlayerByClientId(clientId) {
        return this.state.players.find((p) => p.clientId === clientId);
    }
}
//# sourceMappingURL=game.js.map