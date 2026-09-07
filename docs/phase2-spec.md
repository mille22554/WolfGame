# Phase 2 真人加入多人對戰：詳細實作規格

> 本文件是 Phase 2（部分 AI + 部分真人混合對戰）的完整實作規格，fixer 可直接照做。
> 前置：Phase 0（commit 481f831）+ Phase 1（commit 2250455、88a88b1）已完成。
> Phase 1 附錄 B 已預留：ClientRegistry.send / getConnectedPlayerIds、前端 #controls 區塊、HUMAN_* 事件。
> 若實作中發現規格矛盾或遺漏，記錄問題回報，不要自行發明解法。

---

## 0. 目標與完成定義

### 0.1 目標

在 Phase 1 單機 Web 全 AI 之上，加入真人玩家：

1. **真人連線**：WebSocket 連線 → 選座位（P 編號）→ 等待遊戲開始；斷線 → AI 臨時接管，重連可拿回
2. **真人操作**：即時發言（無 CD）、跳過發言、準備投票、投票（點卡片 + P 編號備援）、夜間行動、狼人會議
3. **討論規則**：連續流無輪次；真人發言即時；AI 受 60s CD + 20s 安靜門檻；全真人跳過 → CD 解除；全真人準備投票 → 進投票
4. **身分扁平化**：AI prompt 與白板絕不透露誰是真人；所有玩家只是 P 編號
5. **混合局**：AI 數量 = playerCount − 真人數量；夜晚/投票/狼人會議皆混合收集

### 0.2 完成定義

Phase 2 完成的定義（全部滿足）：

1. `npm test` 全綠（既有 8 檔 + 新增 6 檔，共 14 檔）
2. `npm start` → 瀏覽器顯示大廳（座位選擇）→ 真人選座 → [開始遊戲] → 混合局跑完，真人發言/跳過/準備投票/投票/夜間行動全程可用
3. 斷線重連驗證：真人斷線 → AI 接管 → 重連 → 拿回身分（含 gate 內行動續作）
4. 狼人會議驗證：真人狼 + AI 狼混合 → 全部提交 → 多數決決定目標
5. 身分扁平化驗證：GM 檢視以外，任何 snapshot / AI prompt 不含 `controlledBy`；白板無身分標記
6. 無真人加入時：`LOBBY_TIMEOUT_MS` 後自動全 AI 開局（Phase 1 行為保留）

---

## 1. 設計總覽與關鍵決策

### 1.1 大廳流程（已確認）

```
server 啟動（模型就緒後）
  → createGameState(playerCount)（空大廳，SETUP_WAITING_JOIN）
  → 啟動 LOBBY_TIMEOUT_MS（預設 10s）timer
  → 瀏覽器開 / → 顯示大廳（座位 1..N）

真人連線 → 收到 LOBBY → 點座位 → 送 JOIN { playerId, name }
  → 伺服器 enqueue HUMAN_JOIN → 座位變真人 → 回 JOINED { playerId, token }
  → 取消 LOBBY_TIMEOUT timer（有人類了，改等人按開始）

[開始遊戲]（任一真人）或 LOBBY_TIMEOUT 到期（無真人）
  → 伺服器對每個空位 enqueue AI_JOIN → enqueue START_GAME → drain
  → 遊戲開始（NIGHT_COLLECTING）
```

- **座位保留**：真人選座後，該座位由 token 保留。遊戲開始後斷線 → 座位仍保留（AI 臨時接管）；大廳階段斷線 → 座位釋放（可被他人選走）。
- **開始條件**：只有兩種——真人按 [開始遊戲]，或 LOBBY_TIMEOUT 到期且無真人。**不會**因座位全滿自動開始（符合「等待遊戲開始」）。

### 1.2 身分扁平化（核心原則）

- AI prompt（buildPrompt / buildPreSpeechPrompt / buildJudgePrompt / buildExpandPrompt）**已**不洩漏 controlledBy（Phase 0/1 已驗證），Phase 2 不得引入任何新洩漏點。
- 新增洩漏風險點與防護：
  - **狼人會議 UI 資料**（`you.wolfMeeting`）：只放進狼的 `you`，且內容只有 `{ wolfId, targetId }`，無 controlledBy。
  - **大廳 LOBBY snapshot**：含 `controlledBy`（'ai' | 'human' | 'empty'）——**允許**，因為大廳是遊戲前 UI，AI 永不看到大廳。
  - **斷線接管**：真人斷線 → `controlledBy` 翻轉為 'ai'，AI prompt 與其他 AI 座位完全一致，無「接管」字樣。
- 白板（discussionLog / votes / deathHistory / nightResult）一律只有 P 編號，無身分標記。

### 1.3 討論階段規則（已確認設計 → 實作對照）

| 規則 | 實作 |
|---|---|
| 連續流無輪次 | 沿用（無 turn 概念） |
| 真人發言即時無 CD | HUMAN_SPEAK 立即 accepted（沿用）；engine 對 boardVersion 變更即時通知 scheduler |
| AI 受 60s CD + 20s 安靜門檻 | 沿用 SpeechScheduler（cdMs=60000, quietMs=20000） |
| 白板更新 → AI 重讀重想 | 沿用 boardVersion 機制 |
| 真人按鈕 [發言][跳過發言][準備投票] | 前端 controls 區塊（§9） |
| 全真人跳過 → CD 解除 → AI 發言 | scheduler tick 偵測 `allAliveHumansSkipped` → 立即跑管線；broadcastAfterCd 跳過 sleep（§7） |
| 全真人準備投票 → 進投票 | HUMAN_READY_VOTE 在 OPEN 也接受；全 ready → DAY_VOTING_COLLECTING + 開 vote gate（§4） |
| CD 被真人發言重置 | engine 在 boardVersion 變更時呼叫 `scheduler.onBoardUpdated`（§6） |
| 跳過是真人專屬 | HUMAN_SKIP 只由真人 client 送出（registry 路由）；AI 無此事件 |

