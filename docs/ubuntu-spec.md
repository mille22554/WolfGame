# Ubuntu 版規格書：多人實時狼人殺伺服器

分支：`ubuntu`
狀態：M1–M4 已完成並部署上線（待補充 AI/遊戲邏輯部分）

## 1. 定位

外部真人玩家的線上狼人殺入口。本階段只實作**房間系統 + 實時通訊 + 遊戲設定**，AI 與遊戲流程（狼隊會議、投票、夜晚結算）後續迭代加入。

## 2. 核心功能

### 2.1 首頁（入口）
- 建立房間：輸入房主暱稱 → 產生房間代碼（4 位數字，首位非 0，如 `4821`）
- 加入房間：輸入房間代碼 + 暱稱 → 進入房間
- 無帳號系統（MVP），以暱稱 + 房間代碼識別

### 2.2 房間（Lobby）
- 房主可設定（右側「房間設定」面板，僅房主）：
  - 玩家人數：滑桿 6–15（預設 15）
  - 隨機人數 toggle：關＝定值；開＝滑桿變上限（顯示 `≤N`），開局時在 6–上限 間隨機決定實際人數
- 身分切換（頂欄）：參戰／觀戰；房主無論參戰或觀戰都保留房主工具（含開始遊戲）
- 玩家列表（分左右兩欄）：上「⚔ 參戰」、下「👀 觀戰」；角色圖示「?」佔位（lobby 不分配角色；角色於開局時隨機分配）、房主標 👑、房主可踢其他玩家（含觀戰者）
- 房主可開始遊戲
- 觀戰：可看白板、可發言（聊天）；不能操作（開始遊戲、踢人等）
- 房主離開：無手動轉讓；依入房時間（最早者）自動轉讓給下一位玩家
- 房間關閉：清空（無人）立即回收；無活動超時（預設 30 分鐘）自動清理

### 2.3 加入已開始的房間 → 觀戰模式
- 可看到白板、發言、投票結果
- 不能發言、不能投票
- 標示「觀戰中」

### 2.4 實時通訊
- 打字交流（跟 main 版一樣）
- 房間內 broadcast：發言、系統訊息（加入/離開/開始）
- 訊息有時間戳、發送者

## 3. 架構

```
┌─────────────────────────────────────────────┐
│  Ubuntu 伺服器                                │
│                                              │
│  ┌──────────┐    ┌──────────────────────┐   │
│  │ 前端靜態  │    │  Node.js 伺服器       │   │
│  │ (SPA)    │◄──►│  - WebSocket 路由     │   │
│  │          │    │  - 房間管理器          │   │
│  └──────────┘    │  - 遊戲引擎（後續）    │   │
│                   │  - LLM 推理（後續）    │   │
│                   └──────────────────────┘   │
└─────────────────────────────────────────────┘
         ▲ WebSocket (wss://)
         │
   玩家瀏覽器（多人）
```

- 單程序多房間：一個 Node 进程管理所有房間
- 每房獨立狀態（玩家列表、白板、遊戲 phase）
- 房間回收：清空（無人）→ 立即回收；無活動超時（預設 30 分鐘）→ 自動清理

## 4. 技術選型

| 層 | 選擇 | 理由 |
|---|---|---|
| 語言 | TypeScript | 與 main 分支共用類型定義、遊戲規則常數 |
| 伺服器 | Node.js + `ws`（WebSocket） | 已有模式；房間規模小（<20 人/房），Node 足夠 |
| 前端 | 原生 HTML/CSS/JS（已定，見 §11） | 頁面簡單（首頁 + 房間），不需重框架 |
| 實時通訊 | WebSocket（沿用 main 的 `ws` 模式） | 打字交流需要低延遲 bidirectional |
| 狀態持久化 | 記憶體為主 + 可选 JSON 快照 | MVP 不需資料庫；伺服器重啟房間重置 |
| 部署 | nginx（靜態）+ cloudflared tunnel | 前端已上線；後端 WebSocket 待實作後改用 pm2/systemd |

### 與 main 分支的關係
- **共用**：遊戲規則常數（角色定義、勝利條件）、類型定義（`Role`、`PlayerState`）、可能的 prompt 模板
- **獨立**：伺服器架構（main 是單人本地，ubuntu 是多房多人）、前端（main 是 Electron 桌面，ubuntu 是網頁）、房間管理
- 若共用代碼維護成本 > 獨立，則完全分開，只 sync 規則常數

## 5. 房間生命週期

```
建立 → Lobby（等待玩家）→ 遊戲中（後續）→ 結束 → 清理
                │
                ├── 房主離開 → 依入房時間自動轉讓
                ├── 清空（無人）→ 立即回收
                ├── 無活動超時（30 分鐘）→ 自動清理
                └── 觀戰者隨時可進出
```

## 6. 協議（WebSocket 訊息格式）

沿用 main 分支的 JSON 事件模式（`{ type: '...', ...payload }`），新增：

