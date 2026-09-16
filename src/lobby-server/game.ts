/**
 * game.ts — 單一房間的遊戲引擎（ubuntu 分支 M5）
 *
 * 簡化 phase 狀態機：phase timer + 直接 state mutation（不用 event queue，見規格 §12.10）。
 *
 * 流程：ROLE_REVEAL(10s) → NIGHT(60s) → NIGHT_RESULT(10s) → DAY_DISCUSSION(120s)
 *       → DAY_VOTING(60s) → DAY_RESULT(10s) →（勝利判定）→ 下一夜... → GAME_OVER
 *
 * 規則（規格 §12）：
 * - 人狼不可殺狂人；狼刀目標取多數決（平票 → 先提交者）
 * - 守衛 Day1 不可行動；不可自護（自護 → 隨機改護他人）
 * - 占い師不可查自己
 * - 霊能者只在黎明得知「昨日」被票死者身分（夜殺不可知）
 * - 夜殺／票死：身分不公開
 * - 村勝：人狼全滅；狼勝：存活人狼數 ≥ 存活村人陣營數
 * - 所有活躍玩家皆已提交（夜間行動／投票）→ 提前結算，不等 timeout
 */
import { Role, Team, SeerResult, ROLE_CONFIG, ROLE_TEAM, getDisplayName, getDescription, seerSeesAs } from '../types.js';
import { MAX_MESSAGE_LEN } from './types.js';

export type GamePhase =
  | 'ROLE_REVEAL'
  | 'NIGHT'
  | 'NIGHT_RESULT'
  | 'DAY_DISCUSSION'
  | 'DAY_VOTING'
  | 'DAY_RESULT'
  | 'GAME_OVER';

export interface GamePlayer {
  clientId: string;
  nickname: string;
  role: Role;
  team: Team;
  alive: boolean;
  isMasonPartner: boolean;
  masonPartnerId?: string; // 夥伴的 clientId
  wolfPartnerIds: string[]; // 其他人狼的 clientIds（非人狼為空）
  seerChecks: { targetId: string; result: SeerResult; day: number }[];
  guardProtects: { targetId: string; day: number; success: boolean }[];
}

export interface NightAction {
  actorClientId: string;
  type: 'WOLF_KILL' | 'SEER_CHECK' | 'GUARD_PROTECT';
  targetClientId: string;
}

export interface Vote {
  voterClientId: string;
  targetClientId: string | null; // null = 棄票
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
}

export class GameEngine {
  private state: GameState;
  private timers: NodeJS.Timeout[] = [];
  private countdownInterval?: NodeJS.Timeout;

  constructor(
    private roomCode: string,
    private players: { clientId: string; nickname: string }[],
    private callbacks: GameCallbacks,
  ) {
    this.state = {
      phase: 'ROLE_REVEAL',
      day: 1,
      players: [],
      nightActions: [],
      votes: [],
      deathHistory: [],
      winner: null,
      lastVoteDeathClientId: null,
    };
  }

  /** 開始遊戲：分配角色、私發 ROLE_REVEALED、進入 phase 循環 */
  start(): void {
    this.assignRoles();
    for (const p of this.state.players) {
      const partners: string[] = [];
      if (p.role === Role.WEREWOLF) {
        for (const id of p.wolfPartnerIds) {
          const w = this.getPlayerByClientId(id);
          if (w) partners.push(w.nickname);
        }
      } else if (p.role === Role.MASON && p.masonPartnerId) {
        const m = this.getPlayerByClientId(p.masonPartnerId);
        if (m) partners.push(m.nickname);
      }
      this.callbacks.sendTo(p.clientId, {
        type: 'ROLE_REVEALED',
        role: p.role,
        displayName: getDisplayName(p.role),
        description: getDescription(p.role),
        partners,
      });
    }
    this.transitionTo('ROLE_REVEAL');
  }

