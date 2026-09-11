# 外部累積方案 — 實作交接文件

> 本文件是研究/可行性對話的產出，供另一個對話直接據以實作。
> 範圍：讓 AI「越玩越強」（外部累積，無後訓練）。本對話不做專案實作。

---

## 1. 背景與目標

- **目標**：AI 玩越多局越擅長狼人殺（勝率曲線隨局數上升），**只靠外部累積，不做後訓練**。
- **產品情境**：公開遊戲、玩家拿到單一 exe。**不回收玩家資料** — 沉澱由開發者自己跑 self-play 完成。冷啟動解法：開發期沉澱的策略庫直接包進 exe（策略庫是文字檔，與 `agents.md`/`memory.md` 同機制，`getResourceRoot()` 已處理 pkg 環境，零額外下載）。
- **研究結論（已定案）**：
  - Qwen3-4B 夠當基底（文獻：小模型 + 外部結構勝大模型）；「越玩越強」必須靠外部累積或後訓練，模型本身不會學。
  - 外部累積能滿足目標，但有天花板：context 預算、推理非知識遊戲、雜訊累積。緩解：統計驗證 + 版本化 A/B。
  - 對大眾遊戲，「AI 越強」的目標是「AI 越像真人、越好玩」，勝率是次要指標（研究代理指標）。

---

## 2. 引擎現況（實作者必讀）

### 2.1 檔案地圖

| 檔案 | 職責 |
|------|------|
| `src/types.ts` | 正典型別：`GameState`、`Player`、`Role`/`Team`（enum）、`LLMDispatcher`、`ROLE_CONFIG`、`SCHEMA_VERSION=3` |
| `src/engine.ts` | `GameEngine`：事件佇列 `enqueue`/`drain`、`dispatchLLM`（建 prompt → 呼叫 dispatcher → 提交事件）、gate timer、phase entry 副作用 |
| `src/game-state.ts` | `transition(state, event)` 純函式狀態機、`createGameState`、`saveState`/`loadState`、`buildPlayerSnapshot`/`buildGMSnapshot` |
| `src/ai-scheduler.ts` | `SpeechScheduler`：發言管線 PRE_SPEECH → JUDGE → SELECT（新穎性懲罰 + top3 隨機）→ EXPAND → BROADCAST |
| `src/character-session.ts` | `buildPrompt(state, playerId, kind, budget=8000)`、`buildPreSpeechPrompt`（3000 預算）、`buildJudgePrompt`、`buildExpandPrompt`、`summarizeDay` |
| `src/ai.ts` | `buildPublicKnowledge`（宣稱 Map 目前全空 — 引擎未追蹤宣稱）、`computeReasoningContext`（嫌疑分數雛形）、`parseAccusatoryIds`（指控解析先例）、`AIPlayer`（啟發式） |
| `src/assignment.ts` | `assignRolesToPlayers`（角色分配，用 `shuffleArray`）、`getAlivePlayers`/`getAliveWerewolves` |
| `src/utils.ts` | `shuffleArray`/`randomInt`/`pickRandom`（**全部流經 `Math.random`**）、`getResourceRoot`、`getDataDir` |
| `src/llm.ts` | `LLMProvider` 抽象、`createProvider`（env `LLM_PROVIDER`：mock/llamacpp/openai-compatible）、`MockProvider` |
| `src/llm-dispatcher.ts` | `OpenAICompatibleDispatcher`、`MockDispatcher`（實作 `LLMDispatcher`） |
| `src/full-game.test.ts` | **跑局範本**：web mode + SpeechScheduler + 啟發式 dispatcher 跑完整局到 gameOver |
| `scripts/driver.mjs` | CLI 入口範本（呼叫 dist/ 編譯產物）；`mock-test` 是 gm mode 啟發式跑局 |
| `scripts/build-pkg.mjs` | exe 打包（資源內建機制已存在） |

### 2.2 關鍵介面

```ts
// LLMDispatcher（A/B 實驗的接縫）
interface LLMDispatcher {
  requestSpeech(playerId: number, prompt: string): Promise<{ text: string }>;
  requestVote(playerId: number, prompt: string): Promise<{ targetId: number }>;
  requestNightAction(playerId: number, prompt: string): Promise<{ targetId: number }>;
  generate(prompt: string, config?: GenerationConfig): Promise<string>;  // scheduler 用
}
```

- engine 的 `dispatchLLM` 負責建 vote/night prompt（`buildPrompt(state, playerId, kind)`）再傳給 dispatcher。
- scheduler 自行建 pre-speech/judge/expand prompt 並呼叫 `llm.generate(prompt)`。
- `SpeechScheduler` 選項：`cdMs`(60000)、`quietMs`(20000)、`checkIntervalMs`(1000)、`preSpeechBatch`(3)、`preSpeechTemp`(0.7)、`judgeTemp`(0.3)、`expandTemp`(0.8)、`topK`(3)、`recentCompareCount`(3)。

