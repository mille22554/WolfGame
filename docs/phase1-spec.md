# Phase 1 單機 Web 全 AI：詳細實作規格

> 本文件是 Phase 1（單機 Web 全 AI）的完整實作規格，fixer 可直接照做。
> 前置：Phase 0 已完成（commit 481f831）。engine.ts 已預留 LLMDispatcher / AIScheduler / ClientRegistry 接口。
> 若實作中發現規格矛盾或遺漏，記錄問題回報，不要自行發明解法。

---

## 0. 目標與完成定義

### 0.1 目標

在 Phase 0 事件驅動狀態機之上，建立單機 Web 版：

1. **後端伺服器**：HTTP 靜態 + WebSocket，自動找 port、開瀏覽器、模型檢查/下載、關閉機制
2. **LLM worker**：node-llama-cpp 移入 worker thread，主進程不阻塞；崩潰可重啟
3. **發言選擇機制**：全員輕量預發言 + 全盲裁判 + 新穎性懲罰 + top3 隨機（AIScheduler 實作）
4. **觀戰介面**：純 HTML/CSS/JS，白板即時更新，預留真人操作區（Phase 2）
5. **全 AI 對戰**：server 啟動後自動跑完整局，無需真人操作

### 0.2 完成定義

Phase 1 完成的定義（全部滿足）：

1. `npm test` 全綠（含新增 worker / ai-scheduler / server / full-game 測試，共 8 檔）
2. `npm start`（`node dist/server.js`）→ 自動開瀏覽器 → 觀戰介面即時顯示全 AI 對戰 → 完整局跑完
3. 模型未下載時：瀏覽器顯示下載進度頁 → 完成後自動進入遊戲
4. 關閉機制驗證：離開按鈕 → 立即關閉；斷線 → 10 分鐘兜底關閉
5. worker 崩潰 → 主邏輯存活、自動重啟、遊戲繼續

---

## 1. 檔案地圖

| 檔案 | 動作 | 說明 |
|---|---|---|
| src/types.ts | 擴充 | SpectatorSnapshot、WorkerMessage、LLMDispatcher.generate、ClientRegistry 擴充、前端 WS 協定 |
| src/game-state.ts | 小改 | 新增 buildSpectatorSnapshot |
| src/character-session.ts | 擴充 | buildPreSpeechPrompt / buildJudgePrompt / buildExpandPrompt |
| src/novelty.ts | 新增 | 相似度 / 新穎性懲罰純函式 |
| src/worker.ts | 新增 | LLM worker thread 入口 |
| src/worker-dispatcher.ts | 新增 | WorkerDispatcher（LLMDispatcher 實作） |
| src/ai-scheduler.ts | 新增 | SpeechScheduler（AIScheduler 實作） |
| src/engine.ts | 小改 | broadcastSnapshots 支援觀戰者 |
| src/server.ts | 新增 | HTTP + WebSocket + 生命週期 |
| public/index.html | 新增 | 觀戰主頁 |
| public/download.html | 新增 | 模型下載進度頁 |
| public/css/style.css | 新增 | 樣式 |
| public/js/main.js | 新增 | 觀戰邏輯 |
| public/js/download.js | 新增 | 下載頁邏輯 |
| src/worker.test.ts 等 4 檔 | 新增 | 測試（見 §13） |
| package.json | 修改 | +ws 依賴、+start script、test script 擴充 |

**不動**：game-state.ts 其餘、night.ts、day.ts、ai.ts、assignment.ts、gm.ts、driver.mjs、utils.ts、llm.ts（LlamaCppProvider 保留供 worker 內部使用）

---

## 2. 依賴與設定

### 2.1 新依賴

- `ws`（WebSocket 伺服器）— 唯一新增 runtime 依賴

### 2.2 package.json

```json
{
  "scripts": {
    "start": "node dist/server.js",
    "test": "node --test --test-concurrency=1 ./dist/game-state.test.js ./dist/snapshot.test.js ./dist/character-session.test.js ./dist/engine.test.js ./dist/worker.test.js ./dist/ai-scheduler.test.js ./dist/server.test.js ./dist/full-game.test.js"
  },
  "dependencies": { "ws": "^8.x" }
}
```

### 2.3 環境變數（全部有預設值）