  /** 處理夜間行動提交 */
  handleNightAction(clientId: string, action: { type: 'WOLF_KILL' | 'SEER_CHECK' | 'GUARD_PROTECT'; targetClientId: string }): void {
    if (this.state.phase !== 'NIGHT') return;
    const player = this.getPlayerByClientId(clientId);
    if (!player || !player.alive) return;
    // 行動類型必須符合角色
    if (action.type === 'WOLF_KILL' && player.role !== Role.WEREWOLF) return;
    if (action.type === 'SEER_CHECK' && player.role !== Role.SEER) return;
    if (action.type === 'GUARD_PROTECT' && player.role !== Role.GUARD) return;
    // 守衛 Day1 不可行動
    if (action.type === 'GUARD_PROTECT' && this.state.day === 1) return;
    // 目標驗證：不可是自己、目標必須存在且存活；人狼不可選狂人
    if (action.targetClientId === clientId) return;
    const target = this.getPlayerByClientId(action.targetClientId);
    if (!target || !target.alive) return;
    if (action.type === 'WOLF_KILL' && target.role === Role.MADMAN) return;

    // 存入（同一玩家同類型重新提交 → 覆蓋舊行動）
    const entry: NightAction = { actorClientId: clientId, type: action.type, targetClientId: action.targetClientId };
    const idx = this.state.nightActions.findIndex((a) => a.actorClientId === clientId && a.type === action.type);
    if (idx >= 0) this.state.nightActions[idx] = entry;
    else this.state.nightActions.push(entry);

    // 所有活躍玩家皆已行動 → 提前結算（不等完整 timeout）
    if (this.allNightActionsSubmitted()) this.resolveNight();
  }

  /** 處理投票（targetClientId = null → 棄票） */
  handleVote(clientId: string, targetClientId: string | null): void {
    if (this.state.phase !== 'DAY_VOTING') return;
    const player = this.getPlayerByClientId(clientId);
    if (!player || !player.alive) return;
    if (targetClientId !== null) {
      if (targetClientId === clientId) return; // 不可投自己
      const target = this.getPlayerByClientId(targetClientId);
      if (!target || !target.alive) return;
    }
    const idx = this.state.votes.findIndex((v) => v.voterClientId === clientId);
    if (idx >= 0) this.state.votes[idx] = { voterClientId: clientId, targetClientId };
    else this.state.votes.push({ voterClientId: clientId, targetClientId });

    // 所有存活玩家皆已投票（含棄票）→ 提前結算
    if (this.getAlivePlayers().every((p) => this.state.votes.some((v) => v.voterClientId === p.clientId))) {
      this.resolveVotes();
    }
  }

  /** 房主提前結束討論 */
  handleEndDiscussion(clientId: string): void {
    if (this.state.phase !== 'DAY_DISCUSSION') return;
    const hostId = this.callbacks.getHostClientId?.();
    if (hostId !== undefined && hostId !== clientId) return; // 只有房主可提前結束
    this.transitionTo('DAY_VOTING');
  }

  /** 人狼私頻（僅存活人狼可見） */
  handleWolfChat(clientId: string, text: string): void {
    if (this.state.phase === 'GAME_OVER') return;
    const player = this.getPlayerByClientId(clientId);
    if (!player || player.role !== Role.WEREWOLF || !player.alive) return;
    const clean = text.trim();
    if (clean.length === 0 || clean.length > MAX_MESSAGE_LEN) return;
    this.callbacks.broadcast(
      { type: 'WOLF_MESSAGE', from: player.nickname, text: clean, ts: Date.now() },
      this.getAliveWolves().map((p) => p.clientId),
    );
  }

  /** 共有者私頻（僅雙方可見） */
  handleMasonChat(clientId: string, text: string): void {
    if (this.state.phase === 'GAME_OVER') return;
    const player = this.getPlayerByClientId(clientId);
    if (!player || player.role !== Role.MASON || !player.alive) return;
    const clean = text.trim();
    if (clean.length === 0 || clean.length > MAX_MESSAGE_LEN) return;
    const targets = [player.clientId];
    if (player.masonPartnerId) targets.push(player.masonPartnerId);
    this.callbacks.broadcast(
      { type: 'MASON_MESSAGE', from: player.nickname, text: clean, ts: Date.now() },
      targets,
    );
  }

  /** 清除所有 timer（房間回收時呼叫，避免孤兒 timer 讓 process 無法結束） */
  destroy(): void {
    this.stopCountdown();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  // --- Private methods ---

  private assignRoles(): void {
    const count = this.players.length;
    const config = ROLE_CONFIG[count] ?? ROLE_CONFIG[Math.min(15, Math.max(6, count))];
    const roles: Role[] = [];
    for (const [role, n] of Object.entries(config)) {
      for (let i = 0; i < (n ?? 0); i++) roles.push(role as Role);
    }
    // 防禦：實際人數與表不符時（lobby 保證 6–15）以村民補足／移除村民
    while (roles.length < count) roles.push(Role.VILLAGER);
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
      if (partner) m.masonPartnerId = partner.clientId;
    }
  }