### 2.3 跑局範本（full-game.test.ts 模式）

```
new GameEngine({ mode: 'web', llm: dispatcher, scheduler, registry? }, createGameState(playerCount))
  → enqueue CLIENT_JOIN × playerCount → START_GAME → drain
  → loop: sleep(10) + drain
  → DAY_DISCUSSION_OPEN 時，當天發言數 ≥ 門檻 → CLOSE_DISCUSSION + drain
  → 直到 gameOver 或 maxSteps
```

- registry 可省略（engine 處理 undefined）。
- scheduler 用快速計時：`{ quietMs: 15, cdMs: 30, checkIntervalMs: 5 }`。

### 2.4 隨機性來源（seed 可重現的關鍵）

**所有隨機性都流經 `Math.random()`**：`shuffleArray`（角色分配、slot 打亂）、`randomInt`/`pickRandom`（投票、嫌疑分數）、scheduler 的 top3 隨機選。因此跑局期間替換 `Math.random` 為 seed PRNG，整局即確定性。

### 2.5 敏感度鐵則（GM_GUIDE.md，務必遵守）

| 等級 | 內容 | 主 session 可否直做 |
|------|------|---------------------|
| L2 | `game-state.json`、角色指派 | ❌ 永不直做，委派 fixer |
| L1 | `character/*/memory.md`、夜晚明細 | ❌ 永不直做，委派 fixer |
| L1-a | 多 persona 批量生成/集中代寫 | ❌ 禁止 |
| L0 | `character/game-public.md`、`state --public` | ✅ 可直做 |

- **benchmark replay JSON 含完整角色資訊 → 視同 L2**，主 session 不直接讀，分析委派 fixer。

---

## 3. 總體架構

四層研究儀器（全部 additive，**引擎核心零改動**）：

```
M0 benchmark 競技場（測量地基）
M1 replay 分析管線（事件偵測 + 統計）
M2 首次外部累積迴圈（self-play → 統計 → 草稿 → 審查 → KB v1）
M3 A/B 驗證（有 KB vs 無 KB）
M4 迭代（更多局 → 更豐富 KB → 勝率曲線）
```

外部累積迴圈：

```
帶目前 KB 跑 self-play → replay 分析 → 統計驗證 → 規則草稿 → 人工審查
      ↑                                                        ↓
      └────────────── A/B 驗證 ← 更新 KB 新版 ←────────────────┘
```

**關鍵原則**：每代遊戲都帶「目前版本」的 KB 跑 — 經驗反映現況。基線（KB v0 = 無策略）是對照組。

---

## 4. 里程碑與規格

### M0：benchmark 競技場

**新增檔案**：`src/benchmark.ts`、`scripts/benchmark.mjs`、`src/benchmark.test.ts`

**SeededRandom**：
- mulberry32 PRNG（32-bit 確定性）。
- `withSeed(seed, fn)`：暫存 `Math.random` → 換成 seed PRNG → 執行 → 還原。
- 每局 seed = `seedBase + gameIndex`，整個競技場可重現。

**runSingleGame**：
```ts
runSingleGame({ playerCount, seed, dispatcher, discussionTarget?, maxSteps?, schedulerOptions? })
  → GameResult
```
- 依 2.3 跑局範本實作。
- `discussionTarget` 預設 = 存活人數（每人一天一發言）。
- `maxSteps` 預設 2000。
- `schedulerOptions` 預設快速計時（quietMs:15, cdMs:30, checkIntervalMs:5）。
- **GameResult = 終局 GameState + seed + steps**（GameState 本身就是 replay：discussionLog、votes、deathHistory、角色全在裡面，不複製欄位）。

**runTournament**：
```ts
runTournament({ playerCount, games, seedBase, dispatcherFactory, replayDir?, ... })
  → TournamentStats { games, villageWinRate, wolfWinRate, avgDays,
                      roleSurvivalRate, avgSpeechesPerGame, perGame }
```
- `dispatcherFactory: () => LLMDispatcher` — **A/B 接縫**（換 wrapper 即換實驗條件）。

**CLI**：
```
node scripts/benchmark.mjs --players 9 --games 20 --seed 1 --provider mock|llama-server [--discussion-target N]
```
- provider：`mock`（秒級，驗證 harness）/ `llama-server`（真模型 Qwen3-4B）。
- replay 存放：`data/benchmark/<run-id>/game-<seed>.json`；run-id = 時間戳 + 設定 hash（如 `20260908-1530-p9-g20-s1`）。

**驗收**：
- `npm test` 全過（含新 `benchmark.test.ts`）。
- `--provider mock --games 20 --seed 1` 出統計表。
- **同指令跑兩次 → 統計完全一致**（seed 可重現證明）。
- replay 寫入 `data/benchmark/`。

