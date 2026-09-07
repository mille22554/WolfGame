# Phase 0 地基重構：詳細實作規格

> 本文件是 Phase 0（地基重構）的完整實作規格，fixer 可直接照做。
> 前置脈絡（已確認）：架構審查結論（砍 WebRTC、狀態機重構、pkg spike 提前）與架構調整藍圖。
> 若實作中發現規格矛盾或遺漏，記錄問題回報，不要自行發明解法。

---

## 0. 目標與完成定義

### 0.1 目標

把現有同步 CLI 架構改造成事件驅動狀態機，為 Web 版打地基：

1. **事件驅動**：所有狀態變更經由 `transition(state, event)` 單一入口；I/O 副作用（timer、LLM 分派、廣播、存檔）全部由 engine 負責
2. **per-client 資訊過濾**：玩家只看得到自己該看的（`buildPlayerSnapshot`），GM 看全貌（`buildGMSnapshot`）
3. **白板版本號**：`boardVersion` 讓 AI 的舊思考作廢（白板更新 → 重想）
4. **上下文截斷**：`buildPrompt` 純函式 + 截斷演算法
5. **持久化**：`saveState` / `loadState` 原子寫入，`schemaVersion` 檢查

### 0.2 完成定義

Phase 0 完成的定義（全部滿足）：

1. `npm test` 全綠（node:test，4 個測試檔）
2. `node driver.mjs mock-test` 跑通完整局
3. `gm.ts` 全命令可用：init → join → start-day → night → speak → vote 完整流程

---

## 1. 檔案地圖

| 檔案 | 動作 | 說明 |
|---|---|---|
| src/types.ts | 重寫 | 型別層：Phase enum、GameEvent union、PendingGate、PlayerSnapshot 等 |
| src/utils.ts | 小改 | 新增 getResourceRoot / getDataDir |
| src/assignment.ts | 改寫 | createLobbyPlayers / assignRolesToPlayers / createPlayers |
| src/ai.ts | 小改 | buildPublicKnowledge 剝離身分、isHuman → controlledBy |
| src/day.ts | 刪除死碼 | 刪 conductVoting / selectVoteTarget |
| src/game-state.ts | 重寫 | 純狀態機 + snapshot + 持久化 |
| src/character-session.ts | 重寫 | buildPrompt 純函式 + summarizeDay + 截斷 |
| src/engine.ts | 新增 | GameEngine 事件佇列 + I/O 副作用 |
| src/gm.ts | 改寫 | engine 的 CLI 包裝 |
| src/driver.ts | 改寫 | 移除 runGame 等 |
| driver.mjs | 改寫 | mock-test 重實作為 ScriptedGM |
| src/llm.ts | 一行改動 | contextSize 顯式 8192 |
| src/night.ts | 不動 | 保留（夜晚結算唯一來源） |
| src/personalities.ts | 不動 | 保留 |
| character/ | 不動 | 保留（agents.md / memory.md / day-meeting.md 被 buildPrompt 讀取） |
| src/game-state.test.ts 等 4 檔 | 新增 | 測試（見 §13） |

---

## 2. types.ts（重寫）

### 2.1 常數

```typescript
export const SCHEMA_VERSION = 2;
```

### 2.2 Phase（扁平 enum，10 值）

```typescript
export type Phase =
  | 'SETUP_WAITING_JOIN'      // 等待玩家加入
  | 'SETUP_READY'             // 人數足夠，可開始
  | 'NIGHT_COLLECTING'        // 夜晚，收集行動
  | 'NIGHT_RESOLVING'         // 夜晚行動結算
  | 'DAY_DISCUSSION_OPEN'     // 白天討論開放
  | 'DAY_DISCUSSION_CLOSING'  // 討論收尾（準備投票）
  | 'DAY_VOTING_COLLECTING'   // 收集投票
  | 'DAY_VOTING_RESOLVING'    // 投票結算
  | 'DAY_RESULT_ANNOUNCING'   // 公布處決結果
  | 'GAME_OVER_FINAL';        // 遊戲結束
```

### 2.3 GameEvent（union，18 事件）

