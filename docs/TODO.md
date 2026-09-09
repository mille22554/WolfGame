# TODO — 待辦事項與分析紀錄

> 本文件記錄尚未實作的規劃與分析，供後續開發參考。
> 狀態：`[ ]` 未開始 / `[~]` 進行中 / `[x]` 已完成

---

## 1. [x] 白板更新驅動迴圈（取代 quiet/CD 等待）

### 迴圈（用戶定案）
- 白板更新 → 開工生產（除上輪發言者外全員草稿，見第 2 項）＋CD 重啟。
- 生產完成 → 暫存，不直接播。
- CD 到有貨 → 播出（播出即白板更新，迴圈回去）。
- CD 到沒貨 → 等做好馬上播。
- 中間白板又更新 → 暫存作廢＋生產用新白板重跑＋CD 重啟（版本作廢機制沿用）。
- 同一時間只有一條生產線＋一個暫存位，不會疊跑。
- 生產失敗 → 60 秒後重試（`SPEECH_RETRY_MS` env 可調，實作現況；秒數待用戶確認）；重試前不播出、不推進掛機計數。

### 參數
- CD 60s（真人節奏，用戶確認不動）。
- 純 AI：CD=0，做好就播（不是拿掉計時器，否則沒人開槍）。
- quiet 整組拔除（scheduler 規則＋`QUIET_THRESHOLD_MS` env＋測試構造）。
- 跳過按鈕（`HUMAN_SKIP`／`allAliveHumansSkipped`）保留不動（scheduler 已無依賴；刪除案待用戶確認）。

### 相關檔案
- `src/ai-scheduler.ts`（tick、生產迴圈、暫存播出、版本作廢沿用）
- `src/game-state.ts`（`allAliveHumansSkipped` 保留不動）
- 測試：`ai-scheduler.test.ts`（約十處 `quietMs` 構造）、`full-game.test.ts`（L89）、`human-discussion.test.ts`（L89-106 釘住舊語義，一併改）、`mixed-game.test.ts`（L7/L67 用 `allAliveHumansSkipped`）

---

## 2. [x] 設計並實作「AI 發言帶決策 flag」機制（取代 speechesPerDay 上限）

### 問題
目前純 AI 局討論靠 `speechesPerDay`（預設 6）強制結束（`server.ts:1360-1377`）。用戶認為這是錯誤設計：會在 AI 還沒收斂投票決定前就切斷討論，破壞遊戲。

### 用戶設計意圖
AI 發言回應應帶「決策 flag」，讓中控（SpeechScheduler）知道每個 AI 是否已準備投票：

1. **「目前資訊太少，我無法決定要棄票或投某人」** → 資訊不足，需繼續討論
2. **「目前資訊已足夠，我決定棄票/投XXX」** → 已準備好投票

當**所有存活玩家都 ready**（AI 有投票標的、真人已確認）時，討論自然收斂 → 直接進投票（不經 `CLOSING`）。

流程：當任何人 ready → 檢查是否所有人 ready；是，進投票；否，繼續討論。ready 兩種來源：真人按 ready 按鈕；AI 草稿 ready 檢定。

**關鍵限制**：flag 是給中控看的內部決策狀態，可夾在 pre-speech 草稿（內部未公開），但**不可寫入白板（discussionLog）**，否則洩漏投票意圖。

### Oracle 設計（已完成，待實作）

#### flag 格式
AI 在 pre-speech 草稿結尾附加：
```
[決定:投P3] / [決定:棄票] / [決定:資訊不足]
```
中控用 regex `/\[決定[:：](投P\s*\d+|棄票|資訊不足)\]/g` 解析（注意方括號必須跳脫，全形/半形冒號都要收，全域匹配防中置 flag 殘留；另備結尾錨定版），剝離後才進 judge/expand，**flag 永不洩漏**。剝離點統一在收草稿回傳前，broadcast 前再洗一次 expand 輸出。