### M1：replay 分析管線

**新增檔案**：`src/analysis/`（detectors + stats）

**宣稱偵測（含 high + medium 兩級信心）**：

角色關鍵字：
```
seer:   占卜 / 占い師 / 查驗 / 驗
medium: 靈能 / 靈媒
guard:  守衛 / 獵人 / 守護
mason:  共有
```

high（直接宣稱）：第一人稱標記 + 角色關鍵字
```
我是 / 我跳 / 我CO / 我才是 / 我其實是 / 我承認
例：「我是占卜」「我跳守衛」
```

medium（隱含宣稱）：角色行動動詞
```
seer:   我查驗了 / 我驗了 / 我昨晚查了 / 查驗結果是
medium: 我看到了票死 / 票死的是 / 靈能結果是
guard:  我守護了 / 我守了 / 我保了
mason:  我夥伴是 / 我搭檔是 / 我同伴是
```

守衛規則（排除假宣稱）：
```
否定：  沒 / 不 / 別（「我沒查驗」「我不守」）
假設：  如果 / 假設 / 要是 / 假如（「如果我是占卜我會查驗」）
轉述：  你查驗 / 他查驗（非第一人稱）
質疑：  你怎麼查驗 / 你憑什麼（不是宣稱）
```

**事件 schema**：
```ts
interface ClaimEvent {
  playerId: number;
  claimedRole: Role;
  day: number;
  speechIndex: number;   // discussionLog 索引
  confidence: 'high' | 'medium';
}
```

**統計項目（初始）** — 全部可從宣稱 + 結構化 state 算出：
1. 占卜宣稱率 + 宣稱時的村勝率 vs 未宣稱
2. 狼宣稱率（宣稱哪個角色）+ 狼勝率
3. 狂人宣稱占卜率 + 相關勝率
4. 對跳事件（同天同角色雙宣稱）→ 後續投票
5. 投票準確率（村投中狼比例）
6. 狼首殺目標（殺中占卜/守衛比例）
7. 各角色存活率

**信心分層**：high 與 medium **分開**算勝率相關性 — 驗證 medium 是訊號還是雜訊。若 medium 相關性與 high 一致 → 併入；相反 → 降權或剔除。

**驗收**：
- 分析工具吃 N 局 replay 出事件統計。
- 宣稱偵測對 **10 局手標樣本**做 precision/recall 報告。

### M2：首次外部累積迴圈

**KB 結構**（角色層共用 + 驗證分離）：
```
character/strategy/
├── seer.md / wolf.md / madman.md        ← 優先（策略主體）
├── villager.md / medium.md / guard.md / mason.md   ← 第二輪
└── meta.md                              ← 通用原則（票型、對跳偵測），第二輪

data/strategy-validation.json            ← 統計背書（開發者看，不注入）
```

**規則格式**（MD 內，乾淨、宣告式、模型無關）：
```json
// validation.json 每條規則的 evidence
{
  "id": "seer-001",
  "rule": "占卜驗到狼的當天應考慮公開身分",
  "role": "seer",
  "evidence": { "games": 45, "win_with": 0.62, "win_without": 0.38 },
  "status": "active"
}
```

**種子來源**：`docs/GM_GUIDE.md` 既有策略內容（人狼主動策略、狂人搗亂等）— 初始 KB 從人類既有知識起步，迴圈的工作是**驗證既有知識 + 發現新模式**。

**流程**：
1. 跑 100-300 局 self-play（帶 KB v0 = 無策略，先 mock 驗證管線再上真模型）。
2. M1 管線分析 → 統計顯著模式。
3. LLM 草稿規則文字 → **人工審查**（雜訊最後防線）→ 進庫。
4. 每條規則都有 validation.json evidence 條目。

**驗收**：
- KB v1 存在（seer/wolf/madman.md + validation.json）。
- **每條規則都有 evidence 條目**。
- 種子來自 GM_GUIDE 既有策略。

### M3：A/B 驗證

**方法**：同 seed 組兩場競技場 — control（無 wrapper）vs treatment（有 wrapper 注入 KB v1）。

**驗收**：
- 輸出勝率差異報告（村/狼勝率 + 各角色存活率）。
- 即使無顯著差異，報告本身即交付物（決定下一步：調整 KB / 換注入方案 / 更多局）。

### M4：迭代

- 更多 self-play 局 → 更豐富 KB → 追蹤**勝率曲線 vs KB 版本**（v0 基線 → v1 → v2…）。
- 每次 KB 變更**先 A/B 再採用**。
- 驗收：勝率曲線圖 + 每版變更的 A/B 報告。

---

## 5. 注入方案（已定案：方案 C）

**範圍**：決策點（vote/night）+ 發言管線（pre-speech/expand）注入；**judge 保持全盲**。