| 變數 | 預設 | 說明 |
|---|---|---|
| PORT | 0（自動找 3000 起） | 指定 port；0 = 自動 |
| PLAYER_COUNT | 15 | 全 AI 玩家人數（6-15） |
| LLM_MODEL_URI | 沿用 llm.ts 預設 | Qwen3-4B |
| LLM_MODELS_DIR | 沿用 getDefaultModelsDir() | models/ |
| LLM_WORKER_CONTEXTS | 3 | worker 平行 context 數（1-4） |
| LLM_PROVIDER | llamacpp | mock → 測試模式（不載入模型） |
| SPEECH_CD_MS | 60000 | 發言冷卻 |
| QUIET_THRESHOLD_MS | 20000 | 安靜門檻 |
| ZERO_CLIENT_SHUTDOWN_MS | 600000 | 零連線兜底關閉 |
| PING_INTERVAL_MS | 30000 | WS ping 間隔 |
| PING_TIMEOUT_MS | 10000 | ping 逾時 |

---

## 3. types.ts 擴充

### 3.1 SpectatorSnapshot（觀戰者視角，無角色資訊）

```typescript
export interface SpectatorSnapshot {
  phase: Phase;
  day: number;
  alivePlayers: { id: number; name: string }[];
  deadPlayers: { id: number; name: string; cause: string; day: number }[];
  nightResult: string | null;
  discussionLog: { playerId: number; text: string }[];
  votes: { voterId: number; targetId: number }[];
  winner: Team | null;
  gameOver: boolean;
}
```

### 3.2 Worker 通訊協定型別

```typescript
export interface WorkerJob {
  jobId: string;
  kind: 'speech' | 'vote' | 'night' | 'pre_speech' | 'judge' | 'expand';
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}

export type MainToWorkerMessage =
  | { type: 'INIT'; modelPath: string; contextSize: number; contextCount: number }
  | { type: 'JOB'; job: WorkerJob }
  | { type: 'SHUTDOWN' };

export type WorkerToMainMessage =
  | { type: 'READY' }
  | { type: 'RESULT'; jobId: string; ok: true; text: string }
  | { type: 'RESULT'; jobId: string; ok: false; error: string }
  | { type: 'LOG'; level: 'info' | 'warn' | 'error'; message: string };
```

### 3.3 LLMDispatcher 擴充

```typescript
export interface LLMDispatcher {
  requestNightAction(playerId: number, prompt: string): Promise<{ targetId: number }>;
  requestVote(playerId: number, prompt: string): Promise<{ targetId: number }>;
  requestSpeech(playerId: number, prompt: string): Promise<{ text: string }>;
  /** Phase 1 新增：原始文字生成（預發言/裁判/展開用） */
  generate(prompt: string, config?: GenerationConfig): Promise<string>;
}
```

### 3.4 ClientRegistry 擴充（觀戰者支援，optional 保持相容）

```typescript
export interface ClientRegistry {
  getConnectedPlayerIds(): number[];
  send(playerId: number, snapshot: PlayerSnapshot): void;
  /** Phase 1 新增（optional）：觀戰者廣播 */
  sendSpectator?(snapshot: SpectatorSnapshot): void;
  hasSpectators?(): boolean;
}
```

### 3.5 SchedulerContext（SpeechScheduler 建構參數）

```typescript
export interface SchedulerContext {
  enqueue(event: GameEvent): void;
  getState(): GameState;
  llm: LLMDispatcher;
}
```

### 3.6 前端 WS 協定型別

```typescript
export type ServerToClientMessage =
  | { type: 'SNAPSHOT'; snapshot: SpectatorSnapshot | GMSnapshot; gmView: boolean }
  | { type: 'MODEL_STATUS'; state: 'downloading' | 'ready' | 'error'; downloaded?: number; total?: number; error?: string }
  | { type: 'PING' }
  | { type: 'SHUTDOWN' };

export type ClientToServerMessage =
  | { type: 'PONG' }
  | { type: 'REQUEST_SNAPSHOT' }
  | { type: 'SET_GM_VIEW'; enabled: boolean }
  | { type: 'LEAVE' };
```

---

## 4. game-state.ts：buildSpectatorSnapshot

```typescript
export function buildSpectatorSnapshot(state: GameState): SpectatorSnapshot;
```

- 與 buildPlayerSnapshot 的公開欄位相同，**不含 `you`**
- 實作：抽共用私有函式（公開欄位部分）或直接複製公開欄位邏輯

---

## 5. character-session.ts：預發言 / 裁判 / 展開 prompt

### 5.1 buildPreSpeechPrompt（輕量，2-3K tokens）

```typescript
export function buildPreSpeechPrompt(state: GameState, playerId: number): string;
```

組裝順序（輕量版）：

