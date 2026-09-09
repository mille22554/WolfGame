# TODO — 待辦事項與分析紀錄

> 本文件記錄尚未實作的規劃與分析，供後續開發參考。
> 狀態：`[ ]` 未開始 / `[~]` 進行中 / `[x]` 已完成

---

## 1. [ ] 拔除 quiet 參數 + 修正純 AI 局白等 CD 60s 的 bug

### 問題
白天討論有兩個延遲，但只有一個是用戶要的：

| 延遲 | 位置 | 來源 | 決定 |
|------|------|------|------|
| **CD 60s** | `ai-scheduler.ts:56` (`cdMs`) | 用戶要的真人節奏（閱讀/打字時間） | 保留，但純 AI 局跳過（見下） |
| **quiet 20s** | `ai-scheduler.ts:57` (`quietMs`) | Phase 1 自帶預設（git 可查），用戶從沒要求過 | **整組拔除** |

quiet 當初設計是怕 AI 打斷正在打字的真人，但混合局裡真人靠按鈕發言/跳過，管線本來就在等真人動作，搶話場景不存在。沒人要、沒場景的參數，條件跳過不如整組刪除。

CD 的 bug 是真的：跳過條件 `allAliveHumansSkipped`（`game-state.ts:161-164`）要求「有真人且全部跳過」，**純 AI 局（無真人）時回傳 false**，導致每則發言白等 60s（有幾則浪費幾分鐘；日發言數由收斂機制決定，無硬上限，見第 2 項）。

### 修正方向
- **拔除 quiet**：刪 `quietMs`（scheduler 選項＋`QUIET_THRESHOLD_MS` env＋`tick` 內等待邏輯）、測試裡約十處構造一併簡化。
- **純 AI 局（無存活真人）** → 跳過 CD（修 `allAliveHumansSkipped` 調用處或函數本身）。
- **有真人** → CD 60s 原樣保留。

### 不改碼應急
設 `QUIET_THRESHOLD_MS=0` 即等於關掉 quiet（CD 的 bug 仍需修碼）。

### 相關檔案
- `src/ai-scheduler.ts`（`tick`、`broadcastAfterCd`、選項定義）
- `src/game-state.ts`（`allAliveHumansSkipped`）
- `src/ai-scheduler.test.ts`（約十處 `quietMs` 構造）

---

## 2. [ ] 設計並實作「AI 發言帶決策 flag」機制（取代 speechesPerDay 上限）

### 問題
目前純 AI 局討論靠 `speechesPerDay`（預設 6）強制結束（`server.ts:1360-1377`）。用戶認為這是錯誤設計：會在 AI 還沒收斂投票決定前就切斷討論，破壞遊戲。

### 用戶設計意圖
AI 發言回應應帶「決策 flag」，讓中控（SpeechScheduler）知道每個 AI 是否已準備投票：

1. **「目前資訊太少，我無法決定要棄票或投某人」** → 資訊不足，需繼續討論
2. **「目前資訊已足夠，我決定棄票/投XXX」** → 已準備好投票

當**所有存活玩家都 ready**（AI 有投票標的、真人已確認）時，討論自然收斂 → 直接進投票（不經 `CLOSING`）。

**關鍵限制**：flag 是給中控看的內部決策狀態，可夾在 pre-speech 草稿（內部未公開），但**不可寫入白板（discussionLog）**，否則洩漏投票意圖。

### Oracle 設計（已完成，待實作）

#### flag 格式
AI 在 pre-speech 草稿結尾附加：
```
[決定:投P3] / [決定:棄票] / [決定:資訊不足]
```
中控用 regex `/\[決定:(投P(\d+)|棄票|資訊不足)\]\s*$/` 解析（注意方括號必須跳脫，原 `[...]` 寫法只會匹配單一字元），剝離後才進 judge/expand，**flag 永不洩漏**。全形/半形冒號都要收；剝離用全域匹配（防中置 flag 殘留）；剝離點統一在收草稿回傳前，broadcast 前再洗一次 expand 輸出。

#### 統一 ready 機制（用戶調整：混合局 AI flag 視同真人準備投票）
新增事件 `AI_READY_VOTE { playerId }`，AI decided 時中控 enqueue，transition 把 AI 加入 `voteReady`。`allAliveHumansReady` 改名 `allAlivePlayersReady`，檢查**所有存活玩家**（真人 + AI）ready。`CLOSING` 整個拿掉（GM 喊關那條一起刪，從沒人用過）；混合局等真人用自由發言裡的統一檢查取代，全員齊直接進投票。

#### 草稿規則（用戶定案）
每輪除上輪發言者外全員寫草稿，中控挑一個上白板；人數無關，`runDirect` 特例刪除。