### 1.4 狼人會議（已確認設計）

- `getNightActors` 改為：seer（存活）+ guard（存活且 day>1）+ **全部存活狼**（不再只有第一隻狼）。
- 每隻狼（真人或 AI）提交一個 WOLF_KILL 目標 → 全部提交（gate 完成）→ 結算時多數決。
- 多數決演算法在 **night.ts**（夜晚結算唯一來源不變）：同目標票數最高者勝；平手 → 先提交者勝。
- 真人狼的 UI 顯示目前提交（`you.wolfMeeting`），可重複提交（覆蓋前次，gate.done 不重複加）。

### 1.5 斷線接管 / 重連

- 斷線 → `DISCONNECT { playerId }`：
  - 遊戲中：`controlledBy` → 'ai'；移出 voteReady / skippedHumans；若在 night/vote gate 且未完成 → 補派 DISPATCH_LLM（AI 接手行動）。
  - 大廳（SETUP）：移除該玩家（座位釋放）。
- 重連 → `RECONNECT { playerId }`：存活 → `controlledBy` → 'human'；死亡 → 拒絕（client 變觀戰者，仍回 JOINED 讓其知道身分）。
- token 機制：`SeatManager`（server.ts 內）維護 `playerId ↔ token` 雙向映射；client 存 localStorage，重連時送 RECONNECT。

---

## 2. 檔案地圖

| 檔案 | 動作 | 說明 |
|---|---|---|
| src/types.ts | 擴充 | SCHEMA_VERSION=3、3 個新事件、GameState.skippedHumans、PlayerSnapshot 擴充、LobbySnapshot、WS 協定擴充 |
| src/game-state.ts | 擴充 | HUMAN_JOIN / AI_JOIN / DISCONNECT / RECONNECT 轉移、skip 追蹤、READY_VOTE in OPEN、getNightActors 全狼、snapshot 擴充、buildLobbySnapshot、allAliveHumansSkipped |
| src/night.ts | 小改 | 狼人會議多數決（取代 wolfActions[0]） |
| src/engine.ts | 小改 | processEvent 回傳 TransitionResult；boardVersion 變更 → scheduler.onBoardUpdated；dispatchLLM 失敗重試 1 次；broadcastSnapshots 支援 LOBBY；新增 tryEvent |
| src/ai-scheduler.ts | 小改 | tick 偵測全真人跳過 → 立即管線；broadcastAfterCd 跳過 CD |
| src/server.ts | 擴充 | SeatManager（token）、registry 玩家路由、大廳流程、auto-close 條件、LOBBY 廣播 |
| public/index.html | 擴充 | 大廳 overlay、操作面板、玩家卡片、身分顯示 |
| public/js/main.js | 重寫 | 大廳/玩家/觀戰三模式、操作面板、重連 |
| public/css/style.css | 擴充 | 卡片、按鈕、大廳格線樣式 |
| src/human-lobby.test.ts 等 6 檔 | 新增 | 測試（見 §10） |

**不動**：worker.ts、worker-dispatcher.ts、novelty.ts、llm.ts、gm.ts、driver.mjs、assignment.ts（assignRolesToPlayers 不變）、ai.ts、day.ts、character-session.ts（prompt 已扁平化，不需改）、personalities.ts

---

## 3. types.ts 擴充

### 3.1 SCHEMA_VERSION

```typescript
export const SCHEMA_VERSION = 3;   // v2 → v3：新增 skippedHumans；舊存檔 loadState 回傳 null（重新開始）
```

### 3.2 GameEvent 新增 3 事件（union 共 22）

```typescript
export type GameEvent =
  | /* 既有 19 個（不變） */
  | { type: 'HUMAN_JOIN'; playerId: number; name?: string }   // 真人選座（大廳）
  | { type: 'AI_JOIN'; playerId: number }                      // 伺服器填 AI 空位（大廳）
  | { type: 'RECONNECT'; playerId: number };                   // 真人重連拿回身分
```

### 3.3 GameState 新增欄位

```typescript
export interface GameState {
  /* 既有欄位（不變） */
  skippedHumans: number[];   // 當天已跳過發言的真人 playerId（全跳過 → AI 立即發言）
}
```

- 初始化：`createGameState` 設 `skippedHumans: []`。
- 重置時機：START_GAME、ADVANCE_DAY（與 voteReady 一起清空）、AI_SPEECH_DONE 被接受（清空）、HUMAN_SPEAK 被接受（僅移除發言者）。

### 3.4 PlayerSnapshot 擴充

```typescript
export interface PlayerSnapshot {
  /* 既有欄位（不變） */
  gateDeadline: number | null;   // pendingGate?.deadline ?? null（0 = 無 timer；前端倒數用）
  you: {
    /* 既有欄位（不變） */
    canAct?: boolean;            // 目前是否輪到我行動：pendingGate 存在 && required 含我 && done 不含我
    wolfMeeting?: { wolfId: number; targetId: number }[];   // 狼人會議目前提交（僅狼；由 nightActions 推導）
  };
}
```

### 3.5 LobbySnapshot（新增）

```typescript
export interface LobbySnapshot {
  phase: Phase;
  expectedPlayerCount: number;
  seats: { playerId: number; name: string; controlledBy: 'ai' | 'human' | 'empty' }[];
  started: boolean;   // phase 非 SETUP_* 即 true
}
```

### 3.6 ClientRegistry 擴充（optional 保持相容）

```typescript
export interface ClientRegistry {
  getConnectedPlayerIds(): number[];
  send(playerId: number, snapshot: PlayerSnapshot): void;
  sendSpectator?(snapshot: SpectatorSnapshot): void;
  hasSpectators?(): boolean;
  /** Phase 2 新增（optional）：大廳廣播（SETUP 階段取代 snapshot 廣播） */
  sendLobby?(lobby: LobbySnapshot): void;
}
```

### 3.7 前端 WS 協定擴充

