# 外部測試 Stage 定義（ubuntu 分支）

> 目的：以**真實 LLM**（SGLang，非 mock）在 `dist/lobby-server/` 編譯產物上，漸進式驗證遊戲實際行為的測試階段定義。每個 stage 有明確範圍、約束與產出；stage 清單持續擴充（後續 stage 尚未定案，見文末保留區）。
>
> 與 `npm test` 的區別：npm test 跑 mock 的單元/整合測試；外部測試驗證的是「真實模型在實際遊戲管線中的行為品質」（草稿品質、收斂能力、決策合理性）。
>
> 依據：`docs/ubuntu-spec.md`（§12 遊戲流程、§13 AI 補位）。M7（AI 補位）待實作——下列各 stage 皆須待 M7 完成後才能跑。

## 共通約定

- **前置**：`npm run build`（harness 跑的是 `dist/lobby-server/`，不是 src/）；SGLang 推理服務運行中（systemd `sglang-server.service`，規格 §13.10）
- **模型**：Qwen3.8-27B-AWQ（INT4）＋ DSpark 推測解碼；`http://127.0.0.1:9090`（OpenAI-compatible `POST /v1/chat/completions`，Bearer 認證）
- **環境變數**：`SGLANG_API_KEY`（必填，部署時注入）、`LLM_MODEL`（預設 `qwen3.8-27b`）、`SGLANG_HOST`／`SGLANG_PORT`（預設 127.0.0.1:9090）、`LLM_TIMEOUT_MS`（60000）、`LLM_MAX_TOKENS`（200）、`AI_ENABLED`（預設 true）
- **併發**：SGLang `--max-running-requests 2` 與 PRE_SPEECH 每批 2 個吻合，不需排隊
- **harness 位置**：`scripts/external-test-stage<N>.mjs`
- **報告**：markdown，路徑由 env `REPORT` 指定（預設寫入系統暫存）
- **術語**：
  - **中控 prompt**：ai-player 組給 AI 的完整 prompt（System＋User，規格 §13.5；`pre_speech`／`judge`／`expand` 三種 kind）
  - **草稿**：AI 對 prompt 的原始回覆（尚未播出）
  - **白板**：已播出內容（白天＝公頻 `MESSAGE` 紀錄；狼會議＝`WOLF_MESSAGE`；共有者＝`MASON_MESSAGE`）
  - **回合**：一次播出（board 版本 +1）
  - **parse 結果**：AI 回覆 parse 出的 JSON（`{"speech": "..."}`／`{"scores": [...]}`／`{"target": ...}`）；parse 失敗 → fallback 預設行動（見下）
- **總鐵則**：harness 只**觀察與記錄**，透過實際管線（`GameEngine`＋`ai-player`＋`llm`）跑局；不代寫草稿、不改 prompt、不繞過遊戲邏輯（各 stage 額外約束見各節）
- **Fallback（規格 §13.2）**：LLM 呼叫失敗（timeout／5xx／parse error）→ server 自動替該 AI 提交預設行動（狼→隨機刀一人；占い→隨機查一人；守衛→隨機護一人；投票→棄票；發言→跳過）。**必須自動提交**，因為 phase 無 timeout，若 AI 永遠不提交則遊戲卡死

## Stage 0 — 初始化 15 人全 AI 局

| 項目 | 定義 |
|------|------|
| 目的 | 照實際遊戲流程建立可重複使用的 15 人全 AI 局起始狀態（純 AI 局，規格 §13.1） |
| 流程 | `CREATE_ROOM`（房主）→ `START_GAME { maxPlayers: 15, randomCount: false }`（0 真人參戰，AI 補滿 15 席，§13.3）→ `ROLE_REVEAL`（10s 固定）→ `NIGHT`（AI 夜間行動全數提交 → 立即結算）→ `NIGHT_RESULT`（10s 固定）→ 進入 `DAY_DISCUSSION`（走真實房間／遊戲管線，**不得**手工捏造 state 或跳過角色分配） |
| 與 main 差異 | 無持久化（規格 §8：重啟即清空）——每次跑都是新房間，沒有「沿用」邏輯 |
| 產出 | 角色分配統計（15 人 `ROLE_CONFIG` 表）、狼人名單（`wolfPartnerIds`）、第一夜結果、Day 1 討論起始狀態 |
| 現況 | 待實作（M7） |

