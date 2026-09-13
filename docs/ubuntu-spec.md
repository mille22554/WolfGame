# Ubuntu 版規格書：多人實時狼人殺伺服器

分支：`ubuntu`
狀態：初稿（待補充 AI/遊戲邏輯部分）

## 1. 定位

外部真人玩家的線上狼人殺入口。本階段只實作**房間系統 + 實時通訊 + 遊戲設定**，AI 與遊戲流程（狼隊會議、投票、夜晚結算）後續迭代加入。

## 2. 核心功能

### 2.1 首頁（入口）
- 建立房間：輸入房主暱稱 → 產生房間代碼（短碼，如 `ABC123`）
- 加入房間：輸入房間代碼 + 暱稱 → 進入房間
- 無帳號系統（MVP），以暱稱 + 房間代碼識別

### 2.2 房間（Lobby）
- 房主可設定：
  - 玩家人數上限（跟 main 版一樣，房主調整）
  - 角色分配規則（後續）
- 玩家列表：已加入者、等待中
- 房主可開始遊戲（人數達標後）
- 房主可踢人、可转让房主
- 房主可關閉/解散房間

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
- 房間無活動超時 → 自動清理（可配，預設 30 分鐘）

## 4. 技術選型

| 層 | 選擇 | 理由 |
|---|---|---|
| 語言 | TypeScript | 與 main 分支共用類型定義、遊戲規則常數 |
| 伺服器 | Node.js + `ws`（WebSocket） | 已有模式；房間規模小（<20 人/房），Node 足夠 |
| 前端 | 輕量 SPA（待選：React / Vue / 原生） | 頁面簡單（首頁 + 房間），不需重框架 |
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
                │                        │
                └── 解散（房主主動）      └── 觀戰者隨時可進出
```

## 6. 協議（WebSocket 訊息格式）

沿用 main 分支的 JSON 事件模式（`{ type: '...', ...payload }`），新增：

| 方向 | type | payload | 說明 |
|---|---|---|---|
| C→S | `CREATE_ROOM` | `{ nickname }` | 建立房間，回 `ROOM_CREATED { code }` |
| C→S | `JOIN_ROOM` | `{ code, nickname }` | 加入房間 |
| S→C | `ROOM_JOINED` | `{ code, isHost, players[], started }` | 加入成功 |
| S→C | `ROOM_FULL` | — | 房間滿員（非觀戰） |
| S→C | `SPECTATOR_JOINED` | `{ nickname, players[] }` | 以觀戰身份進入 |
| C→S | `SEND_MESSAGE` | `{ text }` | 發言 |
| S→C | `MESSAGE` | `{ from, text, ts }` | broadcast 發言 |
| S→C | `PLAYER_JOINED` | `{ nickname }` | 有人加入 |
| S→C | `PLAYER_LEFT` | `{ nickname }` | 有人離開 |
| C→S | `START_GAME` | `{ playerCount, ...config }` | 房主開始（後續） |
| C→S | `KICK_PLAYER` | `{ target }` | 房主踢人 |
| C→S | `CLOSE_ROOM` | — | 房主解散 |
| S→C | `ROOM_CLOSED` | — | 房間已解散，所有客戶端收到 |

## 7. 安全 / 限制

- 房間代碼：6 位大寫字母 + 數字（排除易混淆字符 0/O/1/I）
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

| # | 交付物 | 驗收標準 |
|---|---|---|
| M1 | 首頁 + 建立/加入房間 + WebSocket 連線 | 兩台瀏覽器可進同一房、互相看到對方加入 |
| M2 | 房間內打字 broadcast + 玩家列表 + 房主操作 | 多人同時打字、踢人、解散正常 |
| M3 | 觀戰模式 + 房間超時清理 | 加入已開始房間 → 只讀；空房 30 分鐘自動消失 |
| M4 | 遊戲設定面板（房主調人數等）+ START_GAME 事件 | 房主可設參數、觸發開始（遊戲邏輯後續接） |

## 10. 部署現狀

| 項目 | 狀態 |
|---|---|
| URL | `https://morowin.win/wolfgame/` |
| 伺服器 | `192.168.0.94`（Ubuntu，user `morowin`） |
| 靜態檔案 | `/var/www/wolf/`（nginx root） |
| 反向代理 | nginx（port 80）→ cloudflared tunnel → `morowin.win` |
| 隧道 | cloudflared service（systemd），routes：`morowin.win`→`:80`、`api.morowin.win`→`:9090` |
| 前端 | 已上線（純 HTML/CSS/JS，無 build step） |
| 後端 | 尚未實作（WebSocket 房間伺服器待 M1） |

### 更新前端部署流程

```bash
# 本機修改 ubuntu-web/ 後：
scp -i ~/.ssh/id_ed25519_mille22554 ubuntu-web/* morowin@192.168.0.94:/var/www/wolf/
# 或 git push 後在 server 上 git pull + 手動 copy
```

## 11. 待確認

- [x] 前端框架：原生 HTML/CSS/JS（已定）
- [x] HTTPS：cloudflared tunnel 已提供（已定）
- [x] 部署環境：Ubuntu 伺服器，無 GPU（已定）
- [ ] 房間代碼長度：6 位夠嗎？（72^6 ≈ 1.4 億組合，MVP 足夠）
- [ ] 是否需要在首頁顯示「進行中的房間」列表（讓玩家可以瀏覽加入）
