# Ubuntu 版規格書：多人實時狼人殺伺服器

分支：`ubuntu`
狀態：M1–M5 已完成並部署上線；M6（前端遊戲 UI）+ M7（AI 補位）待實作

**全文標記約定**（避免把「程式碼已寫好」誤讀成「線上已生效」）：

| 標記 | 意義 |
|---|---|
| 【已上線】 | production 已部署、實際可用 |
| 【source 現況】 | 程式碼已實作，但只有 `src/lobby-server/` 本身或外部 harness（`scripts/external-test-stage2.mjs`）走得到；正式多房 server runtime 尚未接線 |
| 【production 未接線】 | 該能力在正式 server（`server.ts` / `wolfgame.service`）上尚未生效 |
| 【目標／待實作】 | 規格目標，尚未實作或尚未驗證 |

> 判讀規則：`src/` 裡有程式碼 ≠ 線上會跑。AI（M7）相關內容目前一律帶標記。本文以 repo 內的 source／harness 為準，不處理遠端機器的實際設定。

## 1. 定位

外部真人玩家的線上狼人殺入口。支援 6–15 人房間，含完整遊戲流程（角色分配、夜間行動、白天討論投票、勝利判定）——此部分【已上線】（M1–M5）。真人不足時由 AI 補位（同機 SGLang 跑 Qwen3.8-27B）＝【目標／待實作】：AI 邏輯已在 source 與外部 harness（§13），**production server 尚未接線、行為驗證未完成**。

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
- 觀戰：可看對話紀錄、可發言（聊天）；不能操作（開始遊戲、踢人等）
- 房主離開：無手動轉讓；依入房時間（最早者）自動轉讓給下一位玩家
- 房間關閉：清空（無人）立即回收；無活動超時（預設 30 分鐘）自動清理

### 2.3 加入已開始的房間 → 觀戰模式
- 可看到對話紀錄、發言、投票結果
- 不能投票、不能提交夜間行動【已實作】（引擎只受理存活參戰玩家的 `handleVote` / `handleNightAction`）
- 標示「觀戰中」
- **【目標／待實作】** 遊戲內禁言目前未在 server 端強制：`SEND_MESSAGE` 不分參戰／觀戰、不檢查 alive／phase。這與 §2.2 的「觀戰可聊天」不衝突——那是 lobby 觀戰聊天室；這裡管的是遊戲內會議溝通區域（公頻 `MESSAGE`／私頻），只限存活參戰者（見 §12.4）。兩者是不同通道，不要搞混。

### 2.4 實時通訊
- 打字交流（跟 main 版一樣）
- 房間內 broadcast：發言、系統訊息（加入/離開/開始）
- 訊息有時間戳、發送者

## 3. 架構

```
┌─────────────────────────────────────────────────────┐
│  Ubuntu 伺服器（192.168.0.94）                       │
│                                                      │
│  ┌──────────┐    ┌──────────────────────┐           │
│  │ 前端靜態  │    │  Node.js 伺服器       │           │
│  │ (SPA)    │◄──►│  - WebSocket 路由     │           │
│  │          │    │  - 房間管理器          │           │
│  │          │    │  - 遊戲引擎（phase    │──┐       │
│  │          │    │    狀態機 + 結算）    │  │       │
│  └──────────┘    └──────────────────────┘  │       │
│                                       │  │       │
│                                       ┊  │       │
│                              ┌──────────────────┐ │
│                              │ SGLang            │ │
│                              │ (Qwen3.8-27B)    │ │
│                              │ port 9090         │ │
│                              │ OpenAI-compat API │ │
│                              └──────────────────┘ │
└─────────────────────────────────────────────────────┘
         ▲ WebSocket (wss://)
         │
   玩家瀏覽器（多人）
```

- **靜態檔由 Node 自己伺服**【已上線】：`server.ts` 直接讀 `ubuntu-web/`（`Cache-Control: no-cache`），同一個 HTTP server 同時掛 WebSocket；nginx 只做 `/wolfgame/` 反代 + WS upgrade，不直接託管靜態檔
- 單程序多房間：一個 Node 進程管理所有房間【已上線】
- 每房獨立狀態（玩家列表、對話紀錄、遊戲 phase）
- 房間回收：清空（無人）→ 立即回收；無活動超時（預設 30 分鐘，sweep 計時器每 60s 掃一次）→ 自動清理【已上線】
- **沒有** zero-client 自動終止、**沒有**「全掉線暫停 5 分鐘」：最後一人離開即回收（§5）
- 圖中虛線箭頭 `┊` =【production 未接線】的 AI／SGLang 路徑：`llm.ts` 與 `AiController` 在 source／外部 harness 可用，但 `server.ts` 開局只 `new GameEngine(...)`，不建立 AI 控制器（§13.7、§13.10）

## 4. 技術選型

| 層 | 選擇 | 理由 |
|---|---|---|
| 語言 | TypeScript | 與 main 分支共用類型定義、遊戲規則常數 |
| 伺服器 | Node.js + `ws`（WebSocket） | 已有模式；房間規模小（<20 人/房），Node 足夠 |
| 前端 | 原生 HTML/CSS/JS（已定，見 §11） | 頁面簡單（首頁 + 房間），不需重框架 |
| 實時通訊 | WebSocket（沿用 main 的 `ws` 模式） | 打字交流需要低延遲 bidirectional |
| 狀態持久化 | 記憶體為主【已上線】 | MVP 不需資料庫；server 重啟房間重置。`saveState()` / `restoreState()` 的 JSON 快照目前只有外部 harness 用（`--save-state` / `--resume`），production 不用 |
| 部署 | systemd `wolfgame`（Node 靜態＋WS）+ nginx 反代 + cloudflared tunnel | 前端與後端 M1–M5 已上線【已上線】；nginx 不再直接託管靜態檔（§3、§10） |
| AI 後端 | SGLang（Qwen3.8-27B，OpenAI-compatible）【production 未接線】 | `llm.ts` 已實作；`wolfgame.service` 未宣告 SGLang 依賴／未注入 API key，server 也未建立 `AiController`（§13.10） |

### 與 main 分支的關係
- **共用**：遊戲規則常數（角色定義、勝利條件）、類型定義（`Role`、`PlayerState`）、LLM client 模式（OpenAI-compatible API 呼叫）
- **獨立**：伺服器架構（main 是單人本地，ubuntu 是多房多人）、前端（main 是 Electron 桌面，ubuntu 是網頁）、房間管理
- 若共用代碼維護成本 > 獨立，則完全分開，只 sync 規則常數

## 5. 房間生命週期

```
建立 → Lobby（等待玩家）→ 遊戲中（Night/Day 循環）→ 結束 → 清理
                │                    │
                │                    └── 遊戲中斷（房主解散）→ 回到 Lobby【目標／待實作：WS 協定沒有「解散」事件】
                ├── 房主離開 → 依入房時間自動轉讓【已上線】
                ├── 清空（無人）→ 立即回收【已上線】（最後一人離開即回收，含「全部掉線」情況）
                ├── 無活動超時（30 分鐘）→ 自動清理【已上線】（room-manager sweep，每 60s 掃一次）
                └── 觀戰者隨時可進出【已上線】
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
| S→C | `MESSAGE` | `{ from, text, ts }` | broadcast 發言。**AI 白天發言 prompt 產出的發言也走這個事件**（`sendDayMessage`），不另開新事件 |
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

## 8. 不做（排除）

- 帳號系統
- 持久化（重啟即清空）
- 跨房間通訊
- 語音
- 多模型切換（固定 Qwen3.8 27B）

## 9. 里程碑

| # | 交付物 | 驗收標準 | 狀態 |
|---|---|---|---|
| M1 | 首頁 + 建立/加入房間 + WebSocket 連線 | 兩台瀏覽器可進同一房、互相看到對方加入 | ✅ |
| M2 | 房間內打字 broadcast + 玩家列表 + 房主操作 | 多人同時打字、踢人正常 | ✅ |
| M3 | 觀戰模式 + 房間回收（清空立即 / 超時 30 分鐘）| 加入已開始房間 → 只讀；空房立即回收、無活動 30 分鐘自動清理 | ✅ |
| M4 | 遊戲設定面板（房主調人數等）+ START_GAME 事件 | 房主可設參數、觸發開始 | ✅ |
| M5 | 遊戲核心：角色分配 + 夜間行動 + 白天投票 + 勝利判定（server-side） | 完整一局可跑完（6 人局）；夜間行動等待制正常；投票平票處理正確 | ✅ |
| M6 | 前端遊戲 UI：角色揭示 + 夜間操作面板 + 投票面板 + phase 指示 + 死亡公告 + 結算畫面 | 真人可完整操作一局；各角色看到正確資訊 | ⬜ |
| M7 | AI 補位：LLM client + AI 控制器（狼／共有者／白天 loop，含 judge 盲選＋記憶合併＋發言） | 1 真人 + 5 AI 可跑完整局；AI 發言自然、投票有邏輯、夜間行動合法；LLM 失敗以重試處理，server 掛 → 開新局。**現況：source／外部 harness 已可跑 15 人全 AI 局（§13.6a）；production server 尚未接線、oracle／server 行為驗證未完成** | ⬜ |

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
| 前端 | 已上線（純 HTML/CSS/JS，無 build step）；頁尾「v0.1 · 前端畫面原型」是殘留的舊 label |
| 後端 | 已上線（WebSocket 多房伺服器，**M1–M5** 完成）；靜態檔由 Node 伺服，nginx 只反代 |
| AI（SGLang） | 【production 未接線】`server.ts` 尚未建立 `AiController`；`wolfgame.service` 無 SGLang 依賴、無 API key 注入（§13.9、§13.10） |

### 部署流程

```bash
# 本機：修改 src/ 或 ubuntu-web/ 後
npm run build          # 若改了 src/（dist/ 有 commit 進 git，src＋dist 必須一起 commit）