```typescript
export type GameEvent =
  | { type: 'CLIENT_JOIN'; name: string }
  | { type: 'CLIENT_LEAVE' }
  | { type: 'START_GAME' }
  | { type: 'HUMAN_SPEAK'; playerId: number; text: string }
  | { type: 'HUMAN_SKIP'; playerId: number }
  | { type: 'HUMAN_READY_VOTE'; playerId: number }
  | { type: 'HUMAN_UNREADY_VOTE'; playerId: number }
  | { type: 'HUMAN_VOTE'; playerId: number; targetId: number }
  | { type: 'HUMAN_NIGHT_ACTION'; playerId: number; targetId: number }
  | { type: 'AI_SPEECH_DONE'; playerId: number; text: string; boardVersion: number }
  | { type: 'AI_VOTE_DONE'; playerId: number; targetId: number }
  | { type: 'AI_NIGHT_DONE'; playerId: number; targetId: number }
  | { type: 'MASON_CHAT'; playerId: number; text: string }
  | { type: 'ACTION_TIMEOUT'; gateId: string }   // gate 級，無 playerId
  | { type: 'DISCONNECT'; playerId: number }
  | { type: 'CLOSE_DISCUSSION' }
  | { type: 'RESOLVE_NIGHT' }    // 內部：NIGHT_RESOLVING 結算完成
  | { type: 'RESOLVE_VOTES' }    // 內部：DAY_VOTING_RESOLVING 結算完成
  | { type: 'ADVANCE_DAY' };     // 內部：進入下一天
```

### 2.4 PendingGate

```typescript
export interface PendingGate {
  kind: 'night' | 'vote';
  required: number[];   // 需要行動的 playerId
  done: number[];       // 已完成行動的 playerId
  timeoutMs: number;
  deadline: number;     // engine 在 phase entry 時設定；transition 開 gate 時為 0
}
```

### 2.5 Player

```typescript
export interface Player {
  id: number;
  name: string;
  role: Role;
  team: Team;
  controlledBy: 'human' | 'ai';   // 取代 isHuman
  personality: string;
  alive: boolean;
  isMasonPartner?: boolean;
}
```

### 2.6 GameState

```typescript
export interface GameState {
  schemaVersion: number;          // = SCHEMA_VERSION
  phase: Phase;
  day: number;
  players: Player[];
  humanPlayerIndices: number[];
  discussionLog: { playerId: number; text: string; day: number }[];
  votes: { voterId: number; targetId: number; day: number }[];
  deathHistory: { playerId: number; cause: 'wolf_kill' | 'vote' | 'suicide'; day: number }[];
  seerChecks: { seerId: number; targetId: number; result: Team; day: number }[];
  guardProtects: { guardId: number; targetId: number; day: number }[];
  winner: Team | null;
  gameOver: boolean;
  boardVersion: number;           // 白板版本號
  daySummaries: string[];         // 每天摘要（截斷用）
  voteReady: number[];            // 已準備投票的真人
  pendingGate: PendingGate | null;
}
```

### 2.7 Snapshot 型別

```typescript
export interface PlayerSnapshot {
  phase: Phase;
  day: number;
  alivePlayers: { id: number; name: string }[];
  deadPlayers: { id: number; name: string; cause: string; day: number }[];
  nightResult: string | null;     // 昨晚結果（由 deathHistory 最後一筆 wolf_kill 推導）
  discussionLog: { playerId: number; text: string }[];
  votes: { voterId: number; targetId: number }[];
  winner: Team | null;
  gameOver: boolean;
  you: {
    role: Role;
    team: Team;
    seerChecks?: { targetId: number; result: Team; day: number }[];
    guardProtects?: { targetId: number; day: number }[];
    mediumResults?: { targetId: number; team: Team; day: number }[];  // 由 deathHistory 推導
    masonPartnerId?: number;
    masonChatLog?: { playerId: number; text: string }[];
    wolfAllyIds?: number[];
  };
}

export interface GMSnapshot {
  phase: Phase;
  day: number;
  players: Player[];              // 完整，含 role/team/controlledBy
  discussionLog: { playerId: number; text: string; day: number }[];
  votes: { voterId: number; targetId: number; day: number }[];
  deathHistory: { playerId: number; cause: string; day: number }[];
  boardVersion: number;
  pendingGate: PendingGate | null;
  voteReady: number[];
}
```

### 2.8 TransitionResult

```typescript
export interface TransitionResult {
  state: GameState;
  effects: Effect[];   // engine 執行的副作用
  accepted: boolean;   // 事件是否被接受（例如版本不符的 AI_SPEECH_DONE 被丟棄）
  reason?: string;     // 拒絕原因
}

export type Effect =
  | { type: 'BROADCAST' }
  | { type: 'SAVE' }
  | { type: 'ARM_GATE'; gate: PendingGate }
  | { type: 'DISPATCH_LLM'; playerId: number; kind: 'speech' | 'vote' | 'night' }
  | { type: 'ENQUEUE'; event: GameEvent };
```

