# AGENTS.md

## 專案

人狼遊戲：Node.js（TypeScript strict、ESM）＋ 純 HTML/CSS/JS 網頁客戶端。

- `main` 分支：Windows 單機單房（`src/` 根層 server ＋ `public/` 客戶端；web server 或 pkg 打包 exe）。
- `ubuntu` 分支：無頭多房 server（`src/lobby-server/` ＋ `ubuntu-web/`），**已部署上線**（`http://morowin.win/wolfgame/`）。
- 兩分支獨立維護，改動要落在目前所在分支。ubuntu 分支的規格、WS 協定、里程碑狀態以 `docs/ubuntu-spec.md` 為準。

## 部署（ubuntu 分支，已上線）

- **`http://morowin.win/wolfgame/`**：Cloudflare Tunnel → Ubuntu nginx :80 → proxy `/wolfgame/` → `127.0.0.1:2640`（Node lobby-server）。**Node 自己伺服 `ubuntu-web/` 靜態檔＋WS**，nginx 只做反代（配置在 `deploy/nginx-wolfgame.conf`）。
- 頁尾「v0.1 · 前端畫面原型」是**殘留的舊 label**，別被誤導——該站就是本 repo 的 `ubuntu-web/` ＋ lobby-server。
- Ubuntu server：`morowinserver`（192.168.0.94，使用者 morowin，SSH 走 `ssh.morowin.win`）；程式碼在 `/opt/wolfgame/`；systemd service `wolfgame`（unit 在 `deploy/wolfgame.service`）。
- **部署流程**：本機改 `src/` 或 `ubuntu-web/` → `npm run build`（若改 src）→ commit＋push → `ssh ssh.morowin.win "cd /opt/wolfgame && git pull && sudo systemctl restart wolfgame"`。
- **前端快取**：`index.html` 內 `app.js?v=N` 版本號，改動 `ubuntu-web/` 前端時要 bump N。
- AI 後端：同機 SGLang（Qwen3.8-27B，`localhost:9090`，OpenAI-compatible API）；tunnel 另有 `api.morowin.win`→`:9090`。
- 里程碑：M1–M5（多房 lobby＋server-side 遊戲核心）已完成上線；M6（前端遊戲 UI）、M7（AI 補位）待實作——`ai-player.ts` 已存在但尚未接進 `game.ts`。
- 其他子網域／Tunnel 路由表：`../ForOpencodeMemory/fastCRW-vs-SearXNG-Comparison.md` 的「實際部署狀態」章節。

## 命令

| 命令 | 說明 |
|---|---|
| `npm run build` | `tsc`：`src/` → `dist/`。**`dist/` 有 commit 進 git**，改完 src 必須重新 build 並連 dist 一起 commit |
| `npm test` | `node --test`（18 個測試檔，**跑 dist/ 的編譯產物，且只含 main 分支的測試**）→ 先 build 再 test |
| `node --test dist/<name>.test.js` | 跑單一測試 |
| `node --test dist/lobby-server/room-manager.test.js dist/lobby-server/server.test.js` | ubuntu 分支 lobby-server 測試（**不在 `npm test` 裡**，要手動跑） |
| `npm start` | `node dist/entry.js` → main 分支單房 HTTP+WS server；port 取 `PORT` env，否則從 2639 起自動找 |
| `node dist/lobby-server/entry.js` | ubuntu 分支多房 lobby server；`PORT` 預設 2640 |
| `npm run build:pkg` / `npm run smoke:pkg` | pkg 打 Windows exe（node18-win-x64）→ `dist-pkg/`（gitignore） |

沒有 CI、lint、formatter 設定。

## 環境變數（皆有預設值）

main 分支 server：

- `LLM_PROVIDER`：`llamacpp`（預設）｜`mock`（不載模型，dev/test 用）｜`openai`
- `PORT`、`PLAYER_COUNT`（6-15，預設 15）、`LLM_MODEL_URI`、`LLM_MODELS_DIR`、`LLAMA_SERVER_PORT`（2064）
- `OPEN_BROWSER`：預設 true；headless server 要設 `false`
- `ZERO_CLIENT_SHUTDOWN_MS`：預設 60000——**最後一個 WS client 離開 60 秒後 server 自動 process.exit**；設 `0` 停用（無人值守 server 必設）