# 明確暫存（不要 git add -A：會帶入 game-state.json 等 runtime 存檔雜訊）
git add src/lobby-server dist/lobby-server   # 改了 src 時（含編譯產物）
git add ubuntu-web deploy docs                # 改了前端／部署設定／文件
git commit -m "..."; git push

# Server（SSH config 視裝置選用：A 裝置用 `~/.ssh/config`，B 裝置用下例路徑；目前環境＝B，不確定時先問）：
# A 裝置：
ssh -F ~/.ssh/config ssh.morowin.win \
  "cd /opt/wolfgame && git pull && sudo systemctl restart wolfgame"
# B 裝置：
ssh -F "C:\Users\user\Desktop\FrankTests\.ssh\config" ssh.morowin.win \
  "cd /opt/wolfgame && git pull && sudo systemctl restart wolfgame"
```

- **不要 `git add -A`**：`game-state.json`（repo 根目錄）是 runtime 存檔且被 git 追蹤，跑一局就會變動，混進 feature commit 會污染 diff；Windows 端還會出現 `LF will be replaced by CRLF` 之類的行尾警告。只暫存本次確實修改的路徑。
- nginx 配置：`deploy/nginx-wolfgame.conf`（已部署至 `/etc/nginx/sites-enabled/`，只做 `/wolfgame/` 反代 + WS upgrade）
- systemd unit：`deploy/wolfgame.service`（已部署至 `/etc/systemd/system/`，enabled；目前只有 `After=network.target` + `Environment=PORT=2640`，**未**依賴 sglang-server、未注入 API key → §13.10）
- 前端快取：`Cache-Control: no-cache` + `index.html` 內 `app.js?v=N` 版本號（改動前端時 bump N）

## 11. 待確認

- [x] 前端框架：原生 HTML/CSS/JS（已定）
- [x] HTTPS：cloudflared tunnel 已提供（已定）
- [x] 部署環境：Ubuntu 伺服器，無 GPU（已定）
- [x] 房間代碼長度：4 位數字（10^4 = 1 萬組合，MVP 足夠；首位非 0）
- [ ] 是否需要在首頁顯示「進行中的房間」列表（讓玩家可以瀏覽加入）

## 12. 遊戲流程（M5+）

### 12.1 Phase 狀態機

```
LOBBY ──(START_GAME)──► ROLE_REVEAL ──(10s)──► NIGHT
                                                       │
                                                       ▼
         ┌─────────── GAME_OVER ◄──(win check)── DAY_RESULT
         │                                        │
         │         ┌──────────────────────────────┘
         │         ▼
         │    DAY_VOTING ◄──(all players toggle ready)── DAY_DISCUSSION
         │         │
         └─────────┘  (next night)