1. 人格（persona/agents.md，只取前 500 字）
2. 私有知識（privateKnowledgeLines，同 buildPrompt）
3. 當天摘要（daySummaries 最後一則；無則「尚無摘要」）
4. 最近 5 則討論（今天的最後 5 條）
5. 任務指令：20-40 字預發言

```typescript
const PRE_SPEECH_BUDGET = 3000;        // 字元預算
const PRE_SPEECH_RECENT = 5;           // 最近幾則
const PRE_SPEECH_PERSONA_MAX = 500;    // 人格精簡上限
```

任務指令範例：

```
【任務】你是 P{id}，請寫一句 20-40 字的預發言草稿（不超過 40 字）。
這是候選草稿，稍後可能被選中展開。圍繞當前局勢，提出一個值得討論的點。
格式：P{id}：「你的草稿」
```

### 5.2 buildJudgePrompt（裁判，全盲）

```typescript
export function buildJudgePrompt(
  daySummary: string,
  preSpeeches: { slot: number; text: string }[],  // 已打亂、匿名（slot 1..N）
): string;
```

組裝：

1. 當天摘要（公開資訊）
2. N 則預發言（打亂順序、以「1.」「2.」…標號，**不含 P 編號**）
3. 評分指令

評分指令範例：

```
【裁判任務】以下是 {N} 位玩家的候選發言（順序已打亂，匿名）。
請針對每一則以 0-10 整數評分，考量三個面向：
- 新資訊：是否帶來討論中尚未出現的資訊
- 相關性：是否緊扣當前局勢
- 推進力：是否能推動討論前進
輸出格式（每行一則，嚴格遵守）：
1: 7
2: 5
...
```

### 5.3 buildExpandPrompt（展開完整發言）

```typescript
export function buildExpandPrompt(state: GameState, playerId: number, preSpeech: string): string;
```

= buildPrompt(state, playerId, 'speech') + 附加：

```
【你的預發言草稿】{preSpeech}
你可以沿用或修改這則草稿，展開成完整發言（30-60 字）。
```

---

## 6. novelty.ts：新穎性懲罰（純函式）

```typescript
/** 字元 bigram Jaccard 相似度 [0,1] */
export function bigramJaccard(a: string, b: string): number;

/** P 編號重疊率 [0,1]（兩者皆無 P 編號 → 0） */
export function pNumberOverlap(a: string, b: string): number;

/** 綜合相似度 = 0.7 × bigramJaccard + 0.3 × pNumberOverlap */
export function similarity(a: string, b: string): number;

/** 新穎性懲罰 = min(3, 5 × maxSim)，maxSim 對 recentMessages 取最大 */
export function noveltyPenalty(text: string, recentMessages: string[]): number;
```

演算法細節：

- **bigramJaccard**：字元 bigram 集合；Jaccard = |A∩B| / |A∪B|；任一為空 → 0
- **pNumberOverlap**：`/P(\d+)/g` 提取兩邊 P 編號集合；重疊 = |∩| / |∪|；兩邊皆空 → 0
- **recentMessages**：當天討論最後 2-3 則（不含本次管線產出）
- **懲罰範圍 [0, 3]**

---

## 7. worker.ts：LLM worker thread

### 7.1 職責

- 單一 worker 載入一份模型（node-llama-cpp）
- context 池（預設 3 個平行 context），有限平行處理所有 AI 請求
- 與主進程以 postMessage 通訊（協定見 §3.2）
- 崩潰由主進程偵測並重啟（worker 自身不需自我恢復邏輯）

### 7.2 結構

```typescript
// worker.ts（worker_threads 入口；tsc 編譯為 dist/worker.js）
import { parentPort } from 'worker_threads';
import { getLlama, LlamaChatSession, QwenChatWrapper } from 'node-llama-cpp';
import { MockProvider } from './llm.js';

interface ContextSlot {
  session: LlamaChatSession;
  busy: boolean;
}

let slots: ContextSlot[] = [];
let queue: WorkerJob[] = [];
let provider: MockProvider | null = null;  // mock 模式

// INIT → 建立 context 池 → postMessage READY
// JOB → 有空 slot 立即執行，否則排隊（FIFO）；完成 → RESULT
// SHUTDOWN → 清理 → process.exit(0)
```

### 7.3 平行度

- `contextCount`（預設 3，env LLM_WORKER_CONTEXTS）個 context，各配一個 LlamaChatSession（QwenChatWrapper variation '3'）
- 每個 context contextSize = 8192（沿用 Phase 0）
- JOB 到達：找空 slot → 執行；全忙 → 排隊（FIFO）
- **記憶體注意**：Qwen3-4B Q4_K_M 權重約 2.5GB + 每 context KV cache 約 1-2GB；3 context 約 6-9GB。低記憶體機器可設 LLM_WORKER_CONTEXTS=1

