/**
 * GameEngine — Phase 0 事件佇列 + I/O 副作用
 *
 * - 佇列：enqueue → drain 同步處理（避免 async 競態）
 * - transition 的 Effect 由 engine 執行：BROADCAST / SAVE / ARM_GATE / DISPATCH_LLM / ENQUEUE
 * - phase 變更立即 flushSave；其餘 SAVE debounce（預設 5s）
 * - gate timer 到期 → enqueue ACTION_TIMEOUT
 */

import type {
  GameState, GameEvent, PlayerSnapshot, PendingGate, Phase,
  LLMDispatcher, ClientRegistry, TransitionResult,
} from './types.js';
import { transition, buildPlayerSnapshot, buildSpectatorSnapshot, buildLobbySnapshot, saveState, createGameState, applyIdleTakeover } from './game-state.js';
import { buildPrompt } from './character-session.js';
import { buildDailyMemory, buildMemoryContent, writeMemory, clearMemory, memoryFilePath, MEMORY_MAX_DAYS } from './memory.js';
import { Role } from './types.js';
import * as fs from 'fs';

// 正典定義已移至 types.ts；此處再匯出以保持舊引用相容
export type { LLMDispatcher, ClientRegistry } from './types.js';

export interface EngineOptions {
  mode: 'gm' | 'web';
  nightTimeoutMs?: number;    // web: 90000, gm: Infinity
  voteTimeoutMs?: number;      // web: 60000
  llm?: LLMDispatcher;
  scheduler?: AIScheduler;    // Phase 1 實作（發言選擇機制）
  registry?: ClientRegistry;  // web 模式需要
  saveDebounceMs?: number;    // 存檔 debounce，預設 5000（測試可調小）
  onGameOver?: (state: GameState) => void;   // 遊戲結束掛鉤（僅觸發一次；server 用來安排回大廳）
  writeMemory?: boolean;      // 私有記憶層：ADVANCE_DAY 沉澝、START_GAME 清空（預設 false，測試可關）
  memoryDir?: string;         // memory 寫入目錄（預設 getDataDir()/character-memory/）
}

export interface AIScheduler {
  onBoardUpdated(state: GameState): void;   // Phase 1：發言選擇機制
  onPhaseEntered(state: GameState): void;
}

function defaultTimeout(mode: 'gm' | 'web', kind: 'night' | 'vote'): number {
  if (mode === 'gm') return Infinity;
  if (kind === 'night') return 90000;
  return 60000;
}

export class GameEngine {
  private state: GameState;
  private readonly options: EngineOptions;
  private readonly queue: GameEvent[] = [];
  private gateTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;

  constructor(options: EngineOptions, initialState?: GameState) {
    this.options = options;
    // 缺口補位：規格未定義 engine 初始狀態來源；未提供時預設 9 人空大廳
    this.state = initialState ?? createGameState(9);
  }

  enqueue(event: GameEvent): void {
    this.queue.push(event);
  }