lobby-server（ubuntu 分支）：

- `PORT`（預設 2640）、`SGLANG_HOST`（127.0.0.1）、`SGLANG_PORT`（9090）、`SGLANG_API_KEY`、`LLM_MODEL`（qwen3.8-27b）、`LLM_TIMEOUT_MS`（60000）
- **沒有** zero-client 自動終止（只處理 SIGINT/SIGTERM）；空房立即回收、無活動 30 分鐘自動清理（room-manager 的 sweep timer）。

## 必知陷阱

- **`dist/` 是 commit 進 git 的編譯產物**：測試跑的是 dist/，改 src 不 build 就測到舊產物；commit 時 src＋dist 要一起。
- **`npm test` 不含 lobby-server 測試**：改 `src/lobby-server/` 後要另外跑上面的 `node --test dist/lobby-server/...`。
- **`game-state.json`（repo 根目錄）是 runtime 存檔且被 git 追蹤**：跑一局就會改動它；feature commit 不要把存檔雜訊混進去。
- **`models/` gitignore**（本地有 ~2.5GB .gguf）。models 目錄有任何 .gguf 就直接用、啟動時不自動下載；下載由 UI 的 models 頁觸發（`POST /api/model/download`）。（main 分支）
- **`character/` 是 AI 人格資源**：`character/<id>/agents.md`（persona）＋ `memory.md`（角色記憶），id 對照 `types.ts`；根層 `character/*-meeting.md` 是共用會議白板。載入走 `getResourceRoot()`（以模組位置定位，不是 cwd）。
- **main 分支 server 會自我終止**：零 WS 連線 60 秒 → shutdown（`no-clients`）。主選單（menu.html）不開 WS，只有大廳（index.html）連線；headless 跑法要 `ZERO_CLIENT_SHUTDOWN_MS=0`。
- **大廳面板靠 WS 渲染**（main 分支）：`#lobby-overlay` 預設 hidden，收到 server 的 LOBBY 訊息才顯示。直接開靜態檔（file://）只看到「連線中…」，截圖/驗收 UI 必須連著活的 server。
- **`ubuntu-web/` 已連 WS**（dev `ws://localhost:2640`、prod `ws://morowin.win/wolfgame/`）：file:// 直接開不會動，要先起 lobby-server（`node dist/lobby-server/entry.js`）再開 `http://localhost:2640/`。
- **`scripts/`**：`driver.mjs`、`gm-helper.mjs`、`gen-memory.mjs`、`meeting-lock.mjs` 是 Phase 0 的 CLI 舊工具（呼叫 dist/ 產物）；`build-pkg.mjs`／`pkg-smoke.mjs`／`patch-gui.mjs` 是 exe 打包（patch-gui 把 PE subsystem 改成 GUI，console 輸出會被丟掉）；`ai-trace.mjs` 是 AI 管線外部測試腳本（在 server 上跑：`SGLANG_API_KEY=xxx node scripts/ai-trace.mjs`，輸出 `ai-trace-output.md`）。
- **PowerShell 5.1 控制台會把 UTF-8 中文顯示成亂碼**（檔案本身沒壞）；讀內容用 Read 工具，別信 console 回顯。

## 文件

- `docs/phase0..3-spec.md` — main 分支各 phase 實作規格（含 WS 協定、測試規格、不可違反的不變式）
- `docs/ubuntu-plan.md` — ubuntu 分支三階段計畫（無頭單房 → 多房 → 模型切換）
- `docs/ubuntu-spec.md` — **ubuntu 分支權威規格**：WS 協定、房間生命週期、phase 狀態機、部署現況、里程碑（M1–M7）
- `docs/人狼規則.md` — 遊戲規則＋GM 紀律（AI 行為約束、洩密禁令）
- `docs/GM_GUIDE.md` — GM 操作指南