```typescript
export type ServerToClientMessage =
  | { type: 'SNAPSHOT'; snapshot: PlayerSnapshot | SpectatorSnapshot | GMSnapshot; gmView: boolean }
  | { type: 'LOBBY'; lobby: LobbySnapshot }
  | { type: 'JOINED'; playerId: number; token: string }
  | { type: 'JOIN_REJECTED'; reason: string }
  | { type: 'ACTION_REJECTED'; reason: string }
  | { type: 'MODEL_STATUS'; state: 'downloading' | 'ready' | 'error'; downloaded?: number; total?: number; error?: string }
  | { type: 'PING' }
  | { type: 'SHUTDOWN' };

export type ClientToServerMessage =
  | { type: 'PONG' }
  | { type: 'REQUEST_SNAPSHOT' }
  | { type: 'SET_GM_VIEW'; enabled: boolean }
  | { type: 'LEAVE' }
  | { type: 'JOIN'; playerId: number; name?: string }
  | { type: 'RECONNECT'; token: string }
  | { type: 'START_GAME' }
  | { type: 'HUMAN_SPEAK'; text: string }
  | { type: 'HUMAN_SKIP' }
  | { type: 'HUMAN_READY_VOTE' }
  | { type: 'HUMAN_UNREADY_VOTE' }
  | { type: 'HUMAN_VOTE'; targetId: number }
  | { type: 'HUMAN_NIGHT_ACTION'; targetId: number };
```

- 真人操作訊息**不含 playerId**：伺服器由連線的 `client.playerId` 補上（registry 路由，§8）。
- `SNAPSHOT` 的判別：`snapshot.you` 存在 → PlayerSnapshot（玩家）；否則 Spectator/GM。

---

## 4. game-state.ts 擴充

### 4.1 新輔助函式

```typescript
/** 建立指定座位的玩家（大廳用；players 陣列依 id 排序、保持稠密） */
function makeSeatPlayer(state: GameState, playerId: number, name: string, controlledBy: 'ai' | 'human'): Player;

/** 座位是否已被佔（存在玩家） */
function seatOccupied(state: GameState, playerId: number): boolean;

/** 全存活真人皆已跳過發言（無真人 → false） */
export function allAliveHumansSkipped(state: GameState): boolean;

/** 大廳 snapshot */
export function buildLobbySnapshot(state: GameState): LobbySnapshot;
```

`makeSeatPlayer` 演算法：
```
id = playerId
name = name || `P${playerId}`
role = VILLAGER（佔位，START_GAME 時重分配）
team = VILLAGE
controlledBy = 參數
personality = personalities[(playerId-1) % personalities.length].id
alive = true, isMasonPartner = false, seerChecks = [], guardProtects = []
插入位置：players 依 id 升序插入（splice 或 push 後排序）
```

`allAliveHumansSkipped` 演算法：
```
humans = getAlivePlayers(state.players).filter(p => p.controlledBy === 'human')
return humans.length > 0 && humans.every(h => state.skippedHumans.includes(h.id))
```

`buildLobbySnapshot` 演算法：
```
seats = for id in 1..expectedPlayerCount:
  p = players.find(p => p.id === id)
  p ? { playerId: id, name: p.name, controlledBy: p.controlledBy }
    : { playerId: id, name: '', controlledBy: 'empty' }
started = phase 不是 SETUP_WAITING_JOIN 也不是 SETUP_READY
```

### 4.2 getNightActors 修改

```typescript
export function getNightActors(state: GameState): number[] {
  // seer（存活）+ guard（存活且 day > 1）+ 全部存活狼（狼人會議）
}
```

### 4.3 recordNightAction 新增驗證

```typescript
function recordNightAction(state, playerId, targetId): TransitionResult | null {
  /* 既有驗證（actor 存活、role 有夜間行動、target 存活） */
  if (targetId === playerId) {
    return { state, effects: [], accepted: false, reason: `P${playerId} 不可指定自己` };
  }
  /* 其餘沿用：覆蓋舊行動 + markGateDone */
}
```

### 4.4 轉移表新增/修改（全事件 × 全 phase）

#### SETUP_WAITING_JOIN（新增）

| 事件 | 行為 |
|---|---|
| HUMAN_JOIN | 驗證 `1 ≤ playerId ≤ expectedPlayerCount`；座位已被真人佔 → 拒絕 'seat taken'；**先填補座位 1..playerId-1 的空位為 AI**（makeSeatPlayer 'ai'）；座位已被 AI 佔 → 轉換為真人（name 更新）；空位 → 建立真人；players.length ≥ expected → SETUP_READY；effects: BROADCAST + SAVE |
| AI_JOIN | 驗證範圍；座位已佔 → 拒絕；建立 AI；滿 → SETUP_READY；effects: BROADCAST + SAVE |
| DISCONNECT | 玩家不存在 → 拒絕；移除該玩家（splice）；effects: BROADCAST + SAVE |
| CLIENT_JOIN / CLIENT_LEAVE / START_GAME | 沿用（gm 模式） |

#### SETUP_READY（新增）

| 事件 | 行為 |
|---|---|
| HUMAN_JOIN / AI_JOIN | 同上（未滿時） |
| DISCONNECT | 移除該玩家；players.length < expected → SETUP_WAITING_JOIN；effects: BROADCAST + SAVE |
| START_GAME | 沿用（assignRolesToPlayers → NIGHT_COLLECTING，boardVersion++，開 night gate） |

#### NIGHT_COLLECTING（新增）

| 事件 | 行為 |
|---|---|
| HUMAN_NIGHT_ACTION / AI_NIGHT_DONE | 沿用 + 自指拒絕（§4.3） |
| DISCONNECT | 玩家不存在 → 拒絕；已 'ai' → 接受但無效果（冪等）；否則 `controlledBy='ai'`、移出 voteReady/skippedHumans；若 pendingGate 存在且 required 含該玩家且 done 不含 → 追加 effect `DISPATCH_LLM { playerId, kind: 'night' }`；effects: BROADCAST + SAVE |
| RECONNECT | 玩家不存在或死亡 → 拒絕 'not alive'；`controlledBy='human'`；effects: BROADCAST + SAVE |
| ACTION_TIMEOUT | 沿用 |