### 2.9 其他

- `Role` / `Team` 型別沿用現有定義（VILLAGER / WEREWOLF / SEER / GUARD / MEDIUM；VILLAGER / WEREWOLF）

---

## 3. utils.ts（新增 getDataDir）

```typescript
export function getResourceRoot(): string;
export function getDataDir(): string;
```

- `getResourceRoot`：唯讀資源根（同舊 getProjectRoot，供 character/ 讀取）
- `getDataDir`：可寫資料目錄
  - pkg 環境（`process.pkg` 存在）：exe 旁 `data/`，探測可寫性；不可寫 → fallback `%APPDATA%/WerewolfGame`
  - dev 環境：專案根

---

## 4. assignment.ts（改寫）

```typescript
export function createLobbyPlayers(playerCount: number): Player[];
// 佔位：全部 VILLAGER + 依序 personality，controlledBy 依 humanPlayerIndices

export function assignRolesToPlayers(state: GameState): void;
// START_GAME 時呼叫：覆寫 role/team/isMasonPartner

export function createPlayers(playerCount: number, humanPlayerIndices: number[] = []): Player[];
// 相容舊介面：直接建立含角色分配的玩家（測試用）
```

角色分配演算法（沿用現有）：
- 狼人：1–2 人（依人數）
- 占卜師：1
- 守衛：1
- 其餘村民
- 共有者配對：狼人以外的 2 人（若人數允許）

---

## 5. ai.ts（小改）

- `buildPublicKnowledge`：改白名單映射，剝離 `controlledBy`（現有 `{...p}` spread 會洩漏身分）
- `createAIPlayers`：判斷改 `p.controlledBy === 'ai'`

---

## 6. day.ts（刪除死碼）

- **刪除**：`conductVoting`、`selectVoteTarget`（死碼 + 平票 bug 來源）
- **保留**：`checkWinCondition`、`formatVotingResultPublic`、`formatVotingResultForMedium`、`formatDayStart`、`formatDiscussionPrompt`、`getGameStatus`

---

## 7. game-state.ts（重寫為純狀態機）

### 7.1 核心函式

```typescript
export function createGameState(playerCount: number, humanPlayerIndices?: number[]): GameState;
export function transition(state: GameState, event: GameEvent): TransitionResult;
export function buildPlayerSnapshot(state: GameState, playerId: number): PlayerSnapshot;
export function buildGMSnapshot(state: GameState): GMSnapshot;
export function saveState(state: GameState): void;
export function loadState(): GameState | null;
export function getNightActors(state: GameState): number[];
```

`transition` 為純函式：原地 mutate state，開 gate 時 `deadline: 0`（timer 由 engine 在 phase entry 時設定）。

### 7.2 轉移表（全事件 × 全 phase）

#### SETUP_WAITING_JOIN（等待加入）

| 事件 | 行為 |
|---|---|
| CLIENT_JOIN | 加入 lobby player（VILLAGER 佔位，controlledBy 依 humanPlayerIndices）；人數達標 → SETUP_READY |
| START_GAME | 拒絕（人數不足） |
| 其他 | 忽略 |

#### SETUP_READY（可開始）

| 事件 | 行為 |
|---|---|
| CLIENT_JOIN | 加入 lobby player（若未滿） |
| START_GAME | assignRolesToPlayers → NIGHT_COLLECTING（夜 1），boardVersion++，開 night gate |
| 其他 | 忽略 |

#### NIGHT_COLLECTING（夜晚收集行動）

| 事件 | 行為 |
|---|---|
| HUMAN_NIGHT_ACTION | 記錄行動（seer 檢查 / guard 保護 / 狼殺），gate.done 加入；gate 滿 → NIGHT_RESOLVING |
| AI_NIGHT_DONE | 同上 |
| ACTION_TIMEOUT | gate 到期：未行動者視為放棄 → NIGHT_RESOLVING |
| 其他 | 忽略 |

#### NIGHT_RESOLVING（夜晚結算）

| 事件 | 行為 |
|---|---|
| RESOLVE_NIGHT（內部） | 套用 night.ts 結算（守衛擋狼、死亡紀錄，night.ts 為唯一來源）；boardVersion++；若遊戲結束 → GAME_OVER_FINAL；否則 → DAY_DISCUSSION_OPEN（day++），boardVersion++ |
| 其他 | 忽略 |