```

| Phase | 說明 | 結束條件 |
|---|---|---|
| `ROLE_REVEAL` | 各玩家看到自己的角色（私發）；人狼互見、共有者互見 | 10 秒（固定） |
| `NIGHT` | 收集夜間行動：人狼刀人、占い師查人、守衛護人 | 所有有行動的玩家皆已提交 |
| `NIGHT_RESULT` | 公布昨晚結果（死者/平安夜）；霊能者收到黎明資訊 | 10 秒（固定） |
| `DAY_DISCUSSION` | 全存活玩家自由發言（走遊戲內公頻 `MESSAGE`，與 lobby 聊天室不同通道） | 所有存活玩家 toggle「準備投票」ON（不限時，同狼會議模式）；或房主送 `END_DISCUSSION` 提前結束（已實作） |
| `DAY_VOTING` | 全存活玩家投票（含棄票） | 所有存活玩家皆已投票 |
| `DAY_RESULT` | 公布投票結果（死者身分不公開）；霊能者得知票死者陣營 | 10 秒（固定） |
| `GAME_OVER` | 公布所有角色、勝負結果 | 永久（直到房間解散/重開） |

> **不限時設計**：NIGHT / DAY_DISCUSSION / DAY_VOTING 皆等待所有玩家完成行動才推進。玩家可從容思考，不被倒數逼迫【已上線】。掉線處理見 §5：房間清空（無人）→ 立即回收；無活動超時（預設 30 分鐘）→ 自動清理。**沒有**「全部掉線 → 暫停 5 分鐘」機制。

- 每輪：`NIGHT → NIGHT_RESULT → DAY_DISCUSSION → DAY_VOTING → DAY_RESULT → (win check) → NIGHT...`
- Day 1 的 NIGHT 之前沒有「昨晚結果」，ROLE_REVEAL 直接進 NIGHT
- Day 1 的 NIGHT_RESULT 公布第一夜結果

### 12.2 角色分配

- 沿用 main 分支 `ROLE_CONFIG` 表（`src/types.ts`），依實際人數查表 → shuffle → 分配
- 分配對象：僅「參戰」玩家（觀戰者不分配）
- 共有者（MASON）：13+ 人才有；分配後互設 `masonPartnerId`
- 人狼：互設 `wolfPartnerIds`（知道所有同夥）
- 狂人：人狼知道他是誰（`madmanId`），狂人不知道誰是人狼

### 12.3 夜間行動（NIGHT phase）

> **【契約】** 本節描述遊戲規則與狼／共有者夜間會議 loop。狼會議 loop 以本節「統一夜間會議 loop」為準（status-first 策略制）。目前正式多房 server 尚未建立 `AiController`，線上不會自行驅動 AI 私頻會議（§13.7）。

各角色可提交的行動：

| 角色 | 行動 | 限制 |
|---|---|---|
| 守衛 | `GUARD_PROTECT { targetId }` | Day1 不可；不可自護（自護→隨機護他人）；可連續護同一人 |
| 共有者 | `MASON_END_TURN`（toggle） | 雙人都 ON 才解鎖狼的環節；可隨時 toggle 開/關 |
| 人狼 | 狼會議 → `WOLF_KILL { targetId }` | 全部狼 toggle「準備投票」ON → 投目標；平票（1:1, 1:1:1）→ 回討論重來；不可選自己／狼隊／狂人 |
| 占い師 | `SEER_CHECK { targetId }` | 不可選自己；每夜一次 |
| 霊能者 | 無（被動） | 黎明自動收到昨日票死者陣營 |
| 村民/狂人 | 無 | — |

**結算順序**（server-side，依序解鎖）：
1. 守衛護 → 記錄 `guardedTargetId`
2. 共有者回合結束 → 雙人都 toggle ON 才解鎖下一步（toggle：按開＝我好了，再按＝關掉重來）
3. 人狼刀 → 狼會議流程（見下方）；若目標 == guardedTargetId → 平安夜（kill blocked）；否則目標死亡
4. 占い師查 → 結果僅發給占い師
5. 黎明：霊能者收到「昨天被票死者」的陣營（Day1 無）

**統一夜間會議 loop**（狼會議＝step 3、共有者會議＝step 2 的內部流程）

狼會議與共有者會議走**同一套 loop**，只有參與者、議題、對話紀錄與收斂後動作不同。每輪的核心是「想講的人先出策略 → 選一篇 → 講成一句話」。

| | 狼會議 | 共有者會議 |
|---|---|---|
| 參與者 | 所有存活人狼 | 2 個存活共有者（存活 < 2 → 直接 toggle ON、不開會） |
| 議題 | 今晚刀誰 ＋ 票怎麼投 ＋ 明天白天怎麼演 | 明天白天的行動方針（CO 利弊、分工、對狼可能行動的應對） |
| 對話紀錄 | `WOLF_MESSAGE`（所有狼可見） | `MASON_MESSAGE`（僅共有者雙方可見） |
| 收斂後動作 | 各狼投票（`WOLF_KILL`，沿用現行 `runWolfVoting`） | 雙方 toggle ON（解鎖狼的環節） |
| 平票處理 | 回討論重來（round+1） | 不適用 |

**每輪流程：**

1. **出策略**：本輪參與者＝存活成員中排除上一句發言人（首輪全員）。每人一次 LLM 呼叫（`reasoning_effort=medium`、`temperature=1.0`），各自獨立、互不可見；每人重出策略即重評，先前 `ready` 者讀到新發言可改 `speak`／`wait`（＝撤回）。
   - 輸出為自由體文字，**第一行**必須是 `status: speak|wait|ready`＋一句理由（看到了什麼、為什麼是這個狀態）。
   - `speak`：想發話，第一行之後接策略主文（800 字內、條列）。只有 `speak` 會出策略文、會發言。
   - `wait`：資訊不足但不想發話；不出策略文。
   - `ready`：討論內容已足夠擬定行動基準；不出策略文。資訊不足時禁止 `ready`。
2. **validator（server 端）**：
   - 第一行比對 `/^status:\s*(speak|wait|ready)\b/i`；比對不到 → 不合格。
   - `speak` 但第一行之後的正文 ≤ 150 字 → 不合格（沒附策略）。
   - `wait`／`ready` 但正文 > 150 字 → 不合格（不該帶策略）。
   - 不合格 → 整份重新生成，**最多 3 次**；3 次都不合格 → 視為 `wait`。
   - 狀態一致性只靠 validator，不依賴 prompt 內的自我檢查。
3. **選稿**：
   - 0 人 `speak` → 跳到 ⑥ 收斂判斷。
   - 1 人 `speak` → 直接入選，不跑 judge。
   - ≥ 2 人 `speak` → **judge 盲選**（`medium`）：策略以 `[1]`、`[2]`… 編號、不標作者；輸出 `{"scores":[n,...],"best":N}`，**`best` 為 1-based**（`best=1` 指第 1 篇）。`best` 超出範圍或解析失敗 → 取最高分；全部失敗 → 隨機（不阻塞）。
4. **記憶合併**（`xhigh`）：入選者「夜間策略記憶專區」舊文＋新入選策略 → 一次 LLM 整合（保留仍成立的、更新被推翻的、衝突只留一個），原地取代專區。落選策略、`wait`／`ready` 不寫入。
5. **發言**（`xhigh`）：入選策略 → 講成一句接續目前局面的口語發言（prompt 結構見下方），發布到對話紀錄；發言者視為 ready。LLM 失敗重試 3 次後，以策略主文（去掉 status 行）發布，不阻塞會議。發言不得新增策略外的行動、對象或結論；發布邊界 OpenCC `cn→tw` 強轉繁體。發布後回到 ①。
6. **收斂判斷**（本輪無人 `speak` 時）：
   - 參與者全為 `ready` → **收斂**（狼 → 投票；共有者 → 雙方 toggle ON）。
   - 有人 `wait` → 對 `wait` 者重發策略 prompt 並附「本輪不可 wait」，再走一次 ①–⑤；這次仍無人 `speak` → 收斂（不無限等待）。
   - 每輪所有非發言者都重新評估；先前 `ready` 的人看到新發言後可以改成 `speak`／`wait`。

**狼投票（收斂後）**：沿用現行機制——各狼依會議內容各自提交 `WOLF_KILL { targetId }`（`buildWolfKillPrompts` 帶狼對話紀錄全文）；最高票者為刀人目標；平票 → round+1 回到 ① 重新討論。不要求會議中三狼講好同一人。

**安全上限（測試用）**：對話紀錄累計 100 句仍未收斂 → 停止並報告（不自動收斂、不強制決選）。夜間與白天同一條。

**與白天會議的差異**：狼會議平票 → 回討論（重來）；白天會議平票 → 無人出局（不重來，見 §12.5）。

**結束條件**：
- 所有有夜間行動的玩家（存活狼 + 占い師 + 守衛）皆已提交 → 立即結算
- 未提交的玩家會一直等待（前端顯示「等待中…」）
- 人狼刀：狼會議收斂後各狼投票決出刀人目標；平票→回討論重來
- 若某角色已全數死亡（如占い師已死）→ 該角色不需提交，不阻塞 phase 結束

**夜間會議 prompt 結構**（逐字全文以 `docs/strategy-prompt-variables.md` 為準）：

一律繁體中文。訊息分兩段：system＝身分＋行事風格；user＝其餘段落。

- **策略 prompt**（段落順序）：
  1. `## 身分`：「你是「{名字}」（日本{出身地}人），{陣營}{角色}。{夥伴標籤}：{夥伴}。」＋「出身地只用於說話口吻，與人際關係無關」。出身地由固定對照表指定（每名角色一個縣）。
  2. `## 行事風格`：取 `character/<id>/agents.md` 的「## 性格與說話方式」整段（不截字數、不取其他段）。
  3. `## 遊戲規則`：全會議共用同一份規則文字。
  4. `## 進度`：第 N 夜的{狼／共有者}會議、存活名單；狼另帶「可刀目標（排除自己／狼隊／狂人）」與「狂人：{名字}（他不知道你們是誰，不可刀他）」；「對話紀錄：」接 `第 N 句　{名字}：「…」` 逐句列出，無則「（無）」。
  5. `## 記憶`：夜間策略記憶專區內容（非空才帶）。
  6. `## 任務`：陣營任務一句（狼：與狼隊擬定今晚刀人目標、評估各候選利弊、推敲村方下一步；共有者：與夥伴擬定明日白天行動策略、評估 CO 利弊、推敲狼可能行動）＋共用行：會議是當面口頭討論，不是傳訊息，沒出聲的人是在聽；熟讀規則／進度／提點／回覆要求；ready／speak／wait 的使用紀律。
  7. `## 戰術提點`：全會議共用同一份；針對村民陣營的條目以「對於村民陣營」開頭，中性條目不加。包含「遊戲沒有位置概念，名單順序不代表任何意義」。
  8. `## 回覆內容要求`：策略主文 800 字內、條列、不重複；必含項目依會議（狼：今晚刀誰、票怎麼投、明天白天怎麼演；共有者：明日目標、誰做什麼、對手兩種反應的應對）；不要空泛標語／重複論點／裝飾性收尾；定案用日常說法、不用遊戲黑話；講投票對象直接講人名，不用「方向」「線」代指；第一行 status＋理由，只有 `speak` 接策略主文。
- **發言 prompt**：`## 身分`／`## 行事風格`／`## 遊戲規則`／`## 進度`（同策略）→ `## 你剛剛讀完最新發言後想的策略`（入選策略全文）→ `## 任務`（從策略挑出對話紀錄上還沒講過的新論點或對舊論點的補充／修正，轉成一句接續目前局面的話；已講過且無新角度的不再講，不替夥伴說完）→ `## 回覆內容要求`（簡短且好懂、每句主詞清楚、繁體、口語像真人、實際口頭對話不是筆談、不自創機制、不捏造歷史、禁大陸用語與遊戲黑話、改寫後重讀確認通順且對照策略原句意思沒變、代名詞指涉清楚、自己提過的事被接受時不說「同意」或「照你說的」等）。
- **judge prompt**：N 篇策略（編號、不標作者）→ `## 遊戲規則` → `## 進度` → `## 任務`（評分標準＋只回 JSON）。
- **記憶合併 prompt**：既有夜間策略（記憶專區，無則「（無）」）＋新入選策略 → 任務：整合成一份現行策略（保留仍成立的、更新被推翻的、衝突只留一個），條列 800 字內，不解釋合併過程。

**LLM 參數**：策略與 judge `reasoning_effort=medium`；記憶合併與發言 `xhigh`；`temperature` 一律 1.0。

**仍不變的硬規則**：
- 不暴露陣營同盟給私頻以外的人（私頻只有成員看到）
- 第 1 天沒有發言可引用 → 不對未發言玩家下判斷
- 質疑必須引用實際發言（第 2 天起）

### 12.4 白天討論（DAY_DISCUSSION）