#### DAY_DISCUSSION_OPEN（新增）

| 事件 | 行為 |
|---|---|
| HUMAN_SPEAK | 沿用（recordSpeech）+ `skippedHumans = skippedHumans.filter(id => id !== playerId)` |
| HUMAN_SKIP | 玩家存活驗證；不在 skippedHumans 則加入；effects: BROADCAST + SAVE |
| HUMAN_READY_VOTE | 玩家存活驗證；加入 voteReady；`allAliveHumansReady` → phase = DAY_VOTING_COLLECTING + openVoteGate；否則維持 OPEN；effects: BROADCAST + SAVE |
| HUMAN_UNREADY_VOTE | 移出 voteReady；effects: BROADCAST + SAVE |
| AI_SPEECH_DONE | 沿用（版本檢查 + recordSpeech）+ `skippedHumans = []` |
| DISCONNECT / RECONNECT | 同 NIGHT_COLLECTING（gate 不存在 → 無 DISPATCH_LLM） |
| CLOSE_DISCUSSION / MASON_CHAT | 沿用 |

#### DAY_DISCUSSION_CLOSING（新增）

| 事件 | 行為 |
|---|---|
| HUMAN_READY_VOTE / HUMAN_SKIP | 沿用（skip 視同 ready） |
| HUMAN_UNREADY_VOTE | 沿用 |
| DISCONNECT | 翻轉 'ai' + 移出 voteReady/skippedHumans（無 gate → 無 DISPATCH_LLM） |
| RECONNECT | 存活 → 翻轉 'human' |

#### DAY_VOTING_COLLECTING（新增）

| 事件 | 行為 |
|---|---|
| HUMAN_VOTE / AI_VOTE_DONE | 沿用 |
| DISCONNECT | 翻轉 'ai' + 若 gate 未完成 → `DISPATCH_LLM { kind: 'vote' }` |
| RECONNECT | 存活 → 翻轉 'human' |

#### NIGHT_RESOLVING / DAY_VOTING_RESOLVING / DAY_RESULT_ANNOUNCING / GAME_OVER_FINAL

| 事件 | 行為 |
|---|---|
| DISCONNECT / RECONNECT | 翻轉/還原（GAME_OVER_FINAL 沿用「全部忽略」） |

#### ADVANCE_DAY 修改

```
既有邏輯 + state.skippedHumans = [];
```

### 4.5 boardVersion++ 觸發點（不變）

沿用 Phase 0 清單。HUMAN_SKIP / HUMAN_READY_VOTE / HUMAN_UNREADY_VOTE / DISCONNECT / RECONNECT / HUMAN_JOIN / AI_JOIN **不觸發** boardVersion++。

### 4.6 buildPlayerSnapshot 擴充

```typescript
export function buildPlayerSnapshot(state: GameState, playerId: number): PlayerSnapshot {
  /* 既有邏輯 */
  const gate = state.pendingGate;
  const canAct = gate !== null
    && gate.required.includes(playerId)
    && !gate.done.includes(playerId);
  if (me.role === Role.WEREWOLF) {
    you.wolfAllyIds = /* 既有 */;
    you.wolfMeeting = state.nightActions
      .filter((a) => a.type === NightActionType.WOLF_KILL)
      .map((a) => ({ wolfId: a.actorId, targetId: a.targetId }));
  }
  return {
    /* 既有 */
    gateDeadline: gate?.deadline ?? null,
    you: { ...you, canAct },
  };
}
```

---

## 5. night.ts（狼人會議結算）

### 5.1 修改 resolveNightActions 的狼殺段落

```typescript
// 現行：wolfKillTargetId = wolfActions[0].targetId
// 改為多數決：
const wolfActions = gameState.nightActions.filter((a) => a.type === NightActionType.WOLF_KILL);
if (wolfActions.length > 0) {
  const tally = new Map<number, number>();
  for (const a of wolfActions) tally.set(a.targetId, (tally.get(a.targetId) ?? 0) + 1);
  const maxCount = Math.max(...tally.values());
  const topTargets = Array.from(tally.entries())
    .filter(([, c]) => c === maxCount)
    .map(([t]) => t);
  // 平手 → 先提交者勝（nightActions 依提交順序）
  const first = wolfActions.find((a) => topTargets.includes(a.targetId));
  wolfKillTargetId = first?.targetId;
}
// 無任何狼行動 → 沿用隨機殺非狼 fallback
```

- 其餘（守衛、占卜師、靈媒、log）完全不動。
- **不變式**：night.ts 仍為夜晚結算唯一來源；多數決邏輯只在此處。

---

## 6. engine.ts 小改

### 6.1 processEvent 回傳 TransitionResult + scheduler 通知

```typescript
private processEvent(event: GameEvent): TransitionResult {
  const prevPhase = this.state.phase;
  const prevBoardVersion = this.state.boardVersion;
  const result = transition(this.state, event);
  if (!result.accepted) return result;
  for (const effect of result.effects) { /* 既有 switch */ }
  // Phase 2 新增：任何 boardVersion 變更（含 HUMAN_SPEAK）即時通知 scheduler（CD 重置）
  if (this.state.boardVersion !== prevBoardVersion && this.options.scheduler) {
    this.options.scheduler.onBoardUpdated(this.state);
  }
  if (this.state.phase !== prevPhase) {
    this.save();
    this.onPhaseEntered(this.state);
  }
  return result;
}
```

- 移除 `dispatchLLM` 內原有的 `scheduler.onBoardUpdated` 呼叫（已由 processEvent 涵蓋，避免雙重呼叫）。

### 6.2 tryEvent（公開單事件入口，registry 用）

```typescript
/** 立即處理單一事件並回傳結果（真人操作專用；跳過佇列以保即時性） */
tryEvent(event: GameEvent): TransitionResult {
  return this.processEvent(event);
}
```