### 7.4 Mock 模式

- worker 啟動時讀 `process.env.LLM_PROVIDER === 'mock'` → 不載入模型，用 MockProvider（確定性文字）
- 供 worker 通訊測試與開發用

### 7.5 錯誤處理

- 單一 job 推理失敗 → RESULT { ok: false, error }
- 模型載入失敗 → postMessage { type: 'LOG', level: 'error' } + process.exit(1)（主進程偵測 exit → 重啟；重啟仍失敗 → 主進程進入錯誤狀態，通知前端）

---

## 8. worker-dispatcher.ts：WorkerDispatcher

### 8.1 職責

- 實作 LLMDispatcher（含 generate）
- 管理 worker 生命週期：spawn、READY 等待、崩潰偵測、重啟
- job 佇列與 pending map、崩潰時重試（≤2 次）

### 8.2 介面

```typescript
export interface WorkerDispatcherOptions {
  modelPath: string;
  contextSize?: number;      // 預設 8192
  contextCount?: number;     // 預設 3（env LLM_WORKER_CONTEXTS）
  maxRetries?: number;       // 預設 2
}

export class WorkerDispatcher implements LLMDispatcher {
  constructor(options: WorkerDispatcherOptions);
  start(): Promise<void>;                    // spawn worker + 等 READY
  generate(prompt: string, config?: GenerationConfig): Promise<string>;
  requestSpeech(playerId: number, prompt: string): Promise<{ text: string }>;
  requestVote(playerId: number, prompt: string): Promise<{ targetId: number }>;
  requestNightAction(playerId: number, prompt: string): Promise<{ targetId: number }>;
  shutdown(): Promise<void>;                 // SHUTDOWN + terminate
  isHealthy(): boolean;
}
```

### 8.3 內部流程

```
generate(prompt, config):
  jobId = crypto.randomUUID()
  post JOB → worker
  pending.set(jobId, { resolve, reject, job, retries: 0 })
  → 等待 RESULT

onMessage:
  READY → resolve start()
  RESULT ok → pending.get(jobId).resolve(text)
  RESULT !ok → reject

onExit:
  worker 崩潰 → 所有 pending reject('worker crashed')
  → 重啟 worker（start()）
  → READY 後：retries < maxRetries 的 job 重新 post（retries++）
  → 超過 maxRetries → 維持 reject（engine 視為行動放棄）
```

### 8.4 輸出解析

```typescript
/** 取文字中最後一個 P{編號}；無 → throw */
function parseTargetId(text: string): number;
```

- requestVote / requestNightAction：`parseTargetId(text)` → { targetId }
- requestSpeech：text.trim() → { text }
- generate：text.trim() 原樣回傳

---

## 9. ai-scheduler.ts：SpeechScheduler（發言選擇機制）

### 9.1 職責

- 實作 AIScheduler（onPhaseEntered / onBoardUpdated）
- 驅動白天討論的發言選擇管線（預發言 → 裁判 → 新穎性懲罰 → top3 → 展開 → 廣播）
- 管理 CD / 安靜門檻計時

### 9.2 介面

```typescript
export interface SpeechSchedulerOptions {
  cdMs?: number;               // 預設 60000
  quietMs?: number;            // 預設 20000
  checkIntervalMs?: number;    // 預設 1000（觸發檢查）
  preSpeechBatch?: number;     // 預設 3（平行預發言數，≤ worker contextCount）
  preSpeechTemp?: number;      // 預設 0.7
  judgeTemp?: number;          // 預設 0.3
  expandTemp?: number;         // 預設 0.8
  topK?: number;               // 預設 3
  recentCompareCount?: number; // 預設 3（新穎性比較的最近訊息數）
}

export class SpeechScheduler implements AIScheduler {
  constructor(ctx: SchedulerContext, options?: SpeechSchedulerOptions);
  onPhaseEntered(state: GameState): void;
  onBoardUpdated(state: GameState): void;
  stop(): void;   // 清除 timer（server 關閉時）
}
```

### 9.3 時間軸（已確認設計）

```
t=0    最後訊息（任何人發言）
t=20   安靜門檻通過（20s 無新訊息）→ 預發言管線啟動（可作廢）
t=60   CD 結束（60s 內無新訊息）→ 裁判評分
t=75+  新穎性懲罰 + top3 隨機 → 展開完整發言
       → 廣播（保證 ≥ CD 60s 距最後訊息）
```