## Stage 1 — 第一天首輪討論發言觀察（有界）

| 項目 | 定義 |
|------|------|
| 目的 | 觀察討論**第一句話**的產生過程：中控送給各 AI 的 prompt 與各 AI 回應的草稿 |
| 範圍 | 僅首輪（board 版本基準 +1 次播出）；有界觀察，允許回合上限（`MAX_ROUNDS`，此 stage 例外） |
| 觸發 | 討論 60s 無訊息 → SpeechScheduler 管線（§13.6）：PRE_SPEECH（每批 2 個平行，≤100 token）→ JUDGE（全盲評分）→ SELECT（新穎性懲罰＋top3 隨機）→ EXPAND → BROADCAST |
| 記錄 | 每 AI 的 `pre_speech` prompt 全文＋草稿回覆全文＋parse 結果；judge/expand 呼叫一併記錄 |
| 產出報告 | 模型與局資訊 → 各 AI prompt/草稿對照 → 已播出白板 → 觀察發現（草稿重複、JSON parse 失敗、角色語氣不符等 heuristic 檢查） |
| 現況 | 待實作（M7） |

## Stage 2 — 第一天完整討論（無界）

| 項目 | 定義 |
|------|------|
| 目的 | 完整跑完 Day 1 白天討論，直到**遊戲邏輯自然收斂**，給出完整討論紀錄 |
| 結束條件 | 所有存活玩家 toggle「準備投票」ON → `DAY_VOTING`；除此之外不得提前終止 |
| 鐵則 | **一定要照著遊戲實際邏輯，不可擅自進行干預或上限設定**：<br>• 禁止 harness 層回合上限（無 `MAX_ROUNDS` 截斷）<br>• 禁止逾時截斷討論（規格：phase 無 timeout，等待是設計；逾時只能作為報告觀察，不得中斷運行）<br>• 禁止代寫/修改/過濾草稿、禁止強制收斂或覆寫決策<br>• 遊戲**內建**機制屬實際邏輯，不可繞過：60s CD 中斷（有新訊息 → 作廢管線回 IDLE）、board 版本無效化（phase 切換 → 作廢回 IDLE）、LLM 失敗 → fallback 預設行動（發言→跳過，**必須自動提交**防卡死）——觸發時**如實記錄**，這本身是被驗證的行為 |
| 記錄 | 全程每回合每 AI：完整 prompt（pre_speech/judge/expand）＋草稿＋parse 結果；播出白板全量；收斂過程（誰發言、誰 toggle ready、順序）；各 AI 發言次數（§13.4：每輪最多 2 次） |
| 產出報告 | 完整討論紀錄：逐回合 prompt/草稿對照 → 白板逐筆 → 收斂軌跡（決策變化時間線）→ 最終 ready 順序與收斂原因；CD 中斷/版本無效化/fallback 若觸發須標註 |
| 現況 | 待實作（M7） |

## Stage 之間的關係

- Stage 1 為 Stage 2 的**首輪切片**：stage 2 報告的首輪部分即 stage 1 內容；兩者可共用一次 stage 0 初始化（ubuntu 無持久化，共用＝同一 process 內保持同一房間存活、依序跑 stage）。
- 各 stage 從 stage 0 的起始狀態出發；報告須記錄當局角色分配與狼人名單，確保跨 stage 可對照。

## 待定義 Stage（保留區）

> 後續 stage 尚未定案，定案後依同格式（目的／範圍／約束／記錄／產出／現況）追加於此。候選方向（規格 §13.4 AI 行動節點）：
> - 夜間行動：狼刀人（含狼會議 ready toggle、平票 → 回討論循環，§12.3）、占い師查人、守衛護人
> - 投票：`CAST_VOTE` 目標合理性、棄票時機、平票 → 無人出局（§12.5）
> - 完整一局端到端（M7 驗收：1 真人＋5 AI 可跑完整局）