- 真人操作（HUMAN_SPEAK / HUMAN_SKIP / HUMAN_READY_VOTE / HUMAN_UNREADY_VOTE / HUMAN_VOTE / HUMAN_NIGHT_ACTION）由 registry 走 `tryEvent`；伺服器內部事件（AI_JOIN / START_GAME / DISCONNECT / RECONNECT / CLOSE_DISCUSSION）維持 enqueue + drain。

### 6.3 dispatchLLM 失敗重試 1 次

```typescript
private async dispatchLLM(playerId: number, kind: 'speech' | 'vote' | 'night'): Promise<void> {
  const llm = this.options.llm;
  if (!llm) return;
  const player = this.state.players.find((p) => p.id === playerId);
  if (!player || !player.alive) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const prompt = buildPrompt(this.state, playerId, kind);
      if (kind === 'speech') {
        const captured = this.state.boardVersion;
        const { text } = await llm.requestSpeech(playerId, prompt);
        const result = this.processEvent({ type: 'AI_SPEECH_DONE', playerId, text, boardVersion: captured });
        if (result.accepted) return;
      } else if (kind === 'vote') {
        const { targetId } = await llm.requestVote(playerId, prompt);
        const result = this.processEvent({ type: 'AI_VOTE_DONE', playerId, targetId });
        if (result.accepted) return;
      } else {
        const { targetId } = await llm.requestNightAction(playerId, prompt);
        const result = this.processEvent({ type: 'AI_NIGHT_DONE', playerId, targetId });
        if (result.accepted) return;
      }
    } catch { /* 重試 1 次 */ }
  }
  // 兩次皆失敗/被拒 → 該行動放棄（gate 由他人完成或 timeout 推進）
}
```

- 目的：AI 回傳無效目標（死亡/自己）被 transition 拒絕時，重試一次，避免 gate 空等 60s timeout。

### 6.4 broadcastSnapshots 支援 LOBBY

```typescript
private broadcastSnapshots(): void {
  const registry = this.options.registry;
  if (!registry) return;
  const state = this.state;
  if (state.phase === 'SETUP_WAITING_JOIN' || state.phase === 'SETUP_READY') {
    try { registry.sendLobby?.(buildLobbySnapshot(state)); } catch {}
    return;
  }
  /* 既有：玩家 snapshot + 觀戰者 snapshot */
}
```

---

## 7. ai-scheduler.ts 擴充

### 7.1 tick 修改（全真人跳過 → 立即管線）

```typescript
private tick(): void {
  if (this.stopped || this.pipelineActive) return;
  let state: GameState;
  try { state = this.ctx.getState(); } catch { return; }
  if (state.phase !== 'DAY_DISCUSSION_OPEN') return;
  if (state.boardVersion !== this.lastSeenBoardVersion) {
    this.lastSeenBoardVersion = state.boardVersion;
    this.lastMessageTime = Date.now();
    return;
  }
  // Phase 2：全真人跳過 → 立即跑管線（不等 quiet 門檻）
  if (allAliveHumansSkipped(state)) {
    void this.runPipeline();
    return;
  }
  if (Date.now() - this.lastMessageTime >= this.options.quietMs) {
    void this.runPipeline();
  }
}
```

### 7.2 broadcastAfterCd 修改（CD 解除）

```typescript
private async broadcastAfterCd(token, playerId, text, commitVersion): Promise<void> {
  const state = this.ctx.getState();
  const skipCd = allAliveHumansSkipped(state);   // 全真人跳過 → CD 解除
  const remaining = skipCd ? 0 : this.options.cdMs - (Date.now() - this.lastMessageTime);
  if (remaining > 0) await sleep(remaining);
  /* 其餘沿用（token 檢查、phase 檢查、enqueue AI_SPEECH_DONE） */
}
```

- 防循環保證：AI_SPEECH_DONE 被接受時 transition 清空 `skippedHumans`（§4.4），故 AI 發言後不會立即再觸發管線。
- 管線進行中真人發言 → boardVersion 變更 → 既有版本檢查作廢管線（不變）。

### 7.3 其餘不變

- `aliveAIIds` 已依 `controlledBy === 'ai'` 過濾——斷線接管後真人座位自動納入 AI 發言。✓
- 選項（SpeechSchedulerOptions）不需新增。

---

## 8. server.ts 擴充

### 8.1 新環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| LOBBY_TIMEOUT_MS | 10000 | 無真人加入時自動全 AI 開局的等待時間 |
| SPEECHES_PER_DAY | 6 | 沿用（僅在無存活真人時自動關閉討論） |

### 8.2 SeatManager（token 管理）

```typescript
class SeatManager {
  private reservations = new Map<number, string>();  // playerId → token
  private tokens = new Map<string, number>();        // token → playerId

  reserve(playerId: number): string;      // crypto.randomUUID()；雙向記錄
  release(playerId: number): void;        // 刪除雙向記錄
  lookup(token: string): number | undefined;
  isReserved(playerId: number): boolean;
}
```

### 8.3 TrackedClient 擴充

```typescript
interface TrackedClient {
  ws: WebSocket;
  gmView: boolean;
  lastPong: number;
  playerId?: number;   // 真人座位（JOIN/RECONNECT 後設定）
  token?: string;
}
```

### 8.4 WebSocketRegistry 擴充

```typescript
getConnectedPlayerIds(): number[];
// [...clients].filter(c => c.playerId !== undefined).map(c => c.playerId!)

send(playerId: number, snapshot: PlayerSnapshot): void;
// 找 playerId 相符的 client → 送 { type: 'SNAPSHOT', snapshot, gmView: false }

sendSpectator(snapshot: SpectatorSnapshot): void;
// 只送給 playerId === undefined 的 client（觀戰者）；gmView 邏輯沿用

sendLobby(lobby: LobbySnapshot): void;
// 送給所有 client：{ type: 'LOBBY', lobby }

pushSnapshot(c: TrackedClient): void;
// SETUP_* → LOBBY；playerId 存在 → buildPlayerSnapshot；否則沿用（gmView / spectator）
```

