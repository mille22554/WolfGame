# TODO — 待辦事項與分析紀錄

> 本文件記錄尚未實作的規劃與分析，供後續開發參考。
> 狀態：`[ ]` 未開始 / `[~]` 進行中 / `[x]` 已完成

---

## 1. [ ] 修正純 AI 局白等 quiet 20s + CD 60s 的 bug

### 問題
白天討論的兩個延遲是為「真人參與」設計的，但跳過條件 `allAliveHumansSkipped`（`game-state.ts:161-164`）要求「有真人且全部跳過」。**純 AI 局（無真人）時回傳 false**，導致每則發言白等：

| 延遲 | 位置 | 設計用意 | 純 AI 局現況 |
|------|------|---------|-------------|
| **CD 60s** | `ai-scheduler.ts:56` (`cdMs`) | 給真人閱讀/打字時間 | 沒跳過，白等 60s |
| **quiet 20s** | `ai-scheduler.ts:57` (`quietMs`) | 避免 AI 打斷真人思考 | 沒跳過，白等 20s |

純 AI 局每則發言白白多等 **80 秒**，每天 6 則 = **8 分鐘純白等**，比 LLM 生成時間還多。

### 修正方向
- **純 AI 局（無存活真人）** → 完全跳過 quiet + CD（快速進行）
- **有真人** → 保留 CD 60s（用戶要的節奏），移除 quiet 20s（用戶沒要求、多餘）

### 相關檔案
- `src/ai-scheduler.ts`（`tick`、`broadcastAfterCd`）
- `src/game-state.ts`（`allAliveHumansSkipped`）

---

## 2. [ ] 設計並實作「AI 發言帶決策 flag」機制（取代 speechesPerDay 上限）

### 問題
目前純 AI 局討論靠 `speechesPerDay`（預設 6）強制結束（`server.ts:1360-1377`）。用戶認為這是錯誤設計：會在 AI 還沒收斂投票決定前就切斷討論，破壞遊戲。

### 用戶設計意圖
AI 發言回應應帶「決策 flag」，讓中控（SpeechScheduler）知道每個 AI 是否已準備投票：

1. **「目前資訊太少，我無法決定要棄票或投某人」** → 資訊不足，需繼續討論
2. **「目前資訊已足夠，我決定棄票/投XXX」** → 已準備好投票

當**所有存活 AI 都 ready**（有投票標的）時，討論自然收斂 → `CLOSE_DISCUSSION` → 投票。

**關鍵限制**：flag 是給中控看的內部決策狀態，可夾在 pre-speech 草稿（內部未公開），但**不可寫入白板（discussionLog）**，否則洩漏投票意圖。

### Oracle 設計（已完成，待實作）

#### flag 格式
AI 在 pre-speech 草稿結尾附加：
```
[決定:投P3] / [決定:棄票] / [決定:資訊不足]
```
中控用 regex `/[決定:(投P(\d+)|棄票|資訊不足)]\s*$/` 解析，剝離後才進 judge/expand，**flag 永不洩漏**。

#### 統一 ready 機制（用戶調整：混合局 AI flag 視同真人準備投票）
新增事件 `AI_READY_VOTE { playerId }`，AI decided 時中控 enqueue，transition 把 AI 加入 `voteReady`。`allAliveHumansReady` 改名 `allAlivePlayersReady`，檢查**所有存活玩家**（真人 + AI）ready。

#### 安全閥（非任意上限）
連續 `maxUncertainRounds`（預設 5）次「資訊不足」→ 強制 `decided:abstain`。是「思考 N 輪後決定」，不是時間上限。

#### 移除
- `server.ts:1360-1377` `autoCloseTimer`
- `speechesPerDay` 變數（`server.ts:770`）與 `ServerOptions`（`server.ts:62`）

### 變更檔案清單
| 檔案 | 變更 |
|------|------|
| `src/types.ts` | 加 `AI_READY_VOTE` 事件；`voteReady` 註解改「真人 + AI」 |
| `src/game-state.ts` | `allAlivePlayersReady`；`AI_READY_VOTE` handler；`CLOSE_DISCUSSION` 改用統一 ready；`applyReconnect` 移出 voteReady |
| `src/ai-scheduler.ts` | `AIDecision` 型別、`parseDecisionFlag`、`updateDecisions`、`checkConvergence`、`enqueueNewlyDecided`、`checkAllPlayersReady`；改 `collectPreSpeeches`/`runPipeline`/`runDirect`/`tick`/`onPhaseEntered` |
| `src/character-session.ts` | `buildPreSpeechPrompt` 任務指令加 flag 格式 |
| `src/server.ts` | 移除 `autoCloseTimer` + `speechesPerDay` |
| 測試 | `ai-scheduler.test.ts`、`server.test.ts`、`server-human.test.ts`、`full-game.test.ts`、`mixed-game.test.ts` |

### 設計決策（用戶已確認）
- flag 格式 OK
- 混合局：AI flag 視同玩家的準備投票（HUMAN_READY_VOTE）
- 安全閥 5 輪
- flag 不綁定最終投票（投票階段仍重新決定）

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

---

## 5. [ ] 開局 / 角色行動慢 — 效能改善（調查完成，未套用）

### 根因（已調查）
1. **`LLAMA_SERVER_PARALLEL=1` 單槽序列化**（最大元凶）— 所有 AI 呼叫串行
2. **討論管線每則 3 次串行 LLM + 人為延遲**（見任務 1 的 quiet/CD bug）
3. **開局惰性載模型** — 模型/binary/引擎延遲到首次開局
4. **token 預算偏大**（judge 300 / expand 150）
5. **失敗路徑空等** gate timeout

### 註：模型是 4B（gemma-3-4b-it-roleplay-tuned-v2.Q6_K，~3GB），不是 9B
explorer 早期報告誤用 9B 速度（8.7 tok/s），實際 4B 約 20-40 tok/s。但結構性原因（PARALLEL=1、人為延遲）不變。

### 改善建議（未套用，待用戶決定）
- `LLAMA_SERVER_PARALLEL=4~8`
- `SPEECH_CD_MS=8000`、`QUIET_THRESHOLD_MS=5000`
- judge 300→150、expand/speech 150→100、vote/night 100→60
- 模型預熱（server 啟動就載）
- 失敗快退

---

## 已完成（本次會話）

- [x] **修復 WebSocket 心跳誤殺**（`src/server.ts` `pingCheck`）— 先發 PING 後檢查、門檻改 `interval+timeout`
- [x] **修復 SHUTDOWN 訊息覆蓋 + 無限重連**（`main.js`）— `left=true` 停止重連
- [x] **修復壞 token 無限重連**（`main.js`）— `JOIN_REJECTED` 清 token
- [x] **冒煙測試通過**（`npm run smoke:pkg`）