- 遊戲內公頻 `SEND_MESSAGE` / `MESSAGE`（WS 型別與 lobby 共用，但屬不同通道）【已上線】
- **無私頻**：WOLF_CHAT / MASON_CHAT 僅 NIGHT 可用，白天只有公頻
- 結束方式：所有存活玩家 toggle「準備投票」ON → 進入投票（同狼會議模式，可隨時 toggle 開/關）【已上線】；房主另可送 `END_DISCUSSION` 提前結束（已實作）
- **AI 驅動**：AI 玩家走與夜間同一套 loop（見 §12.3），完整流程見 §13.6a。核心順序：
  1. 出策略：本輪參與者＝存活 AI 中排除上一句發言人（首輪全員），各出一份 status-first 策略（`Promise.all`，互不可見）；每人重出策略即重評，先前 `ready` 者讀到新發言可改 `speak`／`wait`（＝撤回）
  2. validator（server 端）：同 §12.3 ②（第一行 status＋正文檢查；不合格重生最多 3 次，仍不合格視為 `wait`）
  3. 選稿：0 人 `speak` → 跳到 ⑥；1 人 `speak` 直接入選；≥ 2 人 `speak` → judge 盲選一篇（只讀策略、不標作者）
  4. 記憶合併：入選者記憶專區舊文＋新策略 → 整合版寫回
  5. 發言：入選策略轉成一句口語發言（3 次重試；全失敗 → 以策略主文去掉 status 行發布，不阻塞）；經**既有** `MESSAGE` 廣播到公頻（`sendDayMessage`）→ **公頻沒有新增 WS 事件**；發言者視為 ready，發布後回到 ①
  6. 收斂判斷（本輪無人 `speak` 時）：全為 `ready` → 收斂，進 `DAY_VOTING`；有人 `wait` → 對 `wait` 者附「本輪不可 wait」重發一次，再走一次 ①–⑤，仍無人 `speak` → 收斂
- **【production 未接線】** 正式 server 開局只建立 `GameEngine`，不建立 `AiController` → 線上真人局目前沒有 AI 發言（§13.7）
- **【目標／待實作】已死亡玩家不能發言**：`SEND_MESSAGE` 目前只檢查「在房內」＋200 字上限（`room-manager.sendMessage`），**不檢查 alive／phase** → 死者（與觀戰者）目前仍能在公頻打字。前端灰化屬 M6。
- **【目標／待實作】** 公頻可見範圍的 server 端區分（觀戰者 vs 參戰 vs 死者）尚未實作；目前一律 broadcast 全房。

### 12.5 投票（DAY_VOTING）

- 全存活玩家各投 1 票：`CAST_VOTE { targetId }` 或 `CAST_VOTE { targetId: null }`（棄票）
- 不可投自己
- 等待所有存活玩家皆已投票（含棄票）→ 立即結算
- 結算：票最高者出局；**最高票不唯一（平票）→ 無人出局**：`tie=true`、`eliminatedClientId=null`（已實作，不隨機、不淘汰）
- 棄票（`null`）不計入計票
- 被票死者身分不公開（僅霊能者得知其陣營）

### 12.6 勝利判定

每輪 DAY_RESULT 後檢查：
- **狼數** = 存活人狼 + 存活狂人
- **村數** = 存活村民 + 占い師 + 守衛 + 霊能者 + 共有者（不含狂人）
- **村勝**：狼數 == 0（所有狼＋狂人都死）
- **狼勝**：狼數 ≥ 村數
- 平局不可能（狼 ≥ 村 時狼已勝）

### 12.7 死亡規則

- 夜殺：身分完全不公開（任何人不知道，含霊能者）
- 票死：身分不公開（僅霊能者得知其陣營）
- 死者不投票、不提交夜間行動【已實作】（引擎 `handleVote` / `handleNightAction` 都檢查 `alive`）
- 死者不發言（公頻）【目標／待實作】：`SEND_MESSAGE` 未檢查 alive／phase，見 §12.4
- 死者不操作（前端灰化）＝ M6【目標／待實作】
- 死者可看公頻聊天（觀戰）
- 狂人死 → 狼數 -1（狂人算狼）

### 12.8 新增 WS 協議

| 方向 | type | payload | 說明 |
|---|---|---|---|
| C→S | `NIGHT_ACTION` | `{ type: 'WOLF_KILL'\|'SEER_CHECK'\|'GUARD_PROTECT', targetId }` | 提交夜間行動 |
| C→S | `TOGGLE_MASON_END_TURN` | — | 共有者 toggle 回合結束（開/關） |
| C→S | `TOGGLE_WOLF_READY` | — | 人狼 toggle「準備投票」（開/關） |
| C→S | `TOGGLE_VOTE_READY` | — | 存活玩家 toggle「準備投票」（開/關），全部 ON → 進投票（已實作；每次 toggle 都會 broadcast `DAY_READY_STATUS`） |
| C→S | `END_DISCUSSION` | — | 房主提前結束白天討論 → 直接進 `DAY_VOTING`（已實作；非房主或不在 `DAY_DISCUSSION` 時忽略） |
| C→S | `CAST_VOTE` | `{ targetId: number \| null }` | 投票（null=棄票） |
| C→S | `WOLF_CHAT` | `{ text }` | 人狼私頻發言（僅 NIGHT） |
| C→S | `MASON_CHAT` | `{ text }` | 共有者私頻發言 |
| S→C | `PHASE_CHANGED` | `{ phase, day }` | phase 切換通知（broadcast 全房） |
| S→C | `NIGHT_STEP_CHANGED` | `{ step: 'guard'\|'mason'\|'wolf'\|'seer' }` | NIGHT 內部子步驟切換（broadcast）（**待實作**；`src/lobby-server` 目前沒有發這個事件，步驟切換只隱含在 `PHASE_CHANGED` 與各步驟自身的 ready 事件中） |
| S→C | `MASON_END_TURN_STATUS` | `{ ended: [{ id, nickname }] }` | 哪些共有者已 toggle ON（僅發給共有者）（**待實作**；目前用個別 `MASON_READY` 事件） |
| S→C | `WOLF_READY_STATUS` | `{ ready: [{ id, nickname }], voting: bool }` | 哪些狼已準備投票 + 是否進入投票環節（僅發給狼）（**待實作**；目前用個別 `WOLF_READY` 事件） |
| S→C | `MASON_READY` | `{ clientId, ready }` | 個別共有者 toggle 結果（**已實作**；`handleToggleMasonEndTurn` 每次 toggle 都 broadcast；雙方全 ON → 自動解鎖下一步） |
| S→C | `WOLF_READY` | `{ clientId, ready }` | 個別狼的 ready 狀態（**已實作**；只 broadcast 存活狼；全狼 ON → 引擎切到狼會議 `VOTING` 子階段） |
| S→C | `WOLF_VOTE_SPLIT` | `{ votes: Record<number, number> }` | 狼投票平票→回討論（僅發給狼）（**已實作**：ready 全重置、votes 清空、`wolfMeetingRound`+1） |
| S→C | `WOLF_SPEECH_SELECTED` | `{ round, from, text }` | judge 選出的代表發言（**已實作**；`text` 為發言 prompt 產出的一句口語，失敗時為策略主文；僅發給狼，其他狼讀完表態） |
| S→C | `MASON_SPEECH_SELECTED` | `{ round, from, text }` | 共有者 judge 選出的代表發言（**已實作**；`text` 同樣是發言 prompt 產出的一句口語或 fallback 策略主文；僅發給共有者雙方） |
| S→C | `WOLF_MEETING_ABORTED` | `{ count, reason }` | 狼會議安全上限觸發：對話紀錄累計 100 句未收斂 → 停止並通知（**已實作**；僅測試用 `wolfMessageCap > 0` 時啟用；觸發後不再受理 `WOLF_CHAT`／`TOGGLE_WOLF_READY`，不自動收斂、不強制決選） |
| S→C | `DAY_READY_STATUS` | `{ ready: [{ id, nickname }], total: number }` | 哪些玩家已準備投票（**已實作**；進入 `DAY_DISCUSSION` 時先 broadcast 一次全 false，每次 `TOGGLE_VOTE_READY` 再 broadcast；對象為全房，含觀戰者） |
| S→C | `ROLE_REVEALED` | `{ role, displayName, description, partners? }` | 私發各玩家自己的角色 |
| S→C | `NIGHT_RESULT` | `{ peacefulNight: bool, deaths: [{ id, nickname }] }` | 夜間結果（broadcast） |
| S→C | `SEER_RESULT` | `{ targetId, nickname, result: 'villager'\|'werewolf' }` | 私發占い師 |
| S→C | `GUARD_RESULT` | `{ targetId, nickname, blocked: bool }` | 私發守衛 |
| S→C | `MEDIUM_RESULT` | `{ targetId, nickname, result: 'villager'\|'werewolf' }` | 私發霊能者（黎明） |
| S→C | `VOTE_RESULT` | `{ votes: Record<number, number>, eliminatedId: number\|null, tie: bool }` | 投票結果（broadcast） |
| S→C | `PLAYER_ELIMINATED` | `{ id, nickname, cause: 'wolf_kill'\|'vote' }` | 有人出局（broadcast） |
| S→C | `GAME_OVER` | `{ winner: 'village'\|'werewolf', players: [{ id, nickname, role, alive }] }` | 終局（broadcast，公布全部角色） |
| S→C | `WOLF_MESSAGE` | `{ from, text, ts }` | 人狼私頻（僅存活人狼）。`text` 為發言 prompt 產出的一句口語；失敗時為策略主文 |
| S→C | `MASON_MESSAGE` | `{ from, text, ts }` | 共有者私頻（僅雙方）。`text` 為發言 prompt 產出的一句口語；失敗時為策略主文 |