**訊息處理新增**（onClientMessage）：

| 訊息 | 行為 |
|---|---|
| JOIN { playerId, name } | 見 §8.5 大廳流程 |
| RECONNECT { token } | `pid = seats.lookup(token)`；無 → JOIN_REJECTED 'unknown token'；有 → `client.playerId = pid; client.token = token`；enqueue RECONNECT { pid } + drain；回 JOINED { playerId: pid, token } |
| START_GAME | 僅 `client.playerId !== undefined` 且未開始 → `startGame()` |
| HUMAN_SPEAK { text } | `client.playerId` 存在 → `engine.tryEvent({ type: 'HUMAN_SPEAK', playerId, text })`；`!accepted` → ACTION_REJECTED |
| HUMAN_SKIP | 同上 → HUMAN_SKIP |
| HUMAN_READY_VOTE / HUMAN_UNREADY_VOTE | 同上 |
| HUMAN_VOTE { targetId } | 同上 → HUMAN_VOTE |
| HUMAN_NIGHT_ACTION { targetId } | 同上 → HUMAN_NIGHT_ACTION |

**onDisconnect 擴充**：

```
if (client.playerId !== undefined) {
  if (!started) {
    seats.release(client.playerId);          // 大廳斷線 → 座位釋放
  }
  enqueue DISCONNECT { playerId } + drain;   // 遊戲中 → AI 接管；大廳 → 移除玩家
  if (!started && 大廳已無真人玩家) → 重啟 LOBBY_TIMEOUT timer
}
/* 既有：零連線兜底 timer */
```

### 8.5 大廳流程（startServer 內）

```typescript
let started = false;
let lobbyTimer: ReturnType<typeof setTimeout> | null = null;

function startLobbyTimer(): void {
  clearLobbyTimer();
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null;
    if (!started && 無真人玩家) startGame();   // 無真人 → 全 AI 開局
  }, options.lobbyTimeoutMs ?? envInt('LOBBY_TIMEOUT_MS', 10000));
  // unref()
}

function startGame(): void {
  if (started) return;
  started = true;
  clearLobbyTimer();
  const state = engine!.getState();
  for (let id = 1; id <= state.expectedPlayerCount; id++) {
    if (!state.players.some((p) => p.id === id)) {
      engine!.enqueue({ type: 'AI_JOIN', playerId: id });
    }
  }
  engine!.enqueue({ type: 'START_GAME' });
  engine!.drain();
  broadcast LOBBY（started=true）→ 之後由 engine 廣播 snapshot
}

onJoin(client, playerId, name):
  if (started) → JOIN_REJECTED 'game started'
  if (seats.isReserved(playerId)) → JOIN_REJECTED 'seat reserved'
  const result = engine!.tryEvent({ type: 'HUMAN_JOIN', playerId, name });
  if (!result.accepted) → JOIN_REJECTED result.reason
  const token = seats.reserve(playerId);
  client.playerId = playerId; client.token = token;
  clearLobbyTimer();                       // 有人類了，改等人按開始
  send JOINED { playerId, token };
```

- 啟動流程：模型就緒 → 建立 engine + scheduler + registry → `startLobbyTimer()` → 開瀏覽器。**不再**自動 CLIENT_JOIN × N + START_GAME（改由大廳流程驅動）。

### 8.6 autoCloseTimer 修改（真人主導討論）

```typescript
autoCloseTimer tick:
  const s = engine!.getState();
  if (s.phase !== 'DAY_DISCUSSION_OPEN') return;
  const aliveHumans = s.players.filter((p) => p.alive && p.controlledBy === 'human').length;
  if (aliveHumans > 0) return;   // 真人主導討論，不自動關閉
  const count = s.discussionLog.filter((d) => d.day === s.day).length;
  if (count >= speechesPerDay) → CLOSE_DISCUSSION
```

### 8.7 shutdown 流程

沿用 Phase 1（engine.save → scheduler.stop → registry.stop → dispatcher.shutdown → engine.close → wss/http close）。新增：`seats` 無需清理（記憶體隨程序結束）。

---

## 9. public/ 前端

### 9.1 index.html 版面

```
<header>
  人狼遊戲（真人 + AI 混合對戰）
  狀態列：第 X 天 | 階段 | 連線狀態
  [GM 檢視]（觀戰者限定）| [離開]
</header>
<main>
  <section id="board">        白板（沿用）
  <aside>
    <section id="players">    玩家卡片（可點擊選目標；存活綠/死亡灰）
    <section id="me">         自己的身分（只有自己看得到；含角色描述與私有情報）
    <section id="controls">   操作面板（依 phase 顯示）
  </aside>
</main>
<div id="lobby-overlay">      大廳：座位格線 + [開始遊戲]
<div id="disconnect-overlay"> 斷線提示（沿用）
```

### 9.2 main.js 結構（重寫）