- 觸發檢查：`checkIntervalMs`（1s）間隔檢查 `now - lastMessageTime`
- `lastMessageTime` 更新時機：
  - DAY_DISCUSSION_OPEN phase entry → now
  - scheduler 廣播 AI_SPEECH_DONE 後 → now
  - onBoardUpdated 偵測到 boardVersion 變更（他人發言）→ now
- 管線為**事件驅動**：各階段完成即推進；時間為估計值，非硬性 deadline

### 9.4 管線狀態機

```
IDLE
  │ 觸發（quiet 通過）
  ▼
PRE_SPEECH（存活 AI 分批 preSpeechBatch 平行，buildPreSpeechPrompt）
  │ 全部完成 → 檢查版本
  ▼
JUDGE（1 次呼叫，buildJudgePrompt，temp 0.3）
  │ 完成 → 檢查版本
  ▼
SELECT（新穎性懲罰 + top3 隨機）→ commit（記錄 boardVersion）
  ▼
EXPAND（選中者，buildExpandPrompt，temp 0.8）
  │ 完成
  ▼
BROADCAST（enqueue AI_SPEECH_DONE，帶 commit 時 boardVersion）
  ▼
IDLE
```

- **版本檢查**：PRE_SPEECH / JUDGE 完成時，`getState().boardVersion !== pipelineStartVersion` → 作廢，回 IDLE（重新計時）
- **SELECT 之後 commit**：不再作廢；EXPAND 跑完後 enqueue AI_SPEECH_DONE 帶 commit 時版本；若期間版本變更，engine 既有機制丟棄（accepted: false）
- 任何階段收到 onPhaseEntered（非 DAY_DISCUSSION_OPEN）→ 取消管線、清 timer、回 IDLE

### 9.5 預發言批次

- 存活 AI 全部參與（15 人局 = 15 則）
- 每批 `preSpeechBatch`（3）個平行 generate（temp 0.7, maxTokens 100）
- 失敗的預發言：重試 1 次；仍失敗 → 該玩家不參與本次評選（記 log）

### 9.6 裁判

- 1 次 generate（temp 0.3, maxTokens 300）
- 輸入：buildJudgePrompt（當天摘要 + 打亂匿名預發言）
- 輸出解析：`/^(\d+)\s*[:：]\s*(\d+)$/gm` 逐行解析
  - 解析失敗的 slot → 5 分（中性）
  - 解析率 < 50% → 放棄評分，全部視為同分（回歸 top3 隨機）

### 9.7 新穎性懲罰與選取

```
for each (slot, score):
  final = score - noveltyPenalty(preSpeech, recentMessages)   // min(3, 5×sim)
top3 = final 最高的 3 個（不足 3 個則全部）
winner = top3 隨機選一
```

- recentMessages = 當天 discussionLog 最後 N 則（不含本次管線產出）
- **特例**：存活 AI ≤ 2 → 跳過管線，直接隨機選一展開（省 17 次 LLM 呼叫）

### 9.8 onPhaseEntered 行為

| phase | 行為 |
|---|---|
| DAY_DISCUSSION_OPEN | lastMessageTime = now；開始觸發檢查 |
| DAY_DISCUSSION_CLOSING | 取消管線、清 timer、回 IDLE |
| NIGHT_COLLECTING / NIGHT_RESOLVING / DAY_VOTING_* / DAY_RESULT_ANNOUNCING | 取消管線、清 timer、回 IDLE |
| GAME_OVER_FINAL | stop() |

### 9.9 投票 / 夜間行動

- 不需要版本檢查：進入 CLOSING / COLLECTING 時討論已關閉，由 engine 既有 DISPATCH_LLM 機制處理（scheduler 不介入）

---

## 10. engine.ts：registry 擴充

```typescript
private broadcastSnapshots(): void {
  const registry = this.options.registry;
  if (!registry) return;
  for (const pid of registry.getConnectedPlayerIds()) {
    try { registry.send(pid, buildPlayerSnapshot(this.state, pid)); } catch {}
  }
  if (registry.hasSpectators?.()) {
    try { registry.sendSpectator?.(buildSpectatorSnapshot(this.state)); } catch {}
  }
}
```

- 其餘 engine 邏輯不變（scheduler 存在時 DAY_DISCUSSION_OPEN 由 scheduler 驅動）

---

## 11. server.ts：HTTP + WebSocket + 生命週期

### 11.1 啟動流程