> **AI 白天發言不新增事件**：AI 白天發言 prompt 產出的發言直接走既有 `MESSAGE`（公頻），與真人 `SEND_MESSAGE` → `MESSAGE` 同一路徑（§12.4、§13.6a）。
>
> **【source 現況】** 上表「已實作」＝`src/lobby-server` 真的會送這個事件；「待實作」＝規格已定但程式碼沒有對應事件。`MASON_READY` / `WOLF_READY` / `DAY_READY_STATUS` / `WOLF_VOTE_SPLIT` / `WOLF_SPEECH_SELECTED` / `MASON_SPEECH_SELECTED` / `WOLF_MEETING_ABORTED` 目前主要由引擎回呼觸發、並被外部 harness 觀察；**正式 server 尚未接 AI 控制器**（§13.7），所以線上不會有 AI 觸發的那些事件。

### 12.9 前端 UI 需求（M6）

| 元件 | 說明 |
|---|---|
| Phase 指示器 | 頂欄顯示當前 phase（夜／晝）+ 天數 + 等待狀態（「等待 N 人行動…」） |
| 角色揭示畫面 | ROLE_REVEAL phase 全螢幕顯示自己的角色（10 秒後自動消失） |
| 夜間操作面板 | 依角色顯示不同 UI：人狼→選目標（排除自己／狼隊／狂人）；占い師→選目標；守衛→選目標（Day1 灰化） |
| 人狼私頻 | 僅人狼可見的聊天區（可折疊） |
| 投票面板 | DAY_VOTING 時顯示所有存活玩家按鈕 + 棄票按鈕 |
| 死亡公告 | NIGHT_RESULT / DAY_RESULT 時全螢幕 toast（3 秒） |
| 玩家狀態更新 | 死亡玩家灰化 + ☠ 標記；不能發言/投票 |
| 結算畫面 | GAME_OVER 全螢幕：勝負結果 + 全部角色揭露 |
| 霊能者/占い師/守衛私訊 | 各自的結果以 toast 顯示（僅自己可見） |

### 12.10 與 main 分支共用

- `ROLE_CONFIG`、`Role`、`Team`、`ROLE_TEAM`、`seerSeesAs()` 等常數/函式 → 直接 import 或 copy
- `assignRoles()`、`checkWinCondition()` 邏輯 → 可復用（需確認 import path）
- `night.ts` 的結算邏輯 → 可復用（需改為 async 等待模式）
- **不共用**：`engine.ts`（事件佇列太複雜）
- **參考（非 runtime）**：`ai-scheduler.ts` 的 SpeechScheduler 管線邏輯（PRE_SPEECH→JUDGE→SELECT→EXPAND→BROADCAST）只在 §13.6 保留作 main 分支參考；ubuntu 版實際用 `ai-controller.ts` 自有 loops
- `character-session.ts` 的 prompt 結構可參考；ubuntu 版的 persona／memory 載入走 `ai-player.ts` 的 `loadCharacterProfile()`
- ubuntu 版用更簡單的 **phase 狀態機 + 直接 state mutation** 模式（不需 event queue）

### 12.11 私頻頻道（混合模式：真人 raw chat ＋ AI 結構化 loop）

| 頻道 | 可用 phase | 可見範圍 | 功能定位 |
|---|---|---|---|
| 狼會議（`WOLF_CHAT`） | `NIGHT`（限 `nightStep === 'WOLF'`） | 所有存活人狼 | 協調刀人目標（「我們刀 3 號吧」） |
| 共有者交談（`MASON_CHAT`） | `NIGHT`（限 `nightStep === 'MASON'`） | 僅共有者雙方 | 確認彼此身分、交換情報 |

**兩種驅動方式共存：**
- **真人 = raw chat【已上線】**：玩家送 `WOLF_CHAT` / `MASON_CHAT` → server 原樣收進該對話紀錄並 broadcast（`handleWolfChat` / `handleMasonChat`），**不經過 judge、不經過 AI loop**，也沒有結構化收斂。
- **AI = 結構化 loop**：AI 狼／共有者由 `AiController` 驅動（出策略 → validator → judge 盲選 → 記憶合併 → 發言 → 收斂），見 §12.3。**目前只有外部 harness 會建立 `AiController`；正式 server 未接線**，所以線上房間裡 AI 不會發言。
- 兩者共用同一組對話紀錄事件（`WOLF_MESSAGE` / `MASON_MESSAGE`），payload 格式相同。

**規則：**
- 已死亡玩家不能發送任何私頻訊息（含狼、共有者）【已實作】（server 端檢查 phase／nightStep／role／alive）
- 人狼死亡 → 剩餘存活狼仍可用狼會議【已實作】（broadcast 目標＝存活狼名單）
- 私頻訊息**不記錄在公頻**，其他玩家完全看不到【已實作】
- 觀戰者看不到任何私頻【已實作】（私頻 broadcast 只指定狼／共有者的 clientId 清單）
- 訊息格式與公頻相同：`{ from, text, ts }`【已實作】
- 每則訊息上限 200 字（與公頻相同）【已實作】（`MAX_MESSAGE_LEN`；引擎 `handleWolfChat` / `publishMasonSpeech` 也會擋）
- 共有者一方死亡 → 該頻道停用（剩下一方無法對話）：server 端**沒有**停用判定——殘存方仍可自己發 `MASON_CHAT`，broadcast 對象只有自己（已死亡的夥伴若仍在線仍會收到）。AI 端另有限制：存活共有者 < 2 人時 `runMasonDiscussion` 直接 toggle ON、不開會。

**與 main 分支的差異：**
- main 分支的「狼隊會議」是 LLM 驅動的結構化對話（多輪 back-and-forth 後投票決選）
- ubuntu 版是**混合**：真人打字即時 broadcast（協調整合）；AI 走 §12.3 的結構化 loop（目前僅 harness 接線）
- 狼隊最終刀誰仍由各自提交 `WOLF_KILL` 決定（多數決），私頻／會議只是協調工具

## 13. AI 補位（M7）

### 13.1 定位

- 真人參戰者 < 實際開局人數時，AI 補滿剩餘席位【目標／待實作：正式 server 尚未計算 AI 名額、尚未建立 AI 席位】
- AI 玩家與真人玩家完全同權：發言、投票、夜間行動、私頻聊天【目標／待實作】
- 前端視角：AI 玩家與真人玩家完全無區別（不加任何符號/標記，不暴露「這是 AI」）【目標／待實作（前端 M6）】
- 房主可純 AI 局（0 真人參戰 + N AI，真人全部觀戰看 AI 內鬥）也可混合局（1+ 真人 + 剩餘 AI 補位）或全真人局（0 AI）【目標／待實作】
- **【source 現況】** 外部 harness `scripts/external-test-stage2.mjs` 可直接建 15 人全 AI 局（`new AiController(...)` + `new GameEngine(...)`）——這是驗證途徑，**不等於**線上多房 server 的行為

### 13.2 LLM 端點

| 項目 | 值 |
|---|---|
| 模型 | Qwen3.8-27B-AWQ（INT4，mattbucci 量化）+ DSpark 推測解碼 |
| 推理引擎 | SGLang（`sglang-server.service`） |
| 位址 | `http://127.0.0.1:9090`（同機 localhost） |
| API 格式 | OpenAI-compatible（`POST /v1/chat/completions`） |
| 認證 | `Authorization: Bearer ${SGLANG_API_KEY}`（env 變數，部署時注入） |
| 環境變數 | `SGLANG_API_KEY`、`LLM_MODEL`（model name，預設 `qwen3.8-27b`）、`LLM_REASONING_EFFORT`（選填；Qwen3.8-27B 的 `xhigh`／`medium`／`low`） |
| 併發排程 | `x-override-priority` header（併發呼叫時 100+i 錯開；SGLang 依 priority 排序處理） |
| 併發限制 | `--max-running-requests 2`（多請求自動排隊，依 priority 順序處理） |
| reasoning effort | 夜間與白天同一套 loop，逐次指定（策略／judge `medium`、記憶合併／發言 `xhigh`，見 §12.3）；未逐次指定的呼叫沿用 `LLM_REASONING_EFFORT` |
| 呼叫 timeout | 無（`llm.ts` 呼叫不設 timeout，等待回傳；reasoning model 長 prompt 可能 >60s） |
| 失敗處理 | LLM 呼叫失敗（5xx / parse error）→ **重試**取得回覆（記錄重試次數）。若 SGLang server 本身掛掉，遊戲無法繼續（所有 AI 呼叫都會失敗）→ 開新局 |