  private transitionTo(phase: GamePhase): void {
    this.state.phase = phase;
    this.callbacks.broadcast({ type: 'PHASE_CHANGED', phase, day: this.state.day });
    switch (phase) {
      case 'ROLE_REVEAL':
        this.schedule(() => this.transitionTo('NIGHT'), 10_000);
        break;
      case 'NIGHT':
        this.state.nightActions = [];
        this.startCountdown(60);
        this.schedule(() => this.resolveNight(), 60_000);
        break;
      case 'NIGHT_RESULT':
        // 結果 phase 固定 10 秒；勝利判定已在 resolveNight 完成（state.winner 已設定）
        this.schedule(() => {
          if (this.state.winner) this.transitionTo('GAME_OVER');
          else this.transitionTo('DAY_DISCUSSION');
        }, 10_000);
        break;
      case 'DAY_DISCUSSION':
        this.startCountdown(120);
        this.schedule(() => this.transitionTo('DAY_VOTING'), 120_000);
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
          if (this.state.winner) this.transitionTo('GAME_OVER');
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
  private schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers = this.timers.filter((x) => x !== t);
      fn();
    }, ms);
    this.timers.push(t);
  }

  /** 倒數提醒：剩餘 <30s 時每 10s 發一次 PHASE_COUNTDOWN（60s phase → 20s、10s） */
  private startCountdown(seconds: number): void {
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

  private stopCountdown(): void {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = undefined;
    }
  }

  /** 角色對應的夜間行動類型（null = 該玩家本夜無主動行動） */
  private actionTypeFor(p: GamePlayer): 'WOLF_KILL' | 'SEER_CHECK' | 'GUARD_PROTECT' | null {
    if (p.role === Role.WEREWOLF) return 'WOLF_KILL';
    if (p.role === Role.SEER) return 'SEER_CHECK';
    if (p.role === Role.GUARD && this.state.day > 1) return 'GUARD_PROTECT';
    return null;
  }

  /** 活躍夜間玩家 = 存活人狼 + 存活占い師 + 存活守衛（Day2 起） */
  private getNightActivePlayers(): GamePlayer[] {
    return this.getAlivePlayers().filter((p) => this.actionTypeFor(p) !== null);
  }

  private allNightActionsSubmitted(): boolean {
    const active = this.getNightActivePlayers();
    if (active.length === 0) return false;
    return active.every((p) => {
      const t = this.actionTypeFor(p);
      return t !== null && this.state.nightActions.some((a) => a.actorClientId === p.clientId && a.type === t);
    });
  }

  /** 夜間結算：守衛 → 人狼 → 占い師 → 霊能者（黎明）；broadcast 結果後進 NIGHT_RESULT 或 GAME_OVER */
  private resolveNight(): void {
    if (this.state.phase !== 'NIGHT') return; // 已提前結算過
    this.stopCountdown();

    // 1) 守衛：記錄護衛目標（自護 → 隨機改護他人，防禦性處理）
    const guardAction = this.state.nightActions.find((a) => a.type === 'GUARD_PROTECT');
    const guard = guardAction ? this.getPlayerByClientId(guardAction.actorClientId) : undefined;
    let guardedTargetId: string | null = null;
    if (guardAction && guard) {
      guardedTargetId = guardAction.targetClientId;
      if (guardedTargetId === guard.clientId) {
        const others = this.getAlivePlayers().filter((p) => p.clientId !== guard.clientId);
        if (others.length > 0) guardedTargetId = others[Math.floor(Math.random() * others.length)].clientId;
      }
    }

    // 2) 人狼：多數決（平票 → 先提交者）；目標 == 護衛目標 → 平安夜
    const wolfActions = this.state.nightActions.filter((a) => a.type === 'WOLF_KILL');
    const wolfCounts = new Map<string, number>();
    for (const a of wolfActions) wolfCounts.set(a.targetClientId, (wolfCounts.get(a.targetClientId) ?? 0) + 1);
    let wolfTargetId: string | null = null;
    let wolfMax = 0;
    for (const a of wolfActions) {
      const c = wolfCounts.get(a.targetClientId) ?? 0;
      if (c > wolfMax) {
        wolfMax = c;
        wolfTargetId = a.targetClientId;
      }
    }
    const peacefulNight = wolfTargetId === null || wolfTargetId === guardedTargetId;
    let nightDeath: GamePlayer | null = null;
    if (!peacefulNight && wolfTargetId) {
      const target = this.getPlayerByClientId(wolfTargetId);
      if (target) {
        target.alive = false;
        nightDeath = target;
        this.state.deathHistory.push({ clientId: target.clientId, nickname: target.nickname, day: this.state.day, cause: 'wolf_kill' });
      }
    }

    // 3) 占い師：查驗結果記錄並只發給占い師
    const seerAction = this.state.nightActions.find((a) => a.type === 'SEER_CHECK');
    const seer = seerAction ? this.getPlayerByClientId(seerAction.actorClientId) : undefined;
    const seerTarget = seerAction ? this.getPlayerByClientId(seerAction.targetClientId) : undefined;
    if (seerAction && seer && seerTarget) {
      seer.seerChecks.push({ targetId: seerTarget.clientId, result: seerSeesAs(seerTarget.role), day: this.state.day });
    }

    // 4) 黎明：霊能者得知昨日被票死者身分（Day1 無）
    const medium = this.state.players.find((p) => p.role === Role.MEDIUM && p.alive);
    const mediumTarget =
      this.state.day > 1 && this.state.lastVoteDeathClientId
        ? (this.getPlayerByClientId(this.state.lastVoteDeathClientId) ?? null)
        : null;

    // 5) 廣播夜間結果
    this.callbacks.broadcast({
      type: 'NIGHT_RESULT',
      peacefulNight,
      deaths: nightDeath ? [{ clientId: nightDeath.clientId, nickname: nightDeath.nickname }] : [],
    });
    if (seerAction && seer && seerTarget) {
      this.callbacks.sendTo(seer.clientId, {
        type: 'SEER_RESULT',
        targetClientId: seerTarget.clientId,
        nickname: seerTarget.nickname,
        result: seerSeesAs(seerTarget.role),
      });
    }
    if (guardAction && guard && guardedTargetId) {
      const gTarget = this.getPlayerByClientId(guardedTargetId);
      if (gTarget) {
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
    if (medium && mediumTarget) {
      this.callbacks.sendTo(medium.clientId, {
        type: 'MEDIUM_RESULT',
        targetClientId: mediumTarget.clientId,
        nickname: mediumTarget.nickname,
        result: seerSeesAs(mediumTarget.role),
      });
    }
    if (nightDeath) {
      this.callbacks.broadcast({
        type: 'PLAYER_ELIMINATED',
        clientId: nightDeath.clientId,
        nickname: nightDeath.nickname,
        cause: 'wolf_kill',
      });
    }

    // 6) 勝利判定
    const winner = this.checkWin();
    this.state.winner = winner;
    if (winner) this.transitionTo('GAME_OVER');
    else this.transitionTo('NIGHT_RESULT');
  }

  /** 投票結算：票最高者出局（平票 → 隨機）；broadcast 結果後進 DAY_RESULT 或 GAME_OVER */
  private resolveVotes(): void {
    if (this.state.phase !== 'DAY_VOTING') return; // 已提前結算過
    this.stopCountdown();

    // 計票（棄票不計）
    const counts = new Map<string, number>();
    for (const v of this.state.votes) {
      if (v.targetClientId === null) continue;
      counts.set(v.targetClientId, (counts.get(v.targetClientId) ?? 0) + 1);
    }
    let maxCount = 0;
    for (const c of counts.values()) if (c > maxCount) maxCount = c;
    let eliminated: GamePlayer | null = null;
    let tie = false;
    if (maxCount > 0) {
      const leaders: string[] = [];
      for (const [id, c] of counts.entries()) if (c === maxCount) leaders.push(id);
      tie = leaders.length > 1;
      const chosen = leaders[Math.floor(Math.random() * leaders.length)];
      eliminated = this.getPlayerByClientId(chosen) ?? null;
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
    if (winner) this.transitionTo('GAME_OVER');
    else this.transitionTo('DAY_RESULT');
  }

  /** 村勝：存活人狼 == 0；狼勝：存活人狼 ≥ 存活村人陣營（含狂人） */
  private checkWin(): Team | null {
    const aliveWolves = this.getAliveWolves().length;
    const aliveVillagers = this.getAliveVillagers().length;
    if (aliveWolves === 0) return Team.VILLAGE;
    if (aliveWolves >= aliveVillagers) return Team.WEREWOLF;
    return null;
  }

  private getAlivePlayers(): GamePlayer[] {
    return this.state.players.filter((p) => p.alive);
  }

  private getAliveWolves(): GamePlayer[] {
    return this.getAlivePlayers().filter((p) => p.role === Role.WEREWOLF);
  }

  private getAliveVillagers(): GamePlayer[] {
    return this.getAlivePlayers().filter((p) => p.team === Team.VILLAGE); // 含狂人
  }

  private getPlayerByClientId(clientId: string): GamePlayer | undefined {
    return this.state.players.find((p) => p.clientId === clientId);
  }
}