#### 安全閥（非任意上限）
連續 `maxUncertainRounds`（預設 100）次「資訊不足」→ 強制 `decided:abstain`。這裡的次是指同一 AI 連續幾次草稿，不是遊戲輪次。不要用死上限逼 AI 早決定，五次草稿資訊本來就不夠，一百純粹是防卡死的底線。解析分兩層：先正規解析，失敗走寬鬆二次解析（關鍵字兜底：抓到投 Pn pattern 認 decided；抓到不確定類詞認 uncertain；不用 LLM，避免本地成本）。都抓不到才計入資訊不足計數。安全閥只計真正的資訊不足，格式問題在解析層解決，不冤枉格式小錯的草稿。

#### 移除
- `server.ts:1360-1377` `autoCloseTimer`
- `speechesPerDay` 變數（`server.ts:770`）與 `ServerOptions`（`server.ts:62`）

### 變更檔案清單
| 檔案 | 變更 |
|------|------|
| `src/types.ts` | 加 `AI_READY_VOTE` 事件；`voteReady` 註解改「真人 + AI」 |
| `src/game-state.ts` | `allAlivePlayersReady`；`AI_READY_VOTE` handler；收斂直進投票（移除 `CLOSING` 階段與 `CLOSE_DISCUSSION` 路徑）；`applyReconnect` 移出 voteReady |
| `src/ai-scheduler.ts` | `AIDecision` 型別、`parseDecisionFlag`、`updateDecisions`、`checkConvergence`、`enqueueNewlyDecided`、`checkAllPlayersReady`；改 `collectPreSpeeches`/`runPipeline`/`runDirect`/`tick`/`onPhaseEntered` |
| `src/character-session.ts` | `buildPreSpeechPrompt` 任務指令加 flag 格式 |
| `src/server.ts` | 移除 `autoCloseTimer` + `speechesPerDay` |
| 測試 | `ai-scheduler.test.ts`、`server.test.ts`、`server-human.test.ts`、`full-game.test.ts`、`mixed-game.test.ts` |

### 設計決策（用戶已確認）
- flag 格式 OK
- 混合局：AI flag 視同玩家的準備投票（HUMAN_READY_VOTE）
- 安全閥 100（用戶定案：不要死上限逼決定；五次草稿資訊本來就不夠，一百純防卡死底線）
- flag 不綁定最終投票（投票階段仍重新決定）
- CLOSING 拿掉（含 GM 喊關），混合局等真人用統一檢查取代
- 草稿規則：除上輪發言者外全員寫草稿，中控挑一個上白板
- ready 單向不退名單，但投票標的每輪可變（新 flag 覆蓋）；管線照跑直到統一檢查全過（純 AI 全定了即投票）

### Oracle 複查結論（可做，但要改 6 處）
1. **無 flag／解析失敗也要計入安全閥**：否則模型不照格式吐時，純 AI 局永遠卡在討論（移除 speechesPerDay 後唯一的收斂保證，必須對任何輸出都有界）。
2. **regex 重寫**：跳脫方括號（已修正）＋全形/半形冒號都要收＋剝離用全域匹配（防中置 flag 殘留進白板洩漏投票意圖）。
3. **runDirect 對所有存活 AI 出草稿**：現況只給隨機一個 AI 出草稿，≤2 人時另一個永遠沒 flag → 卡死（只選一個展開即可）。
4. **CLOSING 競態**（已決議：CLOSING 整個拿掉，本條作廢）：原分析指 CLOSING 不收 AI_READY_VOTE、晚到的 ready 被拒會卡死；決議後無 CLOSING，改走自由發言裡的統一檢查，晚到的 ready 照收。
5. **AI_READY_VOTE 語義定死**：發言成功廣播後才 enqueue、不帶 boardVersion、decided 單向不反悔、全 decided 後管線停止空轉。
6. **expand 輸出也要清洗 flag**：模型可能自行輸出 flag，broadcast 前過一次 pattern（廉價保險）。剝離位置統一在 `collectPreSpeeches` 回傳前，不要各消費點各自剝離。

### 附帶建議
- 混合局真人不按 ready 會一直等（原來卡在 CLOSING，現改為在自由發言裡等）：等待加超時（`closingTimeoutMs` 接到統一等待上），或確認前端有 HUMAN_SKIP 逃生鈕。
- 本項依賴第 1 項先做：否則 5 輪收斂＝400 秒純白等，慢到不可用。
- 心理準備：純 AI 局一天可能跑 25-45 分鐘（收斂設計的代價）。

---

## 3. [ ] 玩家列表 AI 顯示格式

### 需求
GM 檢視玩家列表目前顯示 `P1 P1（villager）`，改成：
- **真人玩家**：`Pn + 暱稱（中文職業）`
- **AI 玩家**：`Pn + AI角色名（中文職業）`

### 現況
- `main.js:916-940` `playersHtml` GM 分支（`:926`）顯示 `P{id} {name}（{role}）`，role 是英文
- 中文職業名已有 `ROLE_DISPLAY` 對照表（`main.js:18-26`）
- AI 角色名 = `personality` 的 `name`（如「涼子」，`personalities.ts:64`），但 GM snapshot 只有 `personality` id，前端無對應表

### 待決
- AI 角色名對應：後端在 GM snapshot 加 personality 顯示名，或前端硬編碼對應表

---