> **【source 現況】** `llm.ts` 只讀 `SGLANG_HOST` / `SGLANG_PORT` / `SGLANG_API_KEY` / `LLM_MODEL`；**沒有**讀 `LLM_TIMEOUT_MS`（AGENTS.md 有列）。`AiController` 自己的重試規則是：最多 **3 次、間隔 2s**（`MAX_LLM_RETRIES` / `RETRY_DELAY_MS`）；仍失敗則該 AI 跳過本次行動（記 `parsed=null`），不阻塞會議／其他玩家。

### 13.3 AI 玩家數量

> **【目標／待實作】** production server 尚未計算 AI 名額或建立 AI 席位；以下是 M7 的目標契約。外部 harness 可直接提供 15 個 AI 定義做全 AI 測試（§13.1）。

- `aiCount = actualPlayerCount - humanPlayerCount`（開局時計算）
- 下限 0（全真人參戰）；上限 `maxPlayers`（純 AI 局，真人全部觀戰）
- AI 玩家在 `ROLE_REVEAL` 前從角色設定檔載入（`character/` 目錄的 persona + memory），非隨機生成

### 13.4 AI 行動生成

> 本節描述 `AiController` 送出的 prompt 與輸出契約。舊的 `ai-player.ts` prompt 仍在 repo 裡（見 §13.7），**不是** runtime 路徑。

| 節點 | Prompt 輸入 | 期望輸出 | 限制 |
|---|---|---|---|
| 白天策略 | 白天策略 prompt（與 §12.3 夜間策略 prompt 同一套：system＝身分＋行事風格；user＝規則／進度／記憶／任務／提點／回覆要求；另掛 `dayContext`，見 §13.5） | 自由體文字，第一行 `status: speak｜wait｜ready`＋理由；只有 speak 接策略主文 | 非 JSON；server 端 validator（§12.3 ②），3 次不合格視為 wait |
| 白天記憶合併 | 該 AI 記憶專區舊文＋新入選策略 | 整合版策略全文（純文字） | 原地取代專區；只有入選 speak 策略會合併 |
| 白天發言 | 白天發言 prompt（入選策略全文＋`## 任務`＋回覆內容要求） | 一句口語發言（純文字） | 3 次重試；失敗 → 以策略主文去掉 status 行發布；OpenCC 強轉繁體 |
| 白天投票（`DAY_VOTE`） | `buildDayVotePrompts`：存活玩家（排除自己）＋`privateInfo`＋當天公頻對話紀錄 | `{"target": "<displayName>"}` 或 `{"target": null}`（棄票） | 不可投自己；名字對不到存活玩家 → 觸發重試 |
| 狼／共有者夜間策略（`WOLF_STRATEGY` / `MASON_STRATEGY`） | §12.3 策略 prompt（system＝身分＋行事風格；user＝規則／進度／記憶／任務／提點／回覆要求） | 自由體文字，第一行 `status: speak｜wait｜ready`＋理由；只有 speak 接策略主文 | 非 JSON；server 端 validator（§12.3 ②），3 次不合格視為 wait |
| 夜間記憶合併（`MEMORY_MERGE`） | 舊夜間策略專區＋新入選策略 | 整合版策略全文（純文字） | 原地取代專區；只有入選 speak 策略會合併 |
| 夜間發言（`WOLF_SPEECH` / `MASON_SPEECH`） | §12.3 發言 prompt（含 `## 你剛剛讀完最新發言後想的策略`） | 一句口語發言（純文字） | 3 次重試；失敗 → 以策略主文去掉 status 行發布；OpenCC 強轉繁體 |
| 狼刀（`WOLF_KILL`） | `buildWolfKillPrompts`：狼隊同夥＋狂人＋可刀目標＋最近訊息 | `{"target": "<displayName>"}` | 不可選自己／狼隊／狂人 |
| 占い（`SEER_CHECK`）／守衛（`GUARD_PROTECT`） | `buildTargetPrompts`：角色＋存活玩家＋`privateInfo` | `{"target": "<displayName>"}` | 不可選自己；守衛 Day1 不行動（引擎擋） |
| judge 選言（`JUDGE`；見 §12.3） | judge prompt：讀策略（編號、不標作者）＋套同一評分標準（見模板 judge 六條） | `{"scores": [n, ...], "best": index}`，**`best` 一律 1-based** | 全盲評分；夜間白天同一標準；LLM 失敗或全 0 分 → 隨機 fallback（不阻塞）；同分時由 LLM 自行決定 |

> 策略／發言／judge／記憶合併四套 prompt 模板逐字全文以 `docs/strategy-prompt-variables.md` 為準。

- **沒有**「每輪最多發言 2 次」「一句話」「≤50 字」這類舊限制：現行 controller 不用字數上限控制發言，改用 **P12 排版規範**（>50 字換行、≤3 段，見 §13.5）。`ai-player.ts` 的舊 prompt 裡仍留有 `≤50字` / `≤150字` 字串，但該檔不是現行 runtime 路徑（§13.7）。
- 每則 WS 訊息 200 字上限仍在（`MAX_MESSAGE_LEN`）：真人 `WOLF_CHAT`／`MASON_CHAT` 與引擎的 `handleWolfChat` / `publishMasonSpeech` 會擋。`sendDayMessage` 目前**不擋**長度（公頻發言長度不受此上限約束）。

### 13.5 Prompt 結構

**System 段**：身分（名字／出身地／陣營角色／夥伴）＋行事風格（取 `character/<id>/agents.md` 的「## 性格與說話方式」整段）＋共用硬規則：
- 全繁體中文；策略為自由體文字、發言為一句口語、judge 只回 JSON，不要多餘文字
- 禁「我先講…」前言、禁「不是…而是…」對立修正、禁「宣告你在回應對方」的開頭（「我接」「你說得對」等同族）
- 說人話：完整通順口語、禁單詞質問、禁鋪陳場面話；動作要具體；禁日文漢字與簡體字混入
- **P12 排版**：`超過 50 字換行分段，≤3 段`（注意：這是**換行規則**、不是字數上限）
- 場上證據邊界：純口頭推理，唯一可用資訊是發言／表態／投票，禁假設玩家持某立場

**Context 段**（附加在 system 之後的 Two-Level Split：Level 1 策略核心／戰術字典／硬規則，Level 2 角色只影響決策）：

| 會議 | context | 掛在哪裡 |
|---|---|---|
| 狼會議 | `wolfContext`（刀人優先序、假跳／對跳結構、投票鎖定、戰術字典） | 狼策略、狼發言 |
| 共有者會議 | `masonContext`（與 `wolfContext` 同構，只換身分差異：CO 決策／反假跳／第一天／互信分工／雙 CO 期） | 共有者策略、共有者發言 |
| 白天討論 | `dayContext`（全角色共用：只用公開發言為證據、禁質疑未發言者、禁只談討論方法） | 白天策略、白天發言 |
| 夜間目標選擇（狼刀／占い／守衛）、白天投票 | 不掛 context（只帶角色＋存活玩家＋情報） | — |

**Memory**：`profile.memory`（跨階段不重置、**4000 字上限**超出砍最舊；`character/<id>/memory.md` 初始化）。夜間／白天策略入選 → 記憶合併（該角色記憶專區舊文＋新策略 → 整合版原地取代專區，見 §12.3 ④）；落選策略、`wait`／`ready` 不寫入。

**輸出契約**：

```
夜間／白天策略：自由體文字，第一行 status: speak|wait|ready＋理由（只有 speak 接策略主文）
judge：   {"scores": [n, ...], "best": index}（best 一律 1-based）
發言：    一句口語（純文字）
目標選擇：{"target": "<displayName>"}（白天投票可用 null＝棄票）
```

- `privateInfo` 由引擎私訊攔截累積（`handlePrivate`）：`ROLE_REVEALED`（角色／顯示名／夥伴／狂人）、`SEER_RESULT`、`GUARD_RESULT`、`MEDIUM_RESULT`（逐夜追加成字串）
- LLM 只回 JSON → `parseJsonResponse`（直接 parse；失敗則抓回覆中第一段 `{…}` 再試；仍失敗回 null → 觸發重試）

### 13.6 AI 排程

> **總覽【source 現況】**：ubuntu 版的 AI 行為由 `AiController` 的**自有 loops** 驅動（狼會議／共有者會議／白天討論／直接行動呼叫），**不是** main 分支的 SpeechScheduler 定時管線。下方「白天討論發言（SpeechScheduler 管線）」只保留作 main 分支參考。
>
> **【production 未接線】** `server.ts` 目前**沒有** import／建立 `AiController`；`START_GAME` 只 `new GameEngine(...)`。因此線上多房 server 不會有 AI 行動、AI 不會補位；AI 路徑目前只由外部 harness 驅動（§13.6a、§13.7）。

#### 白天討論發言（SpeechScheduler 管線）— main 分支參考，非 ubuntu runtime