```
state: {
  mode: 'lobby' | 'player' | 'spectator',
  playerId: null,
  token: localStorage.getItem('ww-token'),
  selectedTarget: null,
}

connect():
  onopen:
    if (token) → send RECONNECT { token }
    else → send REQUEST_SNAPSHOT
  onmessage:
    LOBBY → renderLobby
    JOINED → localStorage.setItem('ww-token', token); playerId = ...; mode = 'player'
    JOIN_REJECTED / ACTION_REJECTED → 顯示錯誤訊息
    SNAPSHOT → snapshot.you ? renderPlayer(snapshot) : renderSpectator(snapshot)
    PING → PONG；SHUTDOWN → overlay（沿用）
  onclose → 斷線 overlay + 指數重連（沿用）

renderLobby(lobby):
  座位格線 1..N：
    empty → 可點擊 → send JOIN { playerId, name: 輸入或預設 }
    ai → 顯示「AI」不可點
    human → 顯示名字不可點
  若 mode === 'player' → 顯示 [開始遊戲] → send START_GAME

renderPlayer(snapshot):
  白板（沿用 renderSpectator 的白板部分）
  玩家卡片：alivePlayers 可點擊（vote/night 階段選目標）；selectedTarget 高亮
  身分：you.role / you.team / 私有情報（seerChecks / guardProtects / mediumResults / masonPartnerId / wolfAllyIds）
  renderControls(snapshot)

renderControls(snapshot):
  switch snapshot.phase:
    NIGHT_COLLECTING:
      if (!you.canAct) → 「等待其他玩家行動…」
      else if (role === WEREWOLF) → 狼人會議面板（you.wolfMeeting 列表 + 選目標 + [確認]）
      else if (role === SEER) → 「選擇查驗目標」+ 卡片 + [確認]
      else if (role === GUARD) → day === 1 ? 「第一晚不可守護」 : 「選擇守護目標」+ [確認]
      else → 「無夜間行動」
    DAY_DISCUSSION_OPEN:
      發言輸入框 + [發言]（送出 HUMAN_SPEAK）
      [跳過發言]（送出 HUMAN_SKIP）
      [準備投票]（送出 HUMAN_READY_VOTE；已準備 → 顯示 [取消準備]）
    DAY_DISCUSSION_CLOSING:
      [準備投票] / [取消準備]
    DAY_VOTING_COLLECTING:
      if (!you.canAct) → 「等待投票…」或「已投票」
      else → 「選擇投票目標」+ 卡片 + P 編號輸入備援 + [確認投票]
    GAME_OVER_FINAL: 勝負結果

目標選擇（vote / night 共用）：
  點卡片 → selectedTarget = id → 高亮 → [確認] 送出 HUMAN_VOTE / HUMAN_NIGHT_ACTION
  P 編號輸入備援：輸入數字 → 驗證為存活玩家 → 等同選中
```

### 9.3 身分扁平化的前端保證

- 玩家卡片只顯示 `P{id} {name}`，**不顯示** controlledBy / AI 標記。
- 大廳座位可顯示 AI/真人（遊戲前 UI，允許）。
- 觀戰者介面與 Phase 1 相同（無 `you`）。

---

## 10. 測試規格

框架：node:test + node:assert（沿用）。`package.json` test script 擴充為 14 檔。

### 10.1 human-lobby.test.ts（大廳轉移）

- HUMAN_JOIN 空位 → 建立真人玩家；前方空位自動 AI 填補（座位 5 → 座位 1-4 變 AI）
- HUMAN_JOIN 已被真人佔 → 拒絕 'seat taken'
- HUMAN_JOIN 已被 AI 佔 → 轉換為真人（name 更新）
- HUMAN_JOIN 超出 1..expectedPlayerCount → 拒絕
- AI_JOIN 空位 → 建立 AI；已佔 → 拒絕
- 全座位填滿 → SETUP_READY
- DISCONNECT（SETUP）→ 移除玩家、座位釋放、少於 expected → SETUP_WAITING_JOIN
- START_GAME 後角色分配包含真人座位（assignRolesToPlayers 不區分 human/ai）

### 10.2 human-discussion.test.ts（討論規則）

- HUMAN_SPEAK → 進 log + boardVersion++ + 移除發言者 skip
- HUMAN_SKIP → 加入 skippedHumans；重複 skip 冪等；不觸發 boardVersion++
- 全真人跳過 → `allAliveHumansSkipped` = true；無真人 → false
- AI_SPEECH_DONE 被接受 → skippedHumans 清空
- HUMAN_READY_VOTE（OPEN）→ 加入 voteReady；全 ready → DAY_VOTING_COLLECTING + vote gate 開啟
- 部分 ready → 維持 OPEN
- HUMAN_UNREADY_VOTE（OPEN）→ 移出 voteReady
- HUMAN_READY_VOTE（CLOSING）沿用；HUMAN_SKIP（CLOSING）視同 ready

### 10.3 human-night.test.ts（夜晚 + 狼人會議）

- getNightActors 含全部存活狼（2 狼局 → 3 actors：seer + guard + 2 狼）
- 狼人會議：2 狼提交不同目標 → 多數決（1:1 平手 → 先提交者）
- 狼人會議：3 狼提交 2:1 → 多數目標勝
- HUMAN_NIGHT_ACTION 自指 → 拒絕
- 真人 seer / guard 夜間行動 → gate 完成 → RESOLVE_NIGHT 結算正確
- DISCONNECT（NIGHT_COLLECTING gate 內未完成）→ 產生 DISPATCH_LLM effect（AI 接管）
- 狼人會議 snapshot：`you.wolfMeeting` 只出現在狼的 snapshot；村民/觀戰者無此欄位

### 10.4 human-reconnect.test.ts（斷線/重連）

- DISCONNECT → controlledBy 'ai' + 移出 voteReady/skippedHumans
- RECONNECT（存活）→ controlledBy 'human'
- RECONNECT（死亡）→ 拒絕
- RECONNECT（SETUP）→ 拒絕
- 重連後 gate 內可繼續行動（canAct 正確：required 且未 done）
- 斷線接管後 AI 完成行動 → 重連 → 行動不可重做（canAct = false）

### 10.5 mixed-game.test.ts（混合局完整流程）

- 2 真人（座位 3、7）+ 7 AI：HUMAN_JOIN × 2 + AI_JOIN × 7 → START_GAME → 跑到 gameOver
- 真人動作由 script 驅動（enqueue HUMAN_*）：夜間依角色行動、討論發言/跳過/準備投票、投票
- 斷言：gameOver = true、winner 非 null、真人動作全部 accepted、步驟數 < 上限
- 中途斷線：某真人 DISCONNECT → AI 接管 → 遊戲繼續 → gameOver
- 身分扁平化：全程對 `buildPrompt` 輸出與 `buildSpectatorSnapshot` 檢查不含 `controlledBy`

### 10.6 server-human.test.ts（WS 大廳/重連）