  /** 同步處理佇列（含級聯 ENQUEUE 的內部事件） */
  drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        this.processEvent(event);
      }
    } finally {
      this.draining = false;
    }
  }

  /** 單一事件處理（transition + effects + phase 變更收尾） */
  handleEvent(event: GameEvent): void {
    this.processEvent(event);
  }

  /** Phase 2：立即處理單一事件並回傳結果（真人操作專用；跳過佇列以保即時性） */
  tryEvent(event: GameEvent): TransitionResult {
    return this.processEvent(event);
  }

  getState(): GameState {
    return this.state;
  }

  /** 立即寫檔（flushSave） */
  save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    saveState(this.state);
  }

  /** 釋放 timer（測試 / 程序結束用） */
  close(): void {
    if (this.gateTimer) {
      clearTimeout(this.gateTimer);
      this.gateTimer = null;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private processEvent(event: GameEvent): TransitionResult {
    const prevPhase = this.state.phase;
    const prevBoardVersion = this.state.boardVersion;
    const prevGameOver = this.state.gameOver;
    // 私有記憶快照：ADVANCE_DAY 的 transition 會清空 nightActions/wolfKillTarget 等，
    // 寫 memory 必須用 pre-transition 內容（當天完整事實）
    const memorySnapshot = this.options.writeMemory && event.type === 'ADVANCE_DAY'
      ? snapshotForMemory(this.state)
      : null;
    const result = transition(this.state, event);
    if (!result.accepted) return result;
    // 私有記憶寫入：ADVANCE_DAY 後為每位玩家沉澝當天記憶（機械式，無 LLM）
    if (memorySnapshot && this.options.writeMemory) {
      try {
        writeDailyMemories(memorySnapshot, this.options.memoryDir);
      } catch { /* 記憶寫入失敗不影響遊戲 */ }
    }
    // 新局清空記憶：START_GAME 重置所有私有記憶（跨局殘留會污染新局）
    if (this.options.writeMemory && event.type === 'START_GAME' && prevPhase === 'SETUP_READY') {
      try {
        for (const p of this.state.players) {
          clearMemory(p.personality, this.options.memoryDir);
        }
      } catch { /* 清空失敗不影響遊戲 */ }
    }
    for (const effect of result.effects) {
      switch (effect.type) {
        case 'BROADCAST':
          this.broadcastSnapshots();
          break;
        case 'SAVE':
          this.scheduleSave();
          break;
        case 'ARM_GATE':
          this.armGate(effect.gate);
          break;
        case 'DISPATCH_LLM':
          void this.dispatchLLM(effect.playerId, effect.kind);
          break;
        case 'ENQUEUE':
          this.queue.push(effect.event);
          break;
        case 'IDLE_TAKEOVER': {
          // 掛機接管鏈：切座位（沿用斷線路徑）＋通知被接管者本人；後續 BROADCAST 快照帶接管標記
          const followups = applyIdleTakeover(this.state, effect.playerId);
          for (const f of followups) {
            if (f.type === 'DISPATCH_LLM') {
              void this.dispatchLLM(f.playerId, f.kind);
            } else if (f.type === 'ENQUEUE') {
              this.queue.push(f.event);
            }
          }
          try {
            this.options.registry?.notifyTakeover?.(effect.playerId, effect.reason);
          } catch { /* 通知失敗不影響接管 */ }
          break;
        }
      }
    }
    // 遊戲結束：通知外部（server）安排回大廳，僅觸發一次
    if (this.state.gameOver && !prevGameOver) {
      this.options.onGameOver?.(this.state);
    }
    // Phase 2：討論中白板更新（boardVersion 變更且 phase 未變）即時通知 scheduler（CD 重置）。
    // phase 進入不通知：由 onPhaseEntered 統一處理，避免 scheduler 以舊/未定 mode 誤啟動生產線
    if (this.state.boardVersion !== prevBoardVersion && this.state.phase === prevPhase && this.options.scheduler) {
      this.options.scheduler.onBoardUpdated(this.state);
    }
    if (this.state.phase !== prevPhase) {
      this.save();
      this.onPhaseEntered(this.state);
    }
    return result;
  }

  /** phase entry 副作用：gate timer、LLM 分派、摘要推進 */
  onPhaseEntered(state: GameState): void {
    // gate 被 transition 消費（pendingGate=null）時，清掉殘留 timer；
    // 新開的 gate（pendingGate 非 null）保留其 timer。
    // 過期 timer 即使觸發，也會被 transition 的 phase 檢查自然丟棄。
    if (!state.pendingGate && this.gateTimer) {
      clearTimeout(this.gateTimer);
      this.gateTimer = null;
    }
    switch (state.phase) {
      case 'DAY_DISCUSSION_OPEN':
      case 'NIGHT_DISCUSSION_OPEN':
        // Phase 0：分派全存活 AI 發言；Phase 1 由 scheduler 決定
        if (this.options.scheduler) {
          this.options.scheduler.onPhaseEntered(state);
        } else if (this.options.llm) {
          if (state.phase === 'DAY_DISCUSSION_OPEN') {
            for (const p of state.players) {
              if (p.alive && p.controlledBy === 'ai') {
                void this.dispatchLLM(p.id, 'speech');
              }
            }
          } else {
            // 狼人密談：只分派存活 AI 狼人
            for (const p of state.players) {
              if (p.alive && p.controlledBy === 'ai' && p.role === Role.WEREWOLF) {
                void this.dispatchLLM(p.id, 'wolf_speech');
              }
            }
          }
        }
        break;
      case 'NIGHT_RESOLVING':
        // 安全網：直接進入結算 phase（例如讀檔恢復）時補推進；重複事件會被 transition 忽略
        this.queue.push({ type: 'RESOLVE_NIGHT' });
        break;
      case 'DAY_VOTING_RESOLVING':
        this.queue.push({ type: 'RESOLVE_VOTES' });
        break;
      case 'DAY_RESULT_ANNOUNCING':
        // 生成 daySummary 在 transition(ADVANCE_DAY)；此處只推進
        this.queue.push({ type: 'ADVANCE_DAY' });
        break;
      default:
        break;
    }
    if (this.options.scheduler && state.phase !== 'DAY_DISCUSSION_OPEN' && state.phase !== 'NIGHT_DISCUSSION_OPEN') {
      this.options.scheduler.onPhaseEntered(state);
    }
  }

  private broadcastSnapshots(): void {
    const registry = this.options.registry;
    if (!registry) return;
    const st = this.state;
    if (st.phase === 'SETUP_WAITING_JOIN' || st.phase === 'SETUP_READY') {
      try { registry.sendLobby?.(buildLobbySnapshot(st)); } catch {
        // 大廳廣播失敗不影響遊戲
      }
      return;
    }
    for (const pid of registry.getConnectedPlayerIds()) {
      try {
        registry.send(pid, buildPlayerSnapshot(this.state, pid));
      } catch {
        // 單一客戶端失敗不影響其他人
      }
    }
    if (registry.hasSpectators?.()) {
      try {
        registry.sendSpectator?.(buildSpectatorSnapshot(this.state));
      } catch {
        // 觀戰廣播失敗不影響遊戲
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    const ms = this.options.saveDebounceMs ?? 5000;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      saveState(this.state);
    }, ms);
    if (typeof (this.saveTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.saveTimer as unknown as { unref: () => void }).unref();
    }
  }

  private timeoutFor(gate: PendingGate): number {
    if (gate.kind === 'night') {
      return this.options.nightTimeoutMs ?? defaultTimeout(this.options.mode, 'night');
    }
    return this.options.voteTimeoutMs ?? defaultTimeout(this.options.mode, 'vote');
  }

  private armGate(gate: PendingGate): void {
    const timeoutMs = this.timeoutFor(gate);
    gate.timeoutMs = timeoutMs;
    if (!Number.isFinite(timeoutMs)) {
      // gm 模式：無 timer，deadline 維持 0（等待真人/CLI 推進）
      this.state.pendingGate = gate;
      return;
    }
    gate.deadline = Date.now() + timeoutMs;
    this.state.pendingGate = gate;
    if (this.gateTimer) clearTimeout(this.gateTimer);
    const gateId = `${gate.kind}-${this.state.day}`;
    this.gateTimer = setTimeout(() => {
      this.gateTimer = null;
      this.enqueue({ type: 'ACTION_TIMEOUT', gateId });
      this.drain();
    }, timeoutMs);
    if (typeof (this.gateTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.gateTimer as unknown as { unref: () => void }).unref();
    }
  }

  private async dispatchLLM(playerId: number, kind: 'speech' | 'vote' | 'night' | 'wolf_speech'): Promise<void> {
    const llm = this.options.llm;
    if (!llm) return;
    const player = this.state.players.find((p) => p.id === playerId);
    if (!player || !player.alive) return;
    // Phase 2：座位已由真人拿回（重連）→ 不再由 AI 代行
    if (player.controlledBy !== 'ai') return;
    // Phase 2：失敗/被拒重試 1 次（AI 回傳無效目標被拒時，避免 gate 空等 timeout）
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const prompt = buildPrompt(this.state, playerId, kind);
        if (kind === 'speech') {
          const captured = this.state.boardVersion;
          const { text } = await llm.requestSpeech(playerId, prompt);
          const result = this.processEvent({ type: 'AI_SPEECH_DONE', playerId, text, boardVersion: captured });
          this.drain();   // processEvent 的 ENQUEUE（如 gate 完成 → 結算）需 drain 才會執行
          if (result.accepted) return;
        } else if (kind === 'wolf_speech') {
          // 狼人密談：沿用 speech 請求，事件走 AI_WOLF_SPEECH_DONE
          const captured = this.state.boardVersion;
          const { text } = await llm.requestSpeech(playerId, prompt);
          const result = this.processEvent({ type: 'AI_WOLF_SPEECH_DONE', playerId, text, boardVersion: captured });
          this.drain();
          if (result.accepted) return;
        } else if (kind === 'vote') {
          const { targetId } = await llm.requestVote(playerId, prompt);
          const result = this.processEvent({ type: 'AI_VOTE_DONE', playerId, targetId });
          this.drain();
          if (result.accepted) return;
        } else {
          const { targetId } = await llm.requestNightAction(playerId, prompt);
          const result = this.processEvent({ type: 'AI_NIGHT_DONE', playerId, targetId });
          this.drain();
          if (result.accepted) return;
        }
      } catch { /* 重試 1 次 */ }
      // 被拒 → 重試前檢查座位仍由 AI 控制
      const cur = this.state.players.find((p) => p.id === playerId);
      if (!cur || !cur.alive || cur.controlledBy !== 'ai') return;
    }
    // 兩次皆失敗/被拒 → 該行動放棄（gate 由他人完成或 timeout 推進）
    // 補推進：processEvent 的 ENQUEUE（如 gate 完成）需 drain 才會執行
    this.drain();
  }

  /** 供測試：目前排隊事件數 */
  pendingCount(): number {
    return this.queue.length;
  }

  /** 供測試：目前 phase */
  currentPhase(): Phase {
    return this.state.phase;
  }
}