```
IDLE →（60s 無訊息 或 全真人跳過）→ PRE_SPEECH → JUDGE → SELECT → EXPAND → BROADCAST → IDLE
```

| 階段 | 說明 | 參數 |
|---|---|---|
| IDLE | 每 1s 檢查；等待 CD 無新訊息 | `cdMs=60000`（有真人）/ `0`（無真人，立即觸發）, `checkIntervalMs=1000` |
| PRE_SPEECH | 所有存活 AI 分批（每批 2 個）依序平行生成草稿；**等全部 batch 完成才進 JUDGE** | `preSpeechBatch=2`, `temp=1.0` |
| JUDGE | 全部草稿到齊後，單次 LLM 呼叫全盲評分所有草稿（不告知哪個 AI 寫哪段） | `temp=0.7`（不限 token） |
| SELECT | 新穎性懲罰（與最近 3 則訊息比較）+ top3 中隨機選一 | `topK=3`, `recentCompareCount=3` |
| EXPAND | 將選中的草稿展開為完整發言（commit 點，之後不中斷） | `temp=1.0` |
| BROADCAST | 見下方邏輯 | — |

**BROADCAST 邏輯**（60s 靜默到期時）：
1. 若 AI 發言已選出（管線完成）→ 立即 broadcast
2. 若尚未選出 → 等待管線完成；但等待期間若有任何新訊息進入 → 視同 CD 中斷（重置 60s 計時、作廢當前管線、回 IDLE）

- **版本無效化**：管線執行中若 board 版本變更（有人發言/phase 切換）→ 作廢回 IDLE
- **全真人跳過**：CD 歸零（立即觸發管線 + broadcast）
- **⚠️ ubuntu 版沒有這條 pipeline 的 runtime**：沒有 120s 定時器、沒有 CD 計時器、也沒有 60s 靜默觸發。ubuntu 的白天 loop 是 §13.6a 的排除式 loop。

#### 狼會議／共有者會議（統一夜間會議 loop，見 §12.3）

AI 狼與 AI 共有者都依 §12.3「統一夜間會議 loop」驅動（非 SpeechScheduler 管線）：

| 步驟 | 動作 |
|---|---|
| **出策略** | 本輪參與者＝存活成員中排除上一句發言人（首輪全員），**平行**（`Promise.all`）各出一份 status-first 策略；互不可見；每人重出策略即重評，先前 `ready` 者讀到新發言可改 `speak`／`wait`（＝撤回） |
| **validator** | 檢查第一行 status 與正文是否一致；不合格重生，最多 3 次，仍不合格視為 wait |
| **選稿** | 1 人 speak 直接入選；≥2 人 speak 由 judge 全盲選（`best` 1-based）；0 人 speak → 收斂判斷 |
| **記憶合併** | 入選者夜間策略專區＋新策略 → 整合版取代專區 |
| **發言** | 入選策略 → 一句口語，發布到對話紀錄（狼：`WOLF_MESSAGE`；共有者：`publishMasonSpeech`）；發言者視為 ready |
| **收斂** | 無人 speak 且全員 ready → 狼：逐狼 `handleToggleWolfReady` → 引擎切 `VOTING` → `runWolfVoting`；共有者：雙方 `handleToggleMasonEndTurn` |

- **wait 處理**：無人 speak 但有人 wait → 對 wait 者附「本輪不可 wait」重出一次；仍無人 speak → 收斂
- **安全上限**：見 §12.3 統一條（對話紀錄 100 句）；觸發後狼：引擎 broadcast `WOLF_MEETING_ABORTED` 並停止受理；共有者：controller `messageCap` 停止並把未 ready 者 toggle ON
- **LLM 失敗**：最多 3 次、間隔 2s（§13.2）；策略最終失敗 → 視為 wait；全員失敗 → 共有者全員 toggle ON 不卡夜，狼由安全上限兜底
- **併發**：`x-override-priority: 100+i` 錯開請求（SGLang `--max-running-requests 2` 自動排隊）

#### 夜間行動 / 投票（直接呼叫）【source 現況／外部 harness】

- 占い／守衛／白天投票不需 loop，各 AI 玩家一次 LLM 呼叫 → 直接提交引擎（`handleNightAction` / `handleVote`）
- 狼刀走上方「狼會議」的 `VOTING` 階段（`runWolfVoting`，全併發），不在此處
- 若 LLM 呼叫失敗 → 重試 3 次後跳過該 AI 本次行動（不阻塞其他玩家）

#### 清理【source 現況】

- 房間回收時 `game.destroy()` 清所有 phase timer；harness 結束時 `ai.destroy()` → 取消進行中的重試排程（進行中的 fetch 無法中斷，結果會被丟棄）
- **【production 未接線】** `server.ts` 尚未建立 `AiController`，因此正式 server 目前沒有這套排程／清理路徑

#### 13.6a 白天討論

> 白天討論 AI 走與夜間同一套 loop（見 §12.3、§12.4）。

**進入時的狀態重建（v2 envelope）**：外部 harness 使用單一 `{ schemaVersion: 2, savedAt, stopAt, game, ai, events, aiLog }` envelope。resume 順序固定為：`ai.setPhaseStartEnabled(false)` barrier → `game.restoreState(env.game)` → `ai.restoreLog(env.aiLog)` → `ai.importDayCheckpoint(env.ai)` → `ai.resumeDayDiscussion()`。`AiController` checkpoint 保存 strategy／judge／memory-merge／publish continuation、memory／knowledge／boards；已完成的階段不重做，未完成項按 pending 補做。all-ready 時由 continuation 呼叫 `game.reconcileDayReady()` 推進 `DAY_VOTING`。只支援 `DAY_DISCUSSION` restore；舊三檔格式與 `NIGHT_RESULT` phase 明確拒絕。

**流程：**

```
DAY_DISCUSSION 開始（引擎 broadcast PHASE_CHANGED）
  每輪：
    ① 出策略：本輪參與者＝存活 AI 中排除上一句發言人（首輪全員），各出一份 status-first 策略（Promise.all，互不可見）；每人重出策略即重評，先前 ready 者讀到新發言可改 speak／wait（＝撤回）
    ② validator（server 端）：同 §12.3 ②（第一行 status＋正文檢查；不合格重生最多 3 次，仍不合格視為 wait）
    ③ 選稿：0 人 speak → 跳到 ⑥；1 人 speak 直接入選；≥ 2 人 speak → judge 盲選一篇（只讀策略、不標作者；失敗 → 隨機 fallback）
    ④ 記憶合併：入選者記憶專區舊文＋新策略 → LLM 整合版寫回（只合併入選 speak 策略）
    ⑤ 發言：選中策略轉成一句口語發言（3 次重試；全失敗 → 以策略主文去掉 status 行發布）；經既有 MESSAGE 廣播到公頻（game.sendDayMessage；對話紀錄不限上限、完整保留【目標／待實作：source 現況只保留最近 50 則】）；公頻沒有新增 WS 事件；發言者視為 ready，發布後回到 ①
    ⑥ 收斂判斷（本輪無人 speak 時）：全員 ready → break（此時引擎已進 DAY_VOTING）；有人 wait → 對 wait 者附「本輪不可 wait」重發一次，再走一次 ①–⑤；仍無人 speak → 收斂
  結束：確保所有 AI 都 toggle ready ON
```

**各步驟細節：**

| 步驟 | 契約 |
|---|---|
| 出策略 | 本輪參與者＝存活 AI 中排除上一句發言人（首輪全員），**一輪 `Promise.all` 全併發**各出一份 status-first 策略；互不可見；每人重出策略即重評，先前 `ready` 者讀到新發言可改 `speak`／`wait`（＝撤回） |
| validator | 同 §12.3 ②（第一行 status＋正文檢查；不合格重生最多 3 次，仍不合格視為 wait） |
| judge | 0 人 speak → 收斂判斷；1 人 speak 直接入選；≥ 2 人 speak 以編號呈現、不標作者，盲選一篇；失敗 → 隨機 fallback（不阻塞） |
| 記憶合併 | 入選者記憶專區舊文＋新策略 → 整合版寫回（只合併入選 speak 策略） |
| 發言 | 入選策略轉成一句口語發言；3 次重試，全失敗 → 以策略主文去掉 status 行發布；經既有 `MESSAGE` 廣播到公頻（`game.sendDayMessage`；對話紀錄不限上限、完整保留【目標／待實作：source 現況只保留最近 50 則】）；**公頻沒有新增 WS 事件**；發言者視為 ready |
| 收斂 | 全 AI ready ON → `reconcileDayReady()` 觸發 `DAY_VOTING`；有人 wait → 對 wait 者附「本輪不可 wait」重發一次，再走一次出策略–發言；仍無人 speak → 收斂；對應 `DAY_READY_STATUS` 事件 |
| 安全上限 | 與夜間同一條：對話紀錄累計 100 句仍未收斂 → 停止並報告（見 §12.3） |