- WS 連線 → 收到 LOBBY（seats 全 empty）
- JOIN { playerId: 3 } → JOINED { playerId: 3, token } → START_GAME → 收到含 `you.role` 的玩家 snapshot
- 兩 client 搶同一座位 → 第二個 JOIN_REJECTED
- 斷線 → 引擎狀態 controlledBy 'ai' → 新 WS 送 RECONNECT { token } → JOINED → 拿回身分
- 未 JOIN 的 client → 觀戰 snapshot（無 `you`）
- 無真人 → LOBBY_TIMEOUT（測試設短）後自動全 AI 開局
- 遊戲開始後 JOIN → JOIN_REJECTED 'game started'

### 10.7 既有測試更新

- game-state.test.ts：`completeNight` / `nightKeeping` helper 已迭代 getNightActors → 自動適應全狼；狼目標一致 → 多數決無分歧，不需改
- full-game.test.ts：ScriptedDispatcher 狼目標一致 → 不破
- server.test.ts：registry 擴充後既有案例（觀戰者）仍綠
- ai-scheduler.test.ts：新增「全真人跳過 → 立即管線（不等 quiet）」案例（fake timers + 真人 skip）
- engine.test.ts：新增「boardVersion 變更 → scheduler.onBoardUpdated 被呼叫」案例

---

## 11. 實作順序與驗收標準

| 步驟 | 檔案 | 驗收標準 |
|---|---|---|
| 1 | types.ts | 編譯通過；SCHEMA_VERSION=3；新事件/型別就緒；既有引用處更新 |
| 2 | game-state.ts | human-lobby / human-discussion / human-night / human-reconnect 測試全綠；既有 game-state / snapshot 測試不破 |
| 3 | night.ts | 狼人會議多數決測試全綠；既有 night 相關測試不破 |
| 4 | engine.ts | engine.test.ts 全綠；onBoardUpdated 通知案例綠；dispatchLLM 重試案例綠 |
| 5 | ai-scheduler.ts | 全真人跳過 → 立即管線案例綠；既有 scheduler 測試不破 |
| 6 | server.ts | server-human.test.ts 全綠；既有 server.test.ts 不破 |
| 7 | public/ | 手動驗證：大廳選座 → [開始遊戲] → 混合局發言/跳過/準備投票/投票/夜間行動/狼人會議全程可用；斷線重連拿回身分 |
| 8 | mixed-game.test.ts | 混合局完整局跑通（含斷線接管） |
| 9 | 收尾 | npm test 全綠（14 檔）；`npm start` 手動完整驗證（含無真人自動全 AI 開局） |

---

## 附錄 A：不可違反的不變式

1. **身分扁平化**：AI prompt（buildPrompt / buildPreSpeechPrompt / buildJudgePrompt / buildExpandPrompt）、白板、觀戰 snapshot 永不透露 controlledBy；玩家一律 P 編號。狼人會議資訊（wolfMeeting）只進狼的 `you`，內容無 controlledBy。大廳 LOBBY snapshot 是唯一允許顯示 controlledBy 的介面（遊戲前 UI，AI 看不到）。
2. **平票 = 無人出局**（沿用，全系統唯一規則）。
3. **boardVersion++ 僅在**：START_GAME、HUMAN_SPEAK 被接受、版本相符的 AI_SPEECH_DONE、RESOLVE_NIGHT、RESOLVE_VOTES、ADVANCE_DAY（沿用）。HUMAN_SKIP / HUMAN_READY_VOTE / HUMAN_UNREADY_VOTE / DISCONNECT / RECONNECT / HUMAN_JOIN / AI_JOIN 不觸發。
4. **transition 純函式**：原地 mutate、開 gate 時 deadline: 0、timer 由 engine 設定（沿用）。
5. **night.ts 為夜晚結算唯一來源**：狼人會議多數決邏輯只在 night.ts。
6. **狼人會議**：所有存活狼都在 night gate；多數決決定目標；平手 → 先提交者。
7. **真人發言即時無 CD；AI 發言 ≥ CD 距最後訊息**；全真人跳過 → CD 解除（broadcastAfterCd 跳過 sleep）。
8. **全真人跳過 → 立即管線；AI_SPEECH_DONE 清空 skippedHumans**（防無限循環）。
9. **斷線 → AI 臨時接管**（controlledBy 翻轉 + gate 內補派 LLM）；**重連 → 拿回**（僅存活；死亡拒絕）。
10. **座位保留**：遊戲開始後真人座位由 token 保留，他人不可佔用；大廳階段斷線 → 座位釋放。
11. **真人操作走 tryEvent（即時）**；伺服器內部事件走 enqueue + drain（佇列順序）。
12. **全 AI 局自動推進**（沿用）：CLOSING 無真人 → 直接開投票 gate；server auto-close 僅在無存活真人時生效。
13. **存檔原子寫入**（沿用）；SCHEMA_VERSION = 3，舊存檔 loadState 回傳 null。
14. **snapshot 永不洩漏** role/team/controlledBy 給玩家（`you` 除外）；gateDeadline / canAct 為公開資訊（無身分洩漏）。

## 附錄 B：Phase 2.5 預留（本階段不實作）

- **共有者夜聊**：MASON_CHAT 目前僅在 DAY_DISCUSSION_OPEN 接受；夜間共有者私聊可於 Phase 2.5 擴充（NIGHT_COLLECTING 接受 MASON_CHAT + 共有者專屬 UI）。
- **真人閒置逾時**：討論階段真人 AFK 的兜底（如 5 分鐘無動作 → 視同跳過/準備投票）——目前由 AI 持續發言 + gate timeout 自然推進，暫不需。
- **多準則裁判（v1.5）**：buildJudgePrompt 擴充為 3 指令 Borda 聚合（Phase 1 附錄 B 已預留）。
- **pkg 打包**：node-llama-cpp native binding spike；Plan B = llama-server.exe sidecar（沿用 Phase 1 附錄 B）。
- **觀戰者下注/聊天**：與對戰無關的社交功能。