# AGENTS.md — 人狼遊戲（Werewolf Game）

15 人文字人狼模擬：Node + TypeScript（strict、NodeNext ESM）+ WebSocket Web UI + 本地 LLM（llama.cpp）。Windows 優先開發（打包僅 node18-win-x64）。

## 開發指令（順序重要）

- `npm run build` — tsc 編譯 src/ → dist/。typecheck 就是這個（無獨立 lint/typecheck 指令、無 CI）
- `npm test` — 跑的是 **dist/ 編譯產物**，不是 src/：改完 src/ 必須先 build 再 test
- 單一測試檔：`node --test ./dist/<name>.test.js`（在 repo root 執行；測試以 `process.cwd()` 定位 game-state.json）
- 測試必須 `--test-concurrency=1`：多個測試檔共用 repo root 的 `game-state.json`（engine.test.ts 會備份/還原該檔，其他測試依賴此隔離）
- **新增測試檔必須手動加進 package.json 的 test script**（腳本逐一列舉 dist/*.test.js，不會自動發現）

## Git 慣例（非常規，易踩雷）

- `dist/` 編譯產物**提交進 git**：每次改 src/ 後 `npm run build`，dist/ 差異與 src/ 一併 commit（見歷史 commit 慣例）
- `game-state.json` 是 runtime 存檔且**被追蹤**：跑測試/玩局會改寫它；commit 前檢查 git status，別把存檔變化誤混進功能 commit
- commit message：英文一行式描述變更與原因（見 git log）；docs 與 code 註解為繁體中文

## 架構

- 進入點 `src/entry.ts` → `server.ts main()`：HTTP 靜態（public/）+ WebSocket（ws）+ 模型下載 + 遊戲生命週期
- `GameEngine`（engine.ts）：同步事件佇列 enqueue → drain；`transition()`（game-state.ts）為純函式狀態機；phase 變更立即存檔、其餘 debounce 5s
- `SpeechScheduler`（ai-scheduler.ts）：白板更新驅動發言管線（pre_speech → judge → expand → broadcast）；收斂靠文字決策 flag `[決定:投P3]`／`[決定:殺P3]` 兩層 regex 解析（不用 LLM）；安全閥 `MAX_UNCERTAIN_ROUNDS = 50`
- 隱私邊界：`buildPlayerSnapshot` / `buildSpectatorSnapshot` / `buildGMSnapshot`（game-state.ts）— 改快照時不得讓角色/夜間資訊洩漏到玩家或觀戰視圖
- `character-session.ts buildPrompt()`：persona（agents.md + memory.md）→ `character/game-rules.md` → 公開/私有知識 → 討論 → 任務指令。人格分層：agents.md 只在正式發言（speech/expand）帶入，草稿/night/vote prompt 保持中性
- `character/game-rules.md` 是 prompt 的唯一規則來源；`character/day-meeting.md` 已棄用（stale，勿參照）
- 15 個角色 persona 在 `character/<name>/`：agents.md 靜態、memory.md 每局重寫
- GM CLI：`node dist/gm.js <init|state|start-day|night|speak|wolf-ready|vote|mason-chat|reveal>`（src/gm.ts）；`scripts/gm-helper.mjs` 為其包裝

## LLM 後端

- `LLM_PROVIDER` env：`llama-server`（**預設**；sidecar llama-server.exe 自動從 llama.cpp GitHub release 下載到 `data/bin/`，port **2064**）、`llamacpp`（node-llama-cpp in-process worker）、`mock`（測試）、`openai`（OpenAI 相容端點，預設 `http://localhost:2064/v1`）
- 注意：server.ts / llm.ts 內「預設 3001」的註解已過時，實際預設在 llama-server.ts = 2064 — 以程式碼為準
- `models/` gitignored，首次啟動自動下載 GGUF 模型
- 其他 env：`SPEECH_RETRY_MS`（生產失敗重試，預設 60s）、`ZERO_CLIENT_SHUTDOWN_MS`（0 = dev 停用零連線自動退出）、`LLM_WORKER_CONTEXTS`（預設 3）、`PLAYER_COUNT`（預設 15）、`PORT`

## 打包（Windows exe）

- `npm run build:pkg`：tsc → esbuild CJS bundle（**外部化 node-llama-cpp**，腳本會驗證 bundle 不含它）→ pkg → `dist-pkg/WerewolfGame.exe` + GUI subsystem patch（雙擊不開 CMD 窗）
- `npm run smoke:pkg`：打包產物煙霧測試
- 路徑解析（utils.ts）：pkg 環境 `getDataDir()` = exe 旁 `data/`（不可寫 fallback `%APPDATA%/WerewolfGame`）；dev = repo root。讀唯讀資源一律用 `getResourceRoot()`（依模組位置定位，非 cwd）

## 環境慣例

- Windows + PowerShell 開發；repo 路徑含中文（`人狼遊戲`）：shell 輸出中文常見 mojibake，檔案讀寫走 UTF-8 工具（read/write/edit），勿用 PowerShell cmdlet 讀寫原始碼
- 遊戲規則文件：`docs/人狼規則.md`（6–15 人配置表與職業規則）
- `docs/GM_GUIDE.md`：以 OpenCode agent sessions 玩局時的 GM 操作手冊（含 L0/L1/L2 敏感度分級與強制委派協議）— 僅玩局時適用，一般 code 修改不需遵守
- `scripts/external-test-stage1.mjs`：真實 LLM 外部測試 harness（需先 build + 本地模型檔，env `MODEL_PATH`/`MAX_ROUNDS`）
