# AGENTS.md

## 專案

人狼遊戲：Node.js（TypeScript strict、ESM）server（HTTP + WebSocket）＋ 純 HTML/CSS/JS 網頁客戶端（`public/`）。

- `main` 分支：Windows 單機單房（web server 或 pkg 打包 exe）。
- `ubuntu` 分支：無頭多房 server（規劃見 `docs/ubuntu-plan.md`）。兩分支獨立維護，改動要落在目前所在分支。

## 部署（公開網址）

- **公開網址：`http://morowin.win/wolfgame/`**（Cloudflare Tunnel → Ubuntu server nginx :80 → `/var/www/wolf`）。
- **該網址目前部署的是前端原型 v0.1**（靜態 HTML/CSS/JS，頁面標題「狼人殺 · Werewolf Online」，含建立／加入房間＋大廳畫面）——**不是本 repo 的 server build**；本 repo 的頁面（menu/index/models/download）不在那站上。
- 該原型在 repo 的 **`ubuntu-web/`**（`index.html`／`app.js`／`style.css`，共 3 檔）。**純靜態 mock：`app.js` 沒有 WS／fetch，不連任何 server**，房間／大廳畫面全是前端假資料；**直接雙擊 `index.html` 開網頁即可（file://），不需要任何 server**。別跟 `public/`（main 分支真正連 server 的客戶端）搞混。
- Ubuntu server：`morowinserver`（192.168.0.94，使用者 morowin，SSH 走 `ssh.morowin.win`）；ubuntu 分支的 server 規劃部署在同一台。
- 部署細節（Tunnel 路由表、其他子網域）：`../ForOpencodeMemory/fastCRW-vs-SearXNG-Comparison.md` 的「實際部署狀態」章節。

## 命令

| 命令 | 說明 |
|---|---|
| `npm run build` | `tsc`：`src/` → `dist/`。**`dist/` 有 commit 進 git**（~170 檔），改完 src 必須重新 build 並連 dist 一起 commit |
| `npm test` | `node --test`（18 個測試檔，**跑的是 dist/ 的編譯產物**）→ 先 build 再 test，否則測到舊產物 |
| `node --test dist/<name>.test.js` | 跑單一測試 |
| `npm start` | `node dist/entry.js` → HTTP+WS server；port 取 `PORT` env，否則從 2639 起自動找 |
| `npm run build:pkg` / `npm run smoke:pkg` | pkg 打 Windows exe（node18-win-x64）→ `dist-pkg/`（gitignore） |

沒有 CI、lint、formatter 設定。`ubuntu-web/` 前端原型直接雙擊 `index.html` 開網頁即可，不需 server。

## 環境變數（皆有預設值）

- `LLM_PROVIDER`：`llamacpp`（預設）｜`mock`（不載模型，dev/test 用）｜`openai`
- `PORT`、`PLAYER_COUNT`（6-15，預設 15）、`LLM_MODEL_URI`、`LLM_MODELS_DIR`、`LLAMA_SERVER_PORT`（2064）
- `OPEN_BROWSER`：預設 true；headless server 要設 `false`
- `ZERO_CLIENT_SHUTDOWN_MS`：預設 60000——**最後一個 WS client 離開 60 秒後 server 自動 process.exit**；設 `0` 停用（無人值守 server 必設）

## 必知陷阱

- **server 會自我終止**：零 WS 連線 60 秒 → shutdown（`no-clients`）。主選單（menu.html）不開 WS，只有大廳（index.html）連線；headless 跑法要 `ZERO_CLIENT_SHUTDOWN_MS=0`。
- **大廳面板靠 WS 渲染**：`#lobby-overlay` 預設 hidden，收到 server 的 LOBBY 訊息才顯示。直接開靜態檔（file://）只看到「連線中…」，截圖/驗收 UI 必須連著活的 server。
- **`game-state.json`（repo 根目錄）是 runtime 存檔且被 git 追蹤**：跑一局就會改動它；feature commit 不要把存檔雜訊混進去。
- **`models/` gitignore**（本地有 ~2.5GB .gguf）。models 目錄有任何 .gguf 就直接用、啟動時不自動下載；下載由 UI 的 models 頁觸發（`POST /api/model/download`）。
- **`character/` 是 AI 人格資源**：`character/<id>/agents.md`（persona）＋ `memory.md`（角色記憶），id 對照 `types.ts`；根層 `character/*-meeting.md` 是共用會議白板。載入走 `getResourceRoot()`（以模組位置定位，不是 cwd）。
- **`scripts/`**：`driver.mjs`、`gm-helper.mjs`、`gen-memory.mjs`、`meeting-lock.mjs` 是 Phase 0 的 CLI 舊工具（呼叫 dist/ 產物）；`build-pkg.mjs`／`pkg-smoke.mjs`／`patch-gui.mjs` 是 exe 打包（patch-gui 把 PE subsystem 改成 GUI，console 輸出會被丟掉）。
- **PowerShell 5.1 控制台會把 UTF-8 中文顯示成亂碼**（檔案本身沒壞）；讀內容用 Read 工具，別信 console 回顯。

## 文件

- `docs/phase0..3-spec.md` — 各 phase 實作規格（含 WS 協定、測試規格、不可違反的不變式）
- `docs/ubuntu-plan.md` — ubuntu 分支三階段計畫（無頭單房 → 多房 → 模型切換）
- `docs/ubuntu-spec.md` — ubuntu 版多人實時伺服器規格書（房間系統＋實時通訊＋觀戰；初稿，AI/遊戲邏輯待補）
- `docs/人狼規則.md` — 遊戲規則＋GM 紀律（AI 行為約束、洩密禁令）
- `docs/GM_GUIDE.md` — GM 操作指南