#### DAY_DISCUSSION_OPEN（白天討論）

| 事件 | 行為 |
|---|---|
| HUMAN_SPEAK | 加入 discussionLog；boardVersion++ |
| AI_SPEECH_DONE | 版本相符 → 加入 discussionLog，boardVersion++；版本不符 → 丟棄（accepted: false） |
| HUMAN_SKIP | 記錄跳過（不進 log） |
| MASON_CHAT | 加入 masonChatLog（僅共有者可見） |
| CLOSE_DISCUSSION | → DAY_DISCUSSION_CLOSING |
| 其他 | 忽略 |

#### DAY_DISCUSSION_CLOSING（討論收尾）

| 事件 | 行為 |
|---|---|
| HUMAN_READY_VOTE | 加入 voteReady |
| HUMAN_UNREADY_VOTE | 移出 voteReady |
| HUMAN_SKIP | 視同準備投票（加入 voteReady） |
| 全真人已 ready | → DAY_VOTING_COLLECTING，開 vote gate |
| 其他 | 忽略 |

#### DAY_VOTING_COLLECTING（收集投票）

| 事件 | 行為 |
|---|---|
| HUMAN_VOTE | 記錄投票；gate.done 加入；gate 滿 → DAY_VOTING_RESOLVING |
| AI_VOTE_DONE | 同上 |
| ACTION_TIMEOUT | gate 到期：未投票者視為棄權 → DAY_VOTING_RESOLVING |
| 其他 | 忽略 |

#### DAY_VOTING_RESOLVING（投票結算）

| 事件 | 行為 |
|---|---|
| RESOLVE_VOTES（內部） | 統計票數；**平票 → 無人出局**；否則最高票出局（cause: 'vote'）；boardVersion++；若遊戲結束 → GAME_OVER_FINAL；否則 → DAY_RESULT_ANNOUNCING |
| 其他 | 忽略 |

#### DAY_RESULT_ANNOUNCING（公布結果）

| 事件 | 行為 |
|---|---|
| ADVANCE_DAY（內部） | 生成 daySummary（summarizeDay）；boardVersion++；→ NIGHT_COLLECTING（day++） |
| 其他 | 忽略 |

#### GAME_OVER_FINAL

| 事件 | 行為 |
|---|---|
| 全部 | 忽略 |

### 7.3 boardVersion++ 觸發點

- START_GAME（SETUP_READY → NIGHT_COLLECTING）
- HUMAN_SPEAK 被接受
- AI_SPEECH_DONE 版本相符且被接受
- RESOLVE_NIGHT
- RESOLVE_VOTES
- ADVANCE_DAY

**不觸發**：CLIENT_JOIN、CLIENT_LEAVE、HUMAN_SKIP、HUMAN_READY_VOTE、HUMAN_UNREADY_VOTE、MASON_CHAT、pendingGate 變更

### 7.4 buildPlayerSnapshot（per-client 過濾）

- 公開欄位：alivePlayers（**無 role/team/controlledBy**）、deadPlayers、nightResult（由 deathHistory 最後一筆 wolf_kill 推導）、discussionLog、votes、winner、gameOver
- `you`（私有，依角色）：
  - SEER：seerChecks
  - GUARD：guardProtects
  - MEDIUM：mediumResults（由 deathHistory 推導，getMediumResults）
  - 共有者：masonPartnerId + masonChatLog
  - WEREWOLF：wolfAllyIds

### 7.5 持久化

```typescript
saveState(state: GameState): void;
// 原子寫入：getDataDir()/game-state.json，tmp → rename

loadState(): GameState | null;
// 讀取 + schemaVersion 檢查；不符 → 回傳 null
```

### 7.6 getNightActors

```typescript
getNightActors(state): number[];
// seer（存活）+ guard（存活且 day > 1）+ 第一隻狼（存活）
// 回傳 playerId 陣列
```

---

## 8. character-session.ts（重寫為 buildPrompt）

```typescript
export function buildPrompt(
  state: GameState,
  playerId: number,
  kind: 'speech' | 'vote' | 'night',
  budget?: number   // 字元預算，預設 8000
): string;
```

- 組裝順序：角色卡（persona/agents.md + memory.md）→ 遊戲規則 → 公開知識（buildPublicKnowledge）→ 私有知識（依角色）→ 當天討論 → 歷史摘要（daySummaries）→ 任務指令（依 kind）
- 截斷演算法：
  1. maxChars = budget ?? 8000
  2. maxCurrentDayEntries = 60
  3. 先丟最舊 daySummary，再丟當天最舊討論條目
  4. 固定部分（角色卡/規則）超限 → 原樣輸出（不截斷）

