# 外部測試 Stage 定義

> 目的：以**真實 LLM**（非 mock）在 `dist/` 編譯產物上，漸進式驗證遊戲實際行為的測試階段定義。每個 stage 有明確範圍、約束與產出；stage 清單持續擴充（後續 stage 尚未定案，見文末保留區）。
>
> 與 `npm test` 的區別：npm test 跑 mock dispatcher 的單元/整合測試；外部測試驗證的是「真實模型在實際遊戲管線中的行為品質」（草稿品質、收斂能力、決策合理性）。

## 共通約定

- **前置**：`npm run build`（harness 跑的是 `dist/`，不是 src/）
- **模型**：env `MODEL_PATH` 指向本地 GGUF；LLM 呼叫走 `WorkerDispatcher`（node-llama-cpp worker）
- **harness 位置**：`scripts/external-test-stage<N>.mjs`
- **報告**：markdown，路徑由 env `REPORT` 指定（預設寫入系統暫存）
- **術語**：
  - **中控 prompt**：SpeechScheduler 組給 AI 的完整 prompt（`pre_speech` / `judge` / `expand` 三種 kind）
  - **草稿**：AI 對 prompt 的原始回覆（尚未播出）
  - **白板**：已播出內容（狼會議 = `wolfDiscussionLog`；白天 = `discussionLog`）
  - **回合**：一次播出（boardVersion +1）
  - **決策旗標**：`[決定:殺P#]`／`[決定:投P#]`／`[決定:資訊不足]`，regex 解析、不用 LLM
- **總鐵則**：harness 只**觀察與記錄**，透過 `GameEngine` + `SpeechScheduler` 的實際管線跑局；不代寫草稿、不改 prompt、不繞過遊戲邏輯（各 stage 額外約束見各節）

## Stage 0 — 初始化 15 人局

| 項目 | 定義 |
|------|------|
| 目的 | 照實際遊戲流程建立可重複使用的 15 人全 AI 局起始狀態 |
| 流程 | `CLIENT_JOIN` ×15 → `START_GAME` → `drain()`（走真實事件管線，**不得**手工捏造 state 或跳過角色分配） |
| 沿用規則 | **沒有要求洗白重來時，若已有資料則沿用**：`game-state.json` 存在且 `schemaVersion` 相符 → `loadState()` 直接用；僅在明確要求洗白（或存檔無效）時才重新初始化 |
| 產出 | 角色分配統計（`getRoleCounts`）、狼人名單、起始 phase（`NIGHT_DISCUSSION_OPEN`）與 boardVersion 基準 |
| 現況 | `external-test-stage1.mjs` 內嵌此流程（每次重 init）；獨立化＋沿用邏輯待實作 |

## Stage 1 — 第一晚首輪會議觀察（有界）

| 項目 | 定義 |
|------|------|
| 目的 | 觀察會議**第一句話**的產生過程：中控送給各狼的 prompt 與各狼回應的草稿 |
| 範圍 | 僅首輪（boardVersion 基準 +1 次播出）；有界觀察，允許回合上限（`MAX_ROUNDS`，此 stage 例外） |
| 記錄 | 每狼的 `pre_speech` prompt 全文＋草稿回覆全文＋決策旗標解析結果；expand/judge 呼叫一併記錄 |
| 產出報告 | 模型與局資訊 → 各狼 prompt/草稿對照 → 已播出白板 → 觀察發現（草稿重複、旗標洩漏、提議殺同盟、雙前綴等 heuristic 檢查） |
| 現況 | `scripts/external-test-stage1.mjs` 已實作（`MAX_ROUNDS` 預設 2，跑首輪設 1） |

## Stage 2 — 完整三狼會議（無界）

| 項目 | 定義 |
|------|------|
| 目的 | 完整跑完第一晚三狼會議，直到**遊戲邏輯自然收斂**，給出完整會議紀錄 |
| 結束條件 | phase 離開 `NIGHT_DISCUSSION_OPEN`（全存活狼 ready → `NIGHT_COLLECTING`）；除此之外不得提前終止 |
| 鐵則 | **一定要照著遊戲實際邏輯，不可擅自進行干預或上限設定**：<br>• 禁止 harness 層回合上限（無 `MAX_ROUNDS` 截斷）<br>• 禁止逾時截斷會議（逾時只能作為報告觀察，不得中斷運行）<br>• 禁止代寫/修改/過濾草稿、禁止強制收斂或覆寫決策<br>• 遊戲**內建**機制屬實際邏輯，不可繞過：`SPEECH_RETRY_MS` 生產重試、`MAX_UNCERTAIN_ROUNDS = 50` 安全安全閥（單一 AI 連續資訊不足 → 強制棄票）——觸發時**如實記錄**，這本身是被驗證的行為 |
| 記錄 | 全程每回合每狼：完整 prompt（pre_speech/judge/expand）＋草稿＋決策；播出白板全量；收斂過程（誰先決定、目標如何變化、ready 順序） |
| 產出報告 | 完整會議紀錄：逐回合 prompt/草稿對照 → 白板逐筆 → 收斂軌跡（決策變化時間線）→ 最終擊殺目標（多數決結果）→ `wolfReady` 順序與收斂原因；安全閥/重試若觸發須標註 |
| 現況 | `scripts/external-test-stage2.mjs` 已實作（stage 1 基底移除上限：phase 離開即停；另含矛盾偵測＝expand/草稿決策不一致時標註並沿用草稿、收斂軌跡、安全閥逼近度、重試長間隔啟發式） |

## Stage 之間的關係

- Stage 1 為 Stage 2 的**首輪切片**：stage 2 報告的首輪部分即 stage 1 內容；兩者可共用一次 stage 0 初始化（未要求洗白時沿用同一局）。
- 各 stage 從 stage 0 的起始狀態出發；報告須記錄當局角色分配與狼人名單，確保跨 stage 可對照。

## 待定義 Stage（保留區）

> 後續 stage 尚未定案，定案後依同格式（目的／範圍／約束／記錄／產出／現況）追加於此。