```
main():
  1. 建立 HTTP server（靜態 public/）+ WebSocket server（ws，掛在 HTTP server 上）
  2. 檢查模型（isModelDownloaded）
  3. 若缺模型：
     a. 背景啟動 ensureModelDownloaded(onProgress → 廣播 MODEL_STATUS)
     b. 開瀏覽器 → /download.html
     c. 下載完成 → 廣播 MODEL_STATUS ready → 繼續步驟 4
  4. 若模型就緒：
     a. spawn WorkerDispatcher（start() 等 READY）
     b. 建立 engine（mode 'web'）+ SpeechScheduler + WebSocketRegistry
     c. enqueue CLIENT_JOIN × PLAYER_COUNT + START_GAME
     d. 開瀏覽器 → /
  5. 安裝關閉機制（SIGINT/SIGTERM/LEAVE/零連線）
```

### 11.2 模型檢查

```typescript
function modelFileName(modelUri: string): string;
// 'hf:Qwen/Qwen3-4B-GGUF:Qwen3-4B-Q4_K_M.gguf' → 'Qwen3-4B-Q4_K_M.gguf'
// 註：需與 node-llama-cpp resolveModelFile 的實際檔名對齊（實作時 spike 驗證）

function isModelDownloaded(modelUri: string, modelsDir: string): boolean;
// fs.existsSync(path.join(modelsDir, modelFileName(modelUri)))
```

### 11.3 靜態檔案伺服

```typescript
function serveStatic(req, res, publicDir): void;
```

- GET / → index.html；其餘路徑對應 public/ 下檔案
- 路徑穿越防護：path.resolve 後確認以 publicDir 為前綴，否則 404
- MIME map：html / css / js / json / png / svg / ico / woff2
- 模型未就緒時 GET / → 302 到 /download.html

### 11.4 WebSocketRegistry（實作 ClientRegistry）

```typescript
class WebSocketRegistry implements ClientRegistry {
  constructor(wss: WebSocketServer, getState: () => GameState);
  getConnectedPlayerIds(): number[];   // Phase 1 回傳 []（無真人玩家）
  send(playerId, snapshot): void;      // Phase 1 不使用（預留 Phase 2）
  sendSpectator(snapshot: SpectatorSnapshot): void;
  hasSpectators(): boolean;
  // 內部：client 連線管理、gmView flag、ping/pong、LEAVE 處理
}
```

- **sendSpectator**：對每個連線 client 送 `{ type: 'SNAPSHOT', snapshot: client.gmView ? buildGMSnapshot(getState()) : snapshot, gmView: client.gmView }`
- **ping/pong**：每 PING_INTERVAL_MS 送 PING；PING_TIMEOUT_MS 內無 PONG → terminate
- **訊息處理**：
  - PONG → 更新 lastPong
  - SET_GM_VIEW → 更新 client.gmView，立即重送 snapshot
  - REQUEST_SNAPSHOT → 立即重送 snapshot
  - LEAVE → 關閉連線；若為最後一個 client → shutdown('leave')
- **連線/斷線計數**：0 → 啟動 ZERO_CLIENT_SHUTDOWN_MS timer；>0 → 取消

### 11.5 自動找 port

```typescript
async function findAvailablePort(start: number): Promise<number>;
// 從 3000 起，依序嘗試 listen；被佔用 → +1，最多試 10 個
```

### 11.6 開瀏覽器（Windows）

```typescript
function openBrowser(url: string): void;
// child_process.exec(`start "" "${url}"`)   // cmd builtin
// 失敗時靜默（console 提示手動開啟）
```

### 11.7 關閉機制

| 觸發 | 行為 |
|---|---|
| 離開按鈕（LEAVE，最後 client） | 立即 shutdown('leave') |
| WebSocket 斷線 / ping 超時 | 若 0 client → 啟動 10 分鐘 timer；期間重連 → 取消 |
| 零連線 10 分鐘 | shutdown('no-clients') |
| SIGINT / SIGTERM | shutdown('signal') |

```
shutdown(reason):
  1. console.log 原因
  2. engine.save()（flush）
  3. scheduler.stop()
  4. dispatcher.shutdown()（SHUTDOWN → terminate）
  5. engine.close()
  6. wss.close()（關閉所有 client）
  7. httpServer.close()
  8. process.exit(0)
```

### 11.8 遊戲自動推進

- 全 AI 局：CLOSING 無真人 → transition 自動開投票 gate（Phase 0 已實作）
- 夜晚/投票 gate：web 模式有限 timeout（90s/60s）→ 不會卡死
- 遊戲結束（GAME_OVER_FINAL）→ 廣播最終 snapshot → 維持 server 運作（觀戰可看結局）→ 依關閉機制結束