#### 統一 ready 機制（用戶調整：混合局 AI flag 視同真人準備投票）
新增事件 `AI_READY_VOTE { playerId }`，AI decided 時中控 enqueue，transition 把 AI 加入 `voteReady`。`allAliveHumansReady` 改名 `allAlivePlayersReady`，檢查**所有存活玩家**（真人 + AI）ready。`CLOSING` 整個拿掉（GM 喊關那條一起刪，從沒人用過）；混合局等真人用自由發言裡的統一檢查取代，全員齊直接進投票。

#### 草稿規則（用戶定案）
每輪除上輪發言者外全員寫草稿，中控挑一個上白板；人數無關，`runDirect` 特例刪除。候選為空（僅上輪發言者一人存活）時不生產，等真人講話，不連發；此場景掛機計數凍結為已知且接受。單候選人＋真人沉默＝永久停擺，用戶接受（遊戲停著等真人回來，不加退路）。

#### 安全閥（非任意上限）
連續 `maxUncertainRounds`（預設 100）次「資訊不足」→ 強制 `decided:abstain`。這裡的次是指同一 AI 連續幾次草稿，不是遊戲輪次。不要用死上限逼 AI 早決定，五次草稿資訊本來就不夠，一百純粹是防卡死的底線。解析分兩層：先正規解析，失敗走寬鬆二次解析（關鍵字兜底：抓到決策語境的投 Pn（我投／決定投／要投）認 decided；抓到不確定類詞認 uncertain；不用 LLM，避免本地成本）。都抓不到才計入資訊不足計數。安全閥只計真正的資訊不足，格式問題在解析層解決，不冤枉格式小錯的草稿。

#### 掛機規則
AI 每次 CD 到發話計一次；計數只對未定真人，已 ready 直接清空並列入計數對象外，收回從零重算；任一真人發話／跳過／收回 ready 即清空（計數放 game-state，由 transition 清零；跳過與收回不 bump 白板版本，另接鉤子）；計數到 10，該真人視為掛機，視同斷線，AI 接管座位（沿用斷線路徑，可重連拿回）。

#### 接管 UX
server 推接管通知（`IDLE_TAKEOVER`：transition 計數到 10 時回傳 effect，engine 執行切座位＋發事件，server 轉播，payload 帶 playerId 與原因）；被接管者頁面多一個 panel（AI 接管中＋回歸按鈕走 `RECONNECT`），其他人沿用 AI 座位顯示；快照帶接管標記（重整頁面 panel 才回得來）；panel 以快照標記為準渲染（每次快照重算，多頁籤一致）；接管後該真人 WS 只收 `RECONNECT`，其他遊戲訊息忽略（只套接管時已連線的舊 WS，重整後新 WS 走正常 JOIN 流程；單向，真人→server 忽略，server→真人推送不受影響，`IDLE_TAKEOVER` 先送達或豁免；拿回成功後過濾解除；通知只推被接管者本人）；拿回後回到未定，重新決定；已進投票／結束按現況重連語義處理。

#### 移除
- `server.ts:1360-1377` `autoCloseTimer`
- `speechesPerDay` 變數（`server.ts:770`）與 `ServerOptions`（`server.ts:62`）