```typescript
export function summarizeDay(state: GameState, day: number): string;
// 啟發式：top3 指控（被最多人投票/點名）+ 投票結果
```

---

## 9. engine.ts（新增）

```typescript
export interface EngineOptions {
  mode: 'gm' | 'web';
  nightTimeoutMs?: number;    // web: 90000, gm: Infinity
  voteTimeoutMs?: number;     // web: 60000
  closingTimeoutMs?: number;  // web: 60000
  llm?: LLMDispatcher;
  scheduler?: AIScheduler;    // Phase 1 實作（發言選擇機制）
  registry?: ClientRegistry;  // web 模式需要
}

export interface LLMDispatcher {
  requestNightAction(playerId: number, prompt: string): Promise<{ targetId: number }>;
  requestVote(playerId: number, prompt: string): Promise<{ targetId: number }>;
  requestSpeech(playerId: number, prompt: string): Promise<{ text: string }>;
}

export interface AIScheduler {
  onBoardUpdated(state: GameState): void;   // Phase 1：發言選擇機制
  onPhaseEntered(state: GameState): void;
}

export interface ClientRegistry {
  getConnectedPlayerIds(): number[];
  send(playerId: number, snapshot: PlayerSnapshot): void;
}

export class GameEngine {
  constructor(options: EngineOptions);
  enqueue(event: GameEvent): void;
  drain(): void;                 // 同步處理佇列
  handleEvent(event: GameEvent): void;  // 單一事件
  getState(): GameState;
  save(): void;                  // flushSave
  onPhaseEntered(state: GameState): void;  // 副作用：gate timer、LLM 分派、摘要生成
}
```

- 佇列：enqueue → drain 同步處理（避免 async 競態）
- phase entry 副作用：
  - NIGHT_COLLECTING：arm night gate（deadline = now + nightTimeoutMs）+ 分派 getNightActors 的 LLM
  - DAY_VOTING_COLLECTING：arm vote gate + 分派 AI 投票
  - DAY_DISCUSSION_OPEN：分派 AI 發言（Phase 1 由 scheduler 決定）
  - DAY_RESULT_ANNOUNCING：生成 daySummary + enqueue ADVANCE_DAY
- 存檔：debounce 5s；phase 變更立即 flushSave
- broadcastSnapshots：per-client（registry.send）
- ACTION_TIMEOUT：gate timer 到期 → enqueue ACTION_TIMEOUT

---

## 10. gm.ts（改寫）

engine 的 CLI 包裝：

| 命令 | 行為 |
|---|---|
| init | 建立 engine（mode: 'gm'） |
| join | enqueue CLIENT_JOIN |
| state | 印出 GMSnapshot |
| start-day | enqueue START_GAME |
| night | 依 getNightActors 驗證覆蓋；AI → enqueue AI_NIGHT_DONE，真人 → 等待 HUMAN_NIGHT_ACTION |
| speak | enqueue HUMAN_SPEAK / AI_SPEECH_DONE |
| vote | 先 enqueue CLOSE_DISCUSSION，再依 controlledBy 分流 AI_VOTE_DONE / HUMAN_VOTE |
| mason-chat | enqueue MASON_CHAT |
| reveal | 印出完整狀態（GM 視角） |

---

## 11. driver.ts / driver.mjs（改寫）

- driver.ts：移除 runGame / runDiscussion / runVoting / runNight
- discuss / vote / night / play 命令標 Phase 1（回傳「Phase 1 實作」）
- driver.mjs：mock-test 重實作為 ScriptedGM
  - 用 engine（mode: 'gm'）+ 啟發式 AI 玩家跑完整局
  - 啟發式：seer 隨機檢查、狼殺隨機、投票投最可疑（隨機）、發言用固定模板
  - 兼整合測試

---

## 12. llm.ts（一行改動）

```typescript
createContext({
  contextSize: Number(process.env.LLM_CONTEXT_SIZE ?? 8192),
  // 其餘不變
});
```

---

## 13. 測試規格

框架：node:test + node:assert
script：`"test": "node --test dist"`

### 13.1 game-state.test.ts（轉移表全路徑）