---

## 12. public/：瀏覽器介面

### 12.1 檔案結構

```
public/
  index.html       觀戰主頁
  download.html    模型下載頁
  css/style.css    共用樣式
  js/main.js       觀戰邏輯
  js/download.js   下載頁邏輯
```

### 12.2 index.html 版面

```
<header>
  人狼遊戲（全 AI 對戰）
  狀態列：第 X 天 | 階段 | 連線狀態
  [GM 檢視] 切換 | [離開] 按鈕
</header>
<main>
  <section id="board">       白板（事件流，即時更新）
  <aside>
    <section id="players">   玩家列表（存活/死亡）
    <section id="controls">  動作區（Phase 2 預留，Phase 1 隱藏）
  </aside>
</main>
<div id="disconnect-overlay"> 斷線提示（含重連狀態）
```

### 12.3 main.js 行為

```
connect():
  ws = new WebSocket(`ws://${location.host}`)
  onmessage:
    SNAPSHOT → render(snapshot)
    PING → 回 PONG
    SHUTDOWN → 顯示「伺服器已關閉」
    MODEL_STATUS → 忽略（主頁不處理）
  onclose → 顯示斷線 overlay，指數重連（1s, 2s, 4s, ... 上限 30s）

render(snapshot):
  白板：discussionLog（P{id}：text）+ nightResult + 死亡公告 + 投票結果 + 勝負
  玩家列表：存活（綠）/ 死亡（灰，含死因）
  狀態列：第 {day} 天 | {phaseLabel} | 連線狀態

GM 檢視切換 → 送 SET_GM_VIEW → 收到含角色資訊的 snapshot → 玩家列表顯示角色
離開按鈕 → 送 LEAVE → 顯示「已離開，可關閉此分頁」→ 關閉 ws
```

### 12.4 download.html / download.js

```
connect → 等 MODEL_STATUS
MODEL_STATUS downloading → 進度條（downloaded/total MB + %）
MODEL_STATUS ready → 顯示「模型就緒」→ 2s 後 location.href = '/'
MODEL_STATUS error → 顯示錯誤訊息 + 重試按鈕（重新整理）
```

### 12.5 Phase 對照表

```
SETUP_WAITING_JOIN: 等待玩家加入
SETUP_READY: 準備開始
NIGHT_COLLECTING: 夜晚（行動中）
NIGHT_RESOLVING: 夜晚結算
DAY_DISCUSSION_OPEN: 白天討論
DAY_DISCUSSION_CLOSING: 討論收尾
DAY_VOTING_COLLECTING: 投票中
DAY_VOTING_RESOLVING: 投票結算
DAY_RESULT_ANNOUNCING: 公布結果
GAME_OVER_FINAL: 遊戲結束
```

### 12.6 Phase 2 預留

- `#controls` 區塊：CSS `display: none`，結構保留（發言輸入框、跳過/準備投票/投票按鈕、夜間行動選擇）
- 版面以 flex 兩欄設計：左白板、右側欄；側欄下方預留動作區高度

---

## 13. 測試規格

框架：node:test + node:assert（沿用）

### 13.1 worker.test.ts（worker 通訊）

- spawn worker（env LLM_PROVIDER=mock）→ 等 READY
- 送 JOB（speech）→ 收到 RESULT ok，文字非空
- 送多個 JOB → 依序完成（序列化）
- 送 JOB 後 terminate worker → pending reject → 重啟 → 重試成功
- SHUTDOWN → worker exit

### 13.2 ai-scheduler.test.ts

- novelty：bigramJaccard（相同→1、無關→低）、pNumberOverlap、penalty 範圍 [0,3]
- 觸發：fake timers 驗證 quiet 通過 → 管線啟動；CD 內不廣播
- 版本作廢：PRE_SPEECH 完成前 boardVersion 變更 → 管線作廢回 IDLE
- 版本作廢：JUDGE 完成前 boardVersion 變更 → 作廢
- commit 後不中斷：EXPAND 期間版本變更 → AI_SPEECH_DONE 照常 enqueue（帶 commit 版本）
- top3：mock 裁判分數 → 選取落在 top3
- 新穎性懲罰：重複內容被降分
- 存活 AI ≤ 2 → 跳過管線直接展開
- 完整管線：mock LLM（預發言/裁判/展開皆確定性）→ 最終 enqueue 正確 AI_SPEECH_DONE

### 13.3 server.test.ts