### 變更檔案清單
| 檔案 | 變更 |
|------|------|
| `src/types.ts` | 加 `AI_READY_VOTE` 事件；加接管通知事件（如 `IDLE_TAKEOVER`）；快照加接管標記欄位（區分原生 AI 與掛機接管）；`voteReady` 註解改「真人 + AI」 |
| `src/game-state.ts` | `allAlivePlayersReady`；`AI_READY_VOTE` handler；收斂直進投票（移除 `CLOSING` 階段與 `CLOSE_DISCUSSION` 路徑）；`applyReconnect` 移出 voteReady |
| `src/ai-scheduler.ts` | `AIDecision` 型別、`parseDecisionFlag`、`updateDecisions`、`checkConvergence`、`enqueueNewlyDecided`、`checkAllPlayersReady`；改 `collectPreSpeeches`/`runPipeline`/`tick`/`onPhaseEntered`；刪除 `runDirect` 特例（全員草稿） |
| `src/character-session.ts` | `buildPreSpeechPrompt` 任務指令加 flag 格式 |
| `src/engine.ts` | transition 回傳 effect 機制，engine 執行切座位＋發事件（接管鏈用） |
| `src/server.ts` | 移除 `autoCloseTimer` + `speechesPerDay` |
| `src/gm.ts` | `vote` 指令改灌滿 ready（幫所有人點頭→統一檢查→投票→投票事件），`CLOSE_DISCUSSION` 移除 |
| `public/js/main.js` | `CLOSING` UI 分支清理（L1097）＋`DAY_DISCUSSION_CLOSING` 標籤（L11）＋ready 收回按鈕＋掛機橫幅與拿回座位鈕 |
| 測試 | `ai-scheduler.test.ts`、`server.test.ts`、`server-human.test.ts`、`full-game.test.ts`、`mixed-game.test.ts`、`game-state.test.ts`、`engine.test.ts`、`human-discussion.test.ts`、`human-reconnect.test.ts`、`snapshot.test.ts` |

### 設計決策（用戶已確認）
- flag 格式 OK
- 混合局：AI flag 視同玩家的準備投票（HUMAN_READY_VOTE）
- 安全閥 100（用戶定案：不要死上限逼決定；五次草稿資訊本來就不夠，一百純防卡死底線）
- flag 不綁定最終投票（投票階段仍重新決定）
- CLOSING 拿掉（含 GM 喊關），混合局等真人用統一檢查取代
- 草稿規則：除上輪發言者外全員寫草稿，中控挑一個上白板
- AI ready 單向不退名單，但投票標的每輪可變（新 flag 覆蓋）；管線照跑直到統一檢查全過（純 AI 全定了即投票）
- ready 可收回（沿用 `HUMAN_UNREADY_VOTE`）；收回視為活動，回到未定
- 掛機規則：10 次計數後 AI 接管（見上）；接管 UX 見上
- `gm vote` 改灌滿 ready（幫所有人點頭→統一檢查→投票→投票事件）
- 單候選人＋真人沉默＝永久停擺，用戶接受（遊戲停著等真人回來）
- 已 ready 清空計數並排除對象外，收回從零重算

### Oracle 複查結論（可做，但要改 6 處）
1. **無 flag／解析失敗也要計入安全閥**：否則模型不照格式吐時，純 AI 局永遠卡在討論（移除 speechesPerDay 後唯一的收斂保證，必須對任何輸出都有界）。
2. **regex 重寫**：跳脫方括號（已修正）＋全形/半形冒號都要收＋剝離用全域匹配（防中置 flag 殘留進白板洩漏投票意圖）。
3. **runDirect 對所有存活 AI 出草稿**：現況只給隨機一個 AI 出草稿，≤2 人時另一個永遠沒 flag → 卡死（只選一個展開即可）。
4. **CLOSING 競態**（已決議：CLOSING 整個拿掉，本條作廢）：原分析指 CLOSING 不收 AI_READY_VOTE、晚到的 ready 被拒會卡死；決議後無 CLOSING，改走自由發言裡的統一檢查，晚到的 ready 照收。
5. **AI_READY_VOTE 語義定死**：發言成功廣播後才 enqueue、不帶 boardVersion、decided 單向不反悔、全 decided 後管線停止空轉。
6. **expand 輸出也要清洗 flag**：模型可能自行輸出 flag，broadcast 前過一次 pattern（廉價保險）。剝離位置統一在 `collectPreSpeeches` 回傳前，不要各消費點各自剝離。

### 附帶建議
- 混合局真人不按 ready：走掛機規則（10 次計數後 AI 接管），不再另接待收尾超時；`HUMAN_SKIP` 逃生鈕隨跳過按鈕刪除案處理（待用戶確認）。
- 本項依賴第 1 項先做：否則 100 輪收斂＝8000 秒純白等，慢到不可用。
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