**`dayContext`（全角色共用）**：白天策略、發言 prompt 都掛 `dayContext`（唯一可用證據是公開發言、禁質疑未發言者、禁假設他人立場、禁只談討論方法）。白天策略 prompt 模板（system／user 段落、status-first 格式、validator）與夜間同一套，見 §12.3，差異只有議題與對話紀錄來源。

**策略定位**：白天的「策略」同樣是**行動筆記**（判斷誰／依據是對方實際講過什麼／要表態什麼），不是發言稿，不寫逐字台詞；一句口語由發言 prompt 依角色語氣生成。Memory（4000 字上限、跨階段不重置）與 P12 排版規則見 §13.5。

**外部 harness 執行方式（`scripts/external-test-stage2.mjs`）：**

- 15 人全 AI 局：`new AiController(defs, { messageCap: 100 })` + `new GameEngine('STAGE2', ...)`，兩個方向的 callback 互接
- 階段 timeout：**NIGHT / DAY 都是 `0`（不限時）**；每 10 分鐘印一次進度；狼會議 abort 時停止
- `--stop-at NIGHT_RESULT | DAY_RESULT | GAME_OVER`（預設 `DAY_RESULT`）
- `--save-state <path>`：原子寫入單一 v2 envelope（`schemaVersion=2`，含 `game`／`ai`／`events`／`aiLog`）
- `--resume <path>`：載入 v2 envelope，依 barrier → game restore → AI import → `resumeDayDiscussion()` 順序續跑；只支援 `DAY_DISCUSSION`
- `--stop-after-first-message`：無值 flag，只在 resume 時計算 baseline+1 的公頻 `MESSAGE`；publish commit 後結束，不進下一輪策略
- 報告（md）：會議流程、對話紀錄、夜間結算、投票軌跡、收斂、LLM 失敗／重試、事件時間軸；本機固定取回名稱為 `ai-trace-stage2-night.md`／`ai-trace-stage2-day.md`
- **沒有** 5 分鐘 timeout；操作者仍可用外部 `timeout --signal=INT --kill-after=30s` 做分段觀察

**未決事項**：

- **公頻策略洩漏**：目前**沒有**「白天不得公開夜間私密資訊」的硬規則；待首則公頻發言的盲評結果再裁示。

### 13.7 模組

| 檔案 | 說明 | 現行地位 |
|---|---|---|
| `src/lobby-server/llm.ts` | LLM client：`chat(messages, { temperature, reasoningEffort, priority })` → `fetch(localhost:9090/v1/chat/completions)`（Bearer auth、`x-override-priority`、逐次 `reasoning_effort`）；失敗回 `null`；不設 timeout | 【source 現況】實際被呼叫的一層，`AiController` 的所有 LLM 呼叫都走這裡 |
| `src/lobby-server/ai-controller.ts` | **實際的 AI loop**：`AiController`（狼會議／共有者會議／白天討論：策略→validator→judge→記憶合併→發言；目標選擇、LLM log、memory 4000 字），import `llm.ts` ＋ `ai-player.ts` 的 persona/memory loader | 由 `scripts/external-test-stage2.mjs` 建立；**`server.ts` 尚未 import**（production 未接線） |
| `src/lobby-server/ai-player.ts` | `loadCharacterProfile()`（讀 `character/<id>/agents.md` ＋ `memory.md`）、`parseJsonResponse()`，以及**舊的** SpeechScheduler pipeline（`buildPreSpeechPrompt` / `buildExpandPrompt` / `runWolfMeetingPipeline`） | 部分現行（persona/memory loader 與 parser 被 controller 引用）；**pipeline 部分是舊路徑、未接 runtime**（其中的 `≤50字` / `≤150字` 等字串不再是現行規格，見 §13.4） |

### 13.8 GameEngine 整合點

**已實作（source）**：
- `start()`：分配角色 → 私發 `ROLE_REVEALED`（含夥伴／狂人）→ 進 `ROLE_REVEAL`（10s）→ `NIGHT`
- 引擎回呼點（外部 harness 已接，production 未接）：`onNightStepActive(step, players)`、`onWolfSubphaseChange(subphase, round)`；觀察用 `getNightState()` / `getDayState()` / `saveState()` / `restoreState()`
- AI 行動走同一條引擎路徑（`handleNightAction()` / `handleVote()` / `handleWolfChat()` / `publishMasonSpeech()` / `sendDayMessage()`），engine 不區分真人/AI
- `destroy()`：clear 所有 phase timer

**【production 未接線】（AI 相關待接）**：
- 開局計算 AI 名額、為 AI 玩家從 `character/` 載入 persona＋建立 AI 席位 → 未接
- `transitionTo('DAY_DISCUSSION')` 觸發 AI 白天 loop → 未接（`server.ts` 沒有 controller）
- `transitionTo('DAY_VOTING')` 觸發 AI 投票 → 未接
- `NIGHT` 各步驟觸發 AI 夜間行動 → 未接（controller 靠引擎 callback，server 沒建立）
- **AI 玩家的知識來源**：harness 把 `sendTo` 接到 `AiController.handlePrivate()` 建知識；正式 server 的 `sendTo` 只找 WS client，AI 席位沒有 socket → 這條路徑要一併設計（**待實作**，本文不預設解法）
- `destroy()`：clear 所有 AI 排程 timer + abort 進行中的 LLM 呼叫

### 13.9 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `2640` | lobby-server 監聽埠（`entry.ts`；`wolfgame.service` 已設定） |
| `SGLANG_PORT` | `9090` | SGLang server 埠（`llm.ts` 會讀） |
| `SGLANG_HOST` | `127.0.0.1` | SGLang host（同機）（`llm.ts` 會讀） |
| `SGLANG_API_KEY` | —（部署時注入） | Bearer token（`llm.ts` 會讀；**production `wolfgame.service` 目前未注入**，見 §13.10） |
| `LLM_MODEL` | `qwen3.8-27b` | model name（`--served-model-name`）（`llm.ts` 會讀） |
| `LLM_REASONING_EFFORT` | 未設（不送） | Qwen3.8-27B per-request reasoning variant；值為 `xhigh`／`medium`／`low` 時，映射到 OpenAI request body 頂層 `reasoning_effort`；只影響目前 process |
| `LLM_TIMEOUT_MS` | `60000` | **【注意】`AGENTS.md` 有列，但 `llm.ts` 未讀取**；實際 LLM 呼叫不設 timeout（等回傳） |
| `AI_ENABLED` | `true` | **【production 未接線】程式碼完全未讀取這個變數**；目前沒有任何機制可用 `false` 關掉 AI 補位 |

### 13.10 systemd 部署

**現況（如實記錄，未修）**：`deploy/wolfgame.service` 目前只有：

```ini
[Unit]
Description=Werewolf Lobby Server (multi-room WebSocket)
After=network.target

[Service]
Type=simple
User=morowin
WorkingDirectory=/opt/wolfgame
ExecStart=/usr/bin/node /opt/wolfgame/dist/lobby-server/entry.js
Environment=PORT=2640
Restart=on-failure
RestartSec=3
```

也就是說（**不可宣稱已修**）：
- **缺 SGLang 依賴**：沒有 `After=sglang-server.service`、也沒有 `Wants=sglang-server.service` → systemd 不保證 LLM 先啟動
- **缺 API key 注入**：沒有 `EnvironmentFile=`、也沒有 `Environment=SGLANG_API_KEY=…` → `llm.ts` 會帶空 Bearer
- 連帶地，M7 在 production 端無法運作（`server.ts` 本身也還沒建立 `AiController`，見 §13.7）

**目標態【待實作】**（要接 M7 時才做）：

```ini
# /etc/systemd/system/wolfgame.service（目標：相關欄位）
[Unit]
After=network-online.target sglang-server.service
Wants=sglang-server.service

[Service]
EnvironmentFile=/etc/wolfgame/ai.env   # SGLANG_API_KEY / SGLANG_HOST / SGLANG_PORT / LLM_MODEL
```

- SGLang 已有獨立 systemd service（`sglang-server.service`）；wolfgame 需在 `After=` 依賴它（確保 LLM 先啟動）
- 模型檔案：`/home/morowin/models/Qwen3.8-27B-AWQ`（~18.7GB，git 外管理）
- **外部測試 runner ≠ production 設定**：server 上應使用 `sudo sh scripts/run-external-test-safe.sh --stop-at ...`／`--resume ...`；runner 從 root 600 的 `/etc/sglang/api-key.env` 載入金鑰，金鑰不經 process argv。這只供外部測試，**不代表** `wolfgame.service` 已取得 API key、SGLang 依賴或 AI controller 接線