// ============================================
// 私有記憶層 helpers（writeMemory 開啟時用）
// ============================================

/**
 * ADVANCE_DAY pre-transition 快照：深拷貝當天完整事實
 * （transition 會清空 nightActions / wolfKillTarget / wolfDiscussionLog / votes 等）
 */
function snapshotForMemory(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

/** 為每位玩家寫入當天記當天記憶：讀現有 memory → 追加當天段 → 保留最近 MEMORY_MAX_DAYS 天 */
function writeDailyMemories(snapshot: GameState, memoryDir?: string): void {
  const day = snapshot.day;
  for (const p of snapshot.players) {
    const existing = readMemoryText(p.personality, memoryDir);
    // 解析既有天數段，追加當天後重建（冪等：同天重寫覆蓫舊段）
    const sections = parseMemorySections(existing);
    const todaySection = buildDailyMemory(snapshot, p.id, day);
    if (!todaySection) continue;
    sections.set(String(day), todaySection);
    const days = [...sections.keys()].sort((a, b) => Number(a) - Number(b));
    const kept = days.slice(-MEMORY_MAX_DAYS).map(Number);
    const content = buildMemoryContent(snapshot, p.id, kept);
    writeMemory(p.personality, content, memoryDir);
  }
}

/** 讀取現有 memory 文字（不 fallback resource root：運行期記憶只認 dataDir） */
function readMemoryText(personaId: string, memoryDir?: string): string {
  try {
    const file = memoryFilePath(personaId, memoryDir);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8');
  } catch { /* 無檔 */ }
  return '';
}

/** 解析 memory 內容的「第N天：」段落 → Map(day, section) */
function parseMemorySections(content: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!content) return map;
  const re = /第(\d+)天：\n([\s\S]*?)(?=\n\n第\d+天：|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    map.set(m[1], `第${m[1]}天：\n${m[2]}`);
  }
  return map;
}