## 4. [ ] GM 檢視顯示夜晚所有行動 + 對話紀錄

### 需求
GM 檢視（僅觀戰可點）除了玩家列表，也應顯示**夜晚所有行動 + 對話紀錄**。

### 現況（explorer 調查）
- 對話：後端有 `discussionLog`（含 day），GM snapshot 已有全量，但前端 `boardHtml` 只顯示當天、忽略 day
- 夜間行動：後端有三層資料，GM snapshot 一層都沒曝：
  - `nightActions`（當夜提交，`ADVANCE_DAY` 清空）
  - `seerChecks` / `guardProtects`（跨天累積）
  - `night.ts log[]`（文字紀錄，函數內丟棄）
- `masonChatLog`（共有者夜聊）：GM snapshot 完全未含

### 所需改動
**後端**（`game-state.ts:936-948` + `types.ts:259-269`）：擴 `GMSnapshot` 加 `nightActions`、`seerChecks`、`guardProtects`、`masonChatLog`。

**前端**（`main.js`）：`renderSpectator(snapshot, isGm)` 在 GM 時注入夜間行動區塊 + 對話區塊，按 day 分組顯示。

### 已知 bug（動工時一併檢查）
開啟 GM 檢視後，左側白板區塊只顯示一句等待遊戲開始，跟關閉 GM 檢視時看到的內容沒有同步。疑似 GM 分支短路了白板渲染，或 GM snapshot 缺了白板依賴的欄位。修到 GM 白板至少與一般視角同步（不倒退）為止。

---

## 5. [ ] 開局 / 角色行動慢 — 效能改善（調查完成，未套用）

### 機器與數據（兩台分開標）
- **內顯機（本機）**：i3-14100 4C/8T、32GB、UHD 730 無獨顯；模型 Qwen3-4B-Q4_K_M，CPU 推理；實測生成 **11.3 tok/s**（threads=8）。threads=4、thinking 洩漏、PARALLEL 對比皆未測。
- **3060 機（別台）**：RTX 3060（顯存待確認）；模型 gemma-3-4b-it-roleplay-tuned-v2.Q6_K；回報 4B 約 20-40 tok/s（測試條件待確認，GPU 跑 4B 照理更快）。
- @oracle 比較結論：**兩台都推薦 Qwen3-4B**（本機維持 Q4_K_M；3060 可升量化）。gemma 中文弱、RP 調校是英文資料、格式遵循弱、Q6_K 在 CPU 更慢；唯一優勢（無 thinking）不足以翻盤。切換成本：llama-server 模式改 `LLM_MODEL_URI` 一行；worker 模式還硬編碼 `QwenChatWrapper`，換模型要改碼。

### 根因（@oracle 診斷，以內顯機為準）
1. **prompt 太長 × 每次全量 prefill**（佔每輪約八成）：每次呼叫獨立 request、無 KV 重用；expand 5-8K tokens，4 核 prefill 約 50-100 tok/s，單次 60-120 秒。
2. **一次發言打太多**：6 AI＝8 次呼叫（pre-speech×6＋judge＋expand），每次都付全額 prefill。
3. **threads=8 超訂**（4 實體核），浪費 10-30%。
4. **tokens/sec 物理上限**：expand 150 tokens 也要 8-15 秒。
5. **ctx 8192 幾乎無影響**：KV 讀取相對權重可忽略，不要調錯方向。
6. **開局惰性載模型**：模型/binary/引擎延遲到首次開局。
7. **失敗路徑空等** gate timeout。
- 註：`PARALLEL=1` 是否元凶有爭議。原調查稱單槽序列化是最大元凶；@oracle 認為四核下平行不增吞吐只加交錯。待實測判定（見待跑驗證）。

### 已定決策
- CD 60s 不動（真人節奏，用戶確認）。
- quiet 整組拔除（見第 1 項）。
- 模型不換（兩台都 Qwen）。
- PARALLEL 先維持 1，實測後再定。

### 改善建議（未套用）
- `LLAMA_SERVER_THREADS=4`（env，零風險，先測）。
- prompt 預算縮減（expand 8000→4000、`PRE_SPEECH_BUDGET` 3000→2000，需改碼，最大槓桿）。
- 管線裁剪（草稿少跳過 judge；maxTokens expand→100、judge→200，需改碼）。
- 模型預熱（server 啟動就載）。
- 失敗快退。

### 待跑驗證
1. threads 4 對比（內顯機）。
2. thinking 洩漏確認（正常中文輸出）。
3. PARALLEL 1 vs 4 對比（內顯機，判定兩派誰對）。

---

## 已完成（本次會話）

- [x] **修復 WebSocket 心跳誤殺**（`src/server.ts` `pingCheck`）— 先發 PING 後檢查、門檻改 `interval+timeout`
- [x] **修復 SHUTDOWN 訊息覆蓋 + 無限重連**（`main.js`）— `left=true` 停止重連
- [x] **修復壞 token 無限重連**（`main.js`）— `JOIN_REJECTED` 清 token
- [x] **冒煙測試通過**（`npm run smoke:pkg`）