| 方向 | type | payload | 說明 |
|---|---|---|---|
| C→S | `CREATE_ROOM` | `{ nickname }` | 建立房間，回 `ROOM_JOINED { code, isHost, players[], started, maxPlayers, randomCount }` |
| C→S | `JOIN_ROOM` | `{ code, nickname, asSpectator? }` | 加入房間（`asSpectator: true` 強制觀戰） |
| S→C | `ROOM_JOINED` | `{ code, isHost, players[], started, maxPlayers, randomCount }` | 加入成功（參戰） |
| S→C | `SPECTATOR_JOINED` | `{ code, isHost, players[], started, maxPlayers, randomCount }` | 以觀戰身份進入 |
| S→C | `ROOM_FULL` | — | 房間滿員（非觀戰） |
| C→S | `SEND_MESSAGE` | `{ text }` | 發言 |
| S→C | `MESSAGE` | `{ from, text, ts }` | broadcast 發言 |
| S→C | `PLAYER_JOINED` | `{ nickname }` | 有人加入（broadcast 給其他成員） |
| S→C | `PLAYER_LEFT` | `{ nickname }` | 有人離開 |
| C→S | `SET_MODE` | `{ mode: 'play' \| 'spectate' }` | 切換參戰/觀戰 |
| S→C | `MEMBERS_CHANGED` | `{ players[] }` | 身分切換後 broadcast 完整名單 |
| C→S | `SET_SETTING` | `{ maxPlayers, randomCount }` | 房主調整設定 |
| S→C | `SETTING_CHANGED` | `{ maxPlayers, randomCount }` | broadcast 設定變更 |
| C→S | `START_GAME` | `{ maxPlayers, randomCount }` | 房主開始；server 依 `randomCount` 決定實際人數（定值或 6–上限 隨機） |
| S→C | `GAME_STARTED` | `{ started, actualCount }` | 遊戲開始通知 |
| C→S | `KICK_PLAYER` | `{ target }` | 房主踢人 |
| S→C | `KICKED` | `{ reason }` | 被踢通知（只發給被踢者） |
| S→C | `HOST_CHANGED` | `{ newHost }` | 房主離開後自動轉讓 |
| S→C | `ERROR` | `{ message }` | 錯誤（rate limit、不在房間等） |

> `players[]` 元素格式：`{ nickname, isHost, isSpectator }`（`MemberInfo`）。

## 7. 安全 / 限制

- 房間代碼：4 位數字（首位 1–9）
- 單 IP 速率限制：防濫建房間（如 10 次/分鐘）
- 訊息長度上限：200 字
- 單房上限：20 人（含觀戰）
- 無鑑權（MVP），但房主操作驗證 socket 綁定的 nickname

## 8. 不做（本階段排除）

- AI / LLM 推理
- 遊戲流程（夜晚、投票、死亡、勝利判定）
- 角色分配
- 帳號系統
- 持久化（重啟即清空）
- 跨房間通訊
- 語音

## 9. 里程碑

| # | 交付物 | 驗收標準 | 狀態 |
|---|---|---|---|
| M1 | 首頁 + 建立/加入房間 + WebSocket 連線 | 兩台瀏覽器可進同一房、互相看到對方加入 | ✅ |
| M2 | 房間內打字 broadcast + 玩家列表 + 房主操作 | 多人同時打字、踢人正常 | ✅ |
| M3 | 觀戰模式 + 房間回收（清空立即 / 超時 30 分鐘）| 加入已開始房間 → 只讀；空房立即回收、無活動 30 分鐘自動清理 | ✅ |
| M4 | 遊戲設定面板（房主調人數等）+ START_GAME 事件 | 房主可設參數、觸發開始（遊戲邏輯後續接） | ✅ |

## 10. 部署現狀

| 項目 | 狀態 |
|---|---|
| URL | `http://morowin.win/wolfgame/` |
| 伺服器 | `192.168.0.94`（Ubuntu 24.04，user `morowin`） |
| 程式碼 | `/opt/wolfgame/`（git clone ubuntu 分支） |
| Node.js | 20.20.2（NodeSource apt） |
| 後端 | `dist/lobby-server/entry.js`（systemd service `wolfgame`，port 2640） |
| 靜態檔案 | 由 Node.js 伺服（`ubuntu-web/`），nginx 不再直接伺服 |
| 反向代理 | nginx（port 80）`/wolfgame/` → `127.0.0.1:2640/`（strip prefix）+ WS upgrade |
| 隧道 | cloudflared service（systemd），routes：`morowin.win`→`:80`、`api.morowin.win`→`:9090` |
| 前端 | 已上線（純 HTML/CSS/JS，無 build step） |
| 後端 | 已上線（WebSocket 多房伺服器，M1–M4 完成） |

### 部署流程

```bash
# 本機：修改 src/ 或 ubuntu-web/ 後
npm run build          # 若改了 src/（dist/ 有 commit 進 git）
git add -A && git commit -m "..." && git push

# Server：
ssh -F ~/.ssh/config ssh.morowin.win \
  "cd /opt/wolfgame && git pull && sudo systemctl restart wolfgame"
```

- nginx 配置：`deploy/nginx-wolfgame.conf`（已部署至 `/etc/nginx/sites-enabled/`）
- systemd unit：`deploy/wolfgame.service`（已部署至 `/etc/systemd/system/`，enabled）
- 前端快取：`Cache-Control: no-cache` + `index.html` 內 `app.js?v=N` 版本號（改動前端時 bump N）

## 11. 待確認

- [x] 前端框架：原生 HTML/CSS/JS（已定）
- [x] HTTPS：cloudflared tunnel 已提供（已定）
- [x] 部署環境：Ubuntu 伺服器，無 GPU（已定）
- [x] 房間代碼長度：4 位數字（10^4 = 1 萬組合，MVP 足夠；首位非 0）
- [ ] 是否需要在首頁顯示「進行中的房間」列表（讓玩家可以瀏覽加入）