- 靜態檔案：GET / → 200 index.html；GET /css/style.css → 200；路徑穿越 → 404
- WS 連線 → 收到 SNAPSHOT
- SET_GM_VIEW → 收到含角色的 snapshot
- 斷線 → 0 client → 啟動兜底 timer（fake timers 驗證）
- LEAVE → shutdown（server close 事件）
- ping 超時 → 連線被 terminate

### 13.4 full-game.test.ts（完整局）

- 用 engine（mode 'web'）+ SpeechScheduler + ScriptedDispatcher（啟發式，同 ScriptedGM 邏輯）+ 假 registry
- 從 CLIENT_JOIN × 9 → START_GAME → 跑到 gameOver
- 斷言：gameOver = true、winner 非 null、無例外、步驟數 < 上限
- 驗證 scheduler 全程參與（發言皆經管線）

### 13.5 既有測試更新

- engine.test.ts：mock LLMDispatcher 需補 generate()（介面擴充）
- 其餘 Phase 0 測試不動

---

## 14. 實作順序與驗收標準

| 步驟 | 檔案 | 驗收標準 |
|---|---|---|
| 1 | types.ts 擴充 | 編譯通過；既有測試 mock 補 generate |
| 2 | game-state.ts（buildSpectatorSnapshot） | snapshot.test.ts 新增觀戰者案例全綠 |
| 3 | character-session.ts（預發言/裁判/展開 prompt） | 單元測試：內容含預期段落、預發言 ≤ 3000 字元 |
| 4 | novelty.ts | 純函式測試全綠（邊界：空字串、無 P 編號） |
| 5 | worker.ts | worker.test.ts 通訊測試全綠（mock 模式） |
| 6 | worker-dispatcher.ts | 崩潰重啟/重試測試全綠 |
| 7 | ai-scheduler.ts | ai-scheduler.test.ts 全綠（fake timers） |
| 8 | engine.ts（registry 擴充） | 既有 engine.test.ts 仍全綠 |
| 9 | server.ts | server.test.ts 全綠；手動：npm start 開瀏覽器 |
| 10 | public/ | 手動驗證：觀戰即時更新、GM 檢視、離開按鈕、斷線 overlay |
| 11 | 測試收尾 | npm test 全綠（8 檔） |
| 12 | 完整局手動驗證 | npm start → 全 AI 局跑完（含模型下載流程） |

---

## 附錄 A：不可違反的不變式

1. **單一 worker**：所有 LLM 呼叫經 worker（context 池有限平行）；主進程永不直接載入模型
2. **worker 崩潰 → 主邏輯存活**：自動重啟、pending job 重試 ≤2 次；超過 → 該行動放棄（engine 既有機制）
3. **版本檢查**：預發言/裁判階段 boardVersion 變更 → 作廢重排；展開 commit 後不中斷（AI_SPEECH_DONE 帶 commit 版本，engine 丟棄過期）
4. **觀戰 snapshot 永不洩漏角色**：SpectatorSnapshot 無 you；GM view 需 client 明確請求
5. **裁判全盲**：只看到當天摘要 + 打亂匿名預發言；看不到身分、P 編號、完整討論
6. **新穎性懲罰範圍 [0, 3]**：min(3, 5×sim)，sim = 0.7×bigram Jaccard + 0.3×P 編號重疊
7. **平票 = 無人出局**（沿用 Phase 0）
8. **全 AI 局自動推進**：CLOSING 無真人 → 直接開投票 gate（沿用）
9. **關閉機制**：LEAVE（最後 client）→ 立即關閉；斷線/ping 超時 → 10 分鐘兜底；SIGINT/SIGTERM → 關閉
10. **存檔原子寫入**（沿用 Phase 0）
11. **發言廣播保證 ≥ CD 60s** 距最後訊息

## 附錄 B：Phase 2 預留接口（本階段不實作）

- **真人加入**：ClientRegistry.send / getConnectedPlayerIds 已預留；前端 #controls 區塊已預留
- **真人操作事件**：HUMAN_SPEAK / HUMAN_SKIP / HUMAN_READY_VOTE / HUMAN_UNREADY_VOTE / HUMAN_VOTE / HUMAN_NIGHT_ACTION 已存在於 GameEvent
- **多準則裁判（v1.5）**：buildJudgePrompt 擴充為 3 指令 Borda 聚合；SpeechScheduler 的 JUDGE 階段預留多呼叫結構
- **pkg 打包**：node-llama-cpp native binding 需 spike；Plan B = llama-server.exe sidecar + OpenAICompatibleProvider