- SETUP_WAITING_JOIN：CLIENT_JOIN 加入、人數達標 → SETUP_READY
- SETUP_READY：START_GAME → 角色分配 + NIGHT_COLLECTING + boardVersion++
- NIGHT_COLLECTING：gate 完成 → NIGHT_RESOLVING；ACTION_TIMEOUT → NIGHT_RESOLVING
- NIGHT_RESOLVING：RESOLVE_NIGHT → 死亡套用 + DAY_DISCUSSION_OPEN
- DAY_DISCUSSION_OPEN：HUMAN_SPEAK 進 log + boardVersion++；AI_SPEECH_DONE 版本相符/不符
- DAY_DISCUSSION_CLOSING：voteReady 增減；全 ready → DAY_VOTING_COLLECTING
- DAY_VOTING_COLLECTING：gate 完成 → DAY_VOTING_RESOLVING；**平票 → 無人出局**
- DAY_VOTING_RESOLVING：RESOLVE_VOTES → 最高票出局 + DAY_RESULT_ANNOUNCING
- DAY_RESULT_ANNOUNCING：ADVANCE_DAY → daySummary + NIGHT_COLLECTING
- GAME_OVER_FINAL：全部忽略
- 平票規則：平票無人出局（全系統唯一規則）

### 13.2 snapshot.test.ts（per-client 過濾）

- 村民看不到任何 role/team/controlledBy
- seer 看得到自己的 seerChecks
- guard 看得到自己的 guardProtects
- medium 的 mediumResults 由 deathHistory 推導
- 共有者看得到 masonPartnerId + masonChatLog
- 狼看得到 wolfAllyIds
- GM snapshot 完整（含 role/team/controlledBy）

### 13.3 character-session.test.ts

- buildPrompt 含角色卡/規則/公開知識/私有知識/當天討論/摘要/任務指令
- 截斷：超長討論 → 先丟 daySummary 再丟當天最舊
- summarizeDay 格式：top3 指控 + 投票結果

### 13.4 engine.test.ts

- 佇列順序：enqueue 多事件 → drain 依序處理
- 存檔觸發：debounce 5s、phase 變更立即存
- 版本丟棄：舊 boardVersion 的 AI_SPEECH_DONE 被丟棄
- gate timer：mock timers 驗證 ACTION_TIMEOUT
- ScriptedGM：完整局跑通

---

## 14. 實作順序與驗收標準

| 步驟 | 檔案 | 驗收標準 |
|---|---|---|
| 1 | utils.ts | getDataDir 在 dev/pkg 兩環境行為正確 |
| 2 | types.ts | 編譯通過；所有型別被引用處更新 |
| 3 | assignment.ts | createLobbyPlayers / assignRolesToPlayers 單元測試 |
| 4 | day.ts | 刪除後無殘留引用 |
| 5 | ai.ts | buildPublicKnowledge 不洩漏 controlledBy |
| 6 | game-state.ts | 轉移表測試全綠 |
| 7 | character-session.ts | buildPrompt 測試全綠 |
| 8 | engine.ts | engine 測試全綠 |
| 9 | gm.ts | 全命令手動驗證 |
| 10 | driver.ts / driver.mjs | mock-test 跑通 |
| 11 | llm.ts | contextSize 生效 |
| 12 | 測試收尾 | npm test 全綠 |

---

## 附錄 A：不可違反的不變式

- **平票 = 無人出局**（全系統唯一規則）
- **boardVersion++ 僅在**：START_GAME、HUMAN_SPEAK 被接受、版本相符的 AI_SPEECH_DONE、RESOLVE_NIGHT、RESOLVE_VOTES、ADVANCE_DAY
- **snapshot 永不洩漏** role/team/controlledBy 給玩家；medium 結果從 deathHistory 推導
- **transition 純函式**：原地 mutate 但開 gate 時 `deadline: 0`，timer 由 engine 在 phase entry 時設定
- **存檔原子寫入**：tmp → rename，載入檢查 schemaVersion
- **AI_SPEECH_DONE 帶 boardVersion**，版本不符直接丟棄（白板更新作廢機制）
- **night.ts 為夜晚結算唯一來源**（processNight 重複死亡 guard 已移除）

## 附錄 B：Phase 1 預留接口（本階段不實作）

- `AIScheduler`（發言選擇機制：15 個輕量預發言 + 全盲裁判 + 新穎性懲罰 + top3 隨機）— engine 已預留 `scheduler` 選項
- Web 伺服器 + WebSocket + 前端（HTML/CSS/JS）
- pkg 打包（getDataDir 已就緒；node-llama-cpp native binding 需 spike 驗證，Plan B = llama-server.exe sidecar + OpenAICompatibleProvider）