**新增檔案**：`src/strategy-injector.ts`（wrapper + provider）

```ts
class StrategyInjectingDispatcher implements LLMDispatcher {
  constructor(inner: LLMDispatcher, getState: () => GameState, strategy: StrategyProvider)
  // getState 綁定 engine（同 full-game.test.ts 的 let engine! 延遲綁定）
  // 角色查詢：getState().players.find(p => p.id === playerId)?.role
}
```

**prompt 種類偵測 + 注入決策表**：

| prompt 標記 | 種類 | 注入？ |
|------------|------|--------|
| 【裁判任務】 | judge | ❌ 保持全盲（群眾過濾器，不是策略家） |
| 【你的預發言草稿】 | pre-speech | ✅ 注入 |
| 【任務】+ 白天發言 | speech / expand | ✅ 注入 |
| 【任務】+ 投票 | vote | ✅ 注入 |
| 【任務】+ 今晚/夜晚 | night | ✅ 注入 |

**注入位置**：附加在 prompt 尾部的 `【策略指南】（角色：X）` 區塊，內容 = 該角色 playbook（`StrategyProvider.getPlaybook(role)` 讀 `character/strategy/<role>.md`，快取）。

**注意**：pre-speech 的 3000 字元預算檢查發生在 `buildPreSpeechPrompt` 內部，wrapper 注入在之後 → 注入內容不受預算檢查。playbook 保持精簡（幾百字）。

**A/B 開關**：`dispatcherFactory` 回傳 wrapper 或裸 dispatcher 即為實驗條件切換。

---

## 6. 關鍵設計決策（為什麼這樣做）

1. **wrapper 注入而非改引擎** — 引擎零改動；A/B 就是開關 wrapper。實驗成功後再考慮移進 `buildPrompt` 出廠。
2. **統計門檻** — 只收錄多局相關性顯著的規則；每條規則可回滾（版本化）。擋掉單局教訓與雜訊。
3. **角色層共用 + 人設層分開** — 狼人殺策略是角色導向的（占卜何時跳、狼怎麼切割），人設影響「怎麼說」不是「說什麼」。共用角色層資料效率最高；人設層（15 角色風格）是未來差異化，不在本方案範圍。
4. **規則與驗證分離** — 策略規則（語言層級）模型無關可轉移；驗證統計模型特定需重驗。換模型時規則庫存活當起點，用 benchmark 重跑 A/B 重驗。
5. **judge 保持盲** — 它是「哪則發言有趣」的群眾過濾器，不是策略家。注入會改變其角色。
6. **方案 C（pre-speech 也注入）** — 狼人殺的策略本質上發生在發言裡（宣稱、唬人），策略不進發言管線就等於沒策略。
7. **宣稱偵測分層（high/medium）** — 用資料驗證 medium 是訊號還是雜訊，不先猜。

---

## 7. 已知風險與緩解

| 風險 | 緩解 |
|------|------|
| self-play 收斂（AI 學自己的教訓 → 玩法狹窄） | 15 人設提供多樣性；scheduler 新穎性懲罰 + 溫度保持探索；統計驗證擋自我強化偏見 |
| 雜訊累積（反思迴圈提煉錯誤教訓） | 統計門檻（多局相關性）+ 人工審查 + 版本化回滾 |
| 4B 弱點（長上下文漂移、自相矛盾、過度相信宣稱） | 引擎已有 daySummaries 截斷 + 裁判管線；信念追蹤是後續層 |
| 換模型 | 規則庫可轉移；驗證統計需重跑 A/B |
| 注入使發言收斂（策略一致 → 草稿相似） | scheduler 新穎性懲罰機制已存在 |

---

## 8. 參考文獻與資源

- Wu 2024：6B + 外部 Thinker 模組勝過 GPT-4（Werewolf）
- GRAIL (2025)：因子圖 + LLM，小模型勝大模型（Avalon）
- MaKTO (NeurIPS 2025)：KTO 後訓練，對專家 61% 勝率
- WOLF benchmark (arXiv:2512.09187)：欺騙偵測、自相矛盾率
- MINDGAMES (2026)：勝率是壞指標
- `github.com/JuneQQQ/deepwolf`：benchmark + 貝氏信念 copilot
- `github.com/JJJayden-Yang/ai-werewolf`：信念追蹤 + replay + prompt 版本控制
- `github.com/wxhfy/AIwerewolf`：策略知識生命週期（外部累積先例）

---

## 9. 實作順序建議

1. M0 benchmark（mock 驗證 harness → 真模型基線）。
2. M1 分析管線（宣稱偵測 + 統計）。
3. M2 首次迴圈（100-300 局 → KB v1）。
4. M3 A/B 驗證。
5. M4 迭代。

真模型每局 2-5 分鐘，100 局約 3-8 小時，可過夜跑。