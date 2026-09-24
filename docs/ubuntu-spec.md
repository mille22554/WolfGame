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
- 觀戰：可看白板、可發言（聊天）；不能操作（開始遊戲、踢人等）
- 房主離開：無手動轉讓；依入房時間（最早者）自動轉讓給下一位玩家
- 房間關閉：清空（無人）立即回收；無活動超時（預設 30 分鐘）自動清理

### 2.3 加入已開始的房間 → 觀戰模式
- 可看到白板、發言、投票結果
- 不能投票、不能提交夜間行動【已實作】（引擎只受理存活參戰玩家的 `handleVote` / `handleNightAction`）
- 標示「觀戰中」
- **【目標／待實作】** 「觀戰者不能發言」目前未在 server 端強制：`SEND_MESSAGE` 不分參戰／觀戰（§2.2 的「觀戰可聊天」與 §12.4 的禁言規則都尚未收斂成單一規則）

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
- 每房獨立狀態（玩家列表、白板、遊戲 phase）
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
| S→C | `MESSAGE` | `{ from, text, ts }` | broadcast 發言。**AI 白天 EXPAND 後的完整發言也走這個事件**（`sendDayMessage`），不另開新事件 |
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
| M7 | AI 補位：LLM client + AI 控制器（狼／共有者／白天 loop，含 judge 盲選＋EXPAND） | 1 真人 + 5 AI 可跑完整局；AI 發言自然、投票有邏輯、夜間行動合法；LLM 失敗以重試處理，server 掛 → 開新局。**現況：source／外部 harness 已可跑 15 人全 AI 局（§13.6a）；production server 尚未接線、oracle／server 行為驗證未完成** | ⬜ |

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
git commit -m "..." && git push

# Server：
ssh -F ~/.ssh/config ssh.morowin.win \
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
| `DAY_DISCUSSION` | 全存活玩家自由發言（复用 lobby chat） | 所有存活玩家 toggle「準備投票」ON（不限時，同狼會議模式）；或房主送 `END_DISCUSSION` 提前結束（已實作） |
| `DAY_VOTING` | 全存活玩家投票（含棄票） | 所有存活玩家皆已投票 |
| `DAY_RESULT` | 公布投票結果（死者身分不公開）；霊能者得知票死者身分 | 10 秒（固定） |
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

> **【規格＋source 現況／外部 harness；production 未接線】** 本節描述遊戲規則與 `AiController` 已實作的狼／共有者 loop；目前正式多房 server 尚未建立 `AiController`，線上不會自行驅動 AI 私頻會議（§13.7）。

各角色可提交的行動：

| 角色 | 行動 | 限制 |
|---|---|---|
| 守衛 | `GUARD_PROTECT { targetId }` | Day1 不可；不可自護（自護→隨機護他人）；可連續護同一人 |
| 共有者 | `MASON_END_TURN`（toggle） | 雙人都 ON 才解鎖狼的環節；可隨時 toggle 開/關 |
| 人狼 | 狼會議 → `WOLF_KILL { targetId }` | 全部狼 toggle「準備投票」ON → 投目標；平票（1:1, 1:1:1）→ 回討論重來；不可選自己/狂人 |
| 占い師 | `SEER_CHECK { targetId }` | 不可選自己；每夜一次 |
| 霊能者 | 無（被動） | 黎明自動收到昨日票死者身分 |
| 村民/狂人 | 無 | — |

**結算順序**（server-side，依序解鎖）：
1. 守衛護 → 記錄 `guardedTargetId`
2. 共有者回合結束 → 雙人都 toggle ON 才解鎖下一步（toggle：按開＝我好了，再按＝關掉重來）
3. 人狼刀 → 狼會議流程（見下方）；若目標 == guardedTargetId → 平安夜（kill blocked）；否則目標死亡
4. 占い師查 → 結果僅發給占い師
5. 黎明：霊能者收到「昨天被票死者」身分（Day1 無）

**狼會議流程**（step 3 的內部流程，連續對話制）：

狼會議是一場**持續的對話 loop**。平票時 round+1 重新討論（非平票不增）。議題包含兩項：**刀人目標**（刀誰）＋**明天白天的行動方針**（誰裝白、誰攻擊、誰安靜）。兩項議題在同一場對話中自然帶出，不分開成兩個階段。每隻狼的草稿包含 `speech`（行動筆記）＋ `stance`（「投XXX」或「資訊不足」）；草稿只承載決策要點，發布前由 EXPAND 轉成角色語氣的完整發言。

**草稿格式：**
```json
{ "speech": "我建議先刀真一，他發言有破綻", "stance": "投真一" }
```
或
```json
{ "speech": "我目前還看不出誰有問題，再聽聽其他人怎麼說", "stance": "資訊不足" }
```

**流程（loop，直到收斂）：**

**初始：** 所有存活狼各自獨立出草稿（互不可見，不知道隊友出了什麼）。

**② Judge 盲選 → 發布：**
- 從所有待選草稿中盲選一篇（不知道誰寫的）
- 將選中的草稿**展開**（EXPAND，見下方 ②'）
- 將展開後的完整發言發布到狼白板（WOLF_MESSAGE）
- 該狼的 `stance` 記錄下來

**②' 展開（EXPAND）：**
- 將選中的草稿（行動筆記）用該狼的角色語氣重述成完整發言
- LLM 失敗重試 3 次後，以草稿原文發布（不阻塞會議）
- 展開不得新增草稿外的行動、對象或結論

**③ 除發言者外所有狼讀白板 → 各自回應：**
- 看到剛發布的那句話（白板是累積的，也能看到之前的發言）
- 每隻狼用自己的角色判斷，三種可能：
  - 「我準備投票了」→ stance =「投XXX」（XXX 是他自己選的目標，不一定要跟發言者相同）
  - 「我要講」→ 出新草稿（speech + stance）
  - 「資訊不足」+ 不想講 → 不出草稿，維持等待（下次有新發言再評估）
- **已 ready 的狼可以改變想法**：之前 stance 是「投XXX」的狼，看到新發言後可以撤回（改出草稿 / 改 stance）。每輪所有非發言者狼都重新評估，不跳過任何人。

**④ Judge 收到全員回應後判斷：**
- 有狼出了新草稿 → 回 ②（judge 從新草稿中選）——**有人想講就優先讓他們講**
- 沒人出草稿、所有狼 stance 都是「投XXX」→ **收斂** → 進投票
- 沒人出草稿、但有狼「資訊不足」→ 通知那些狼發言（強制出草稿）→ 回 ②

**收斂**：所有狼的 stance 都是「投XXX」（= 都「準備投票」了）且沒有人想再講。不要求所有狼投同一個人——可能狼 A 投真一、狼 B 投美咲，都 ready 就收斂，進投票階段再決（多數決）。

**投票（收斂後）：**
- 各狼依自己的 stance 提交 `WOLF_KILL { targetId }`
- 沒平票 → 最高票者為刀人目標 → 完成 step 3
- 平票 → 所有狼 stance 重置為「資訊不足」→ 回 ② 重新討論

**安全上限（測試用）**：白板累計 100 則 WOLF_MESSAGE 仍未收斂 → 立即停止並報告（不自動收斂、不強制決選）。正式環境無此上限（預期對話會收斂）。

**與白天會議的差異**：
- 狼會議平票 → 回討論（重來）。
- 白天會議平票 → 無人出局（不重來，見 §12.5）。

**結束條件**：
- 所有有夜間行動的玩家（存活狼 + 占い師 + 守衛）皆已提交 → 立即結算
- 未提交的玩家會一直等待（前端顯示「等待中…」）
- 人狼刀：狼會議收斂（全狼 stance =「投XXX」）後，各狼投票決出刀人目標；平票→回討論重來
- 若某角色已全數死亡（如占い師已死）→ 該角色不需提交，不阻塞 phase 結束

**共有者會議流程**（step 2 的內部流程，連續對話制）：

與狼會議**完全相同的 loop 機制**（出稿 → judge 盲選發布 → 其他成員回應 → 收斂），差異仅在：

| | 狼會議 | 共有者會議 |
|---|---|---|
| 參與者 | 所有存活人狼 | 2 個存活共有者 |
| 議題 | 刀人目標 ＋ 明天白天行動方針 | 明天白天的行動方針 |
| 白板 | `WOLF_MESSAGE`（所有狼可見） | `MASON_MESSAGE`（僅共有者雙方可見） |
| 收斂後動作 | 各狼投票（`WOLF_KILL`） | 雙方 toggle ON（解鎖狼的環節） |
| 平票處理 | 回討論重來 | 不適用（只有 2 人，收斂 = 雙方都 ready） |

**草稿格式**（同狼會議）：
```json
{ "speech": "明天我裝白，你負責攻擊太助的邏輯", "stance": "準備好了" }
```

**流程（loop，直到收斂）：**
- **初始**：兩個共有者各自獨立出草稿（互不可見）
- **② Judge 盲選 → 發布**：從草稿中盲選一篇 → **展開**（EXPAND，見下）→ 將展開後的完整發言發布到共有者白板（`MASON_MESSAGE`）
- **②' 展開（EXPAND）**：將選中的草稿（行動筆記）用該角色語氣重述成完整發言；LLM 失敗重試 3 次後，以草稿原文發布（不阻塞會議）。展開不得新增草稿外的行動、對象或結論
- **③ 另一方讀白板 → 回應**：「準備好了」（ready）／「我要講」（出新草稿）／「資訊不足」（不出草稿）
- **④ 收斂判斷**：有出新草稿 → 回 ②；都沒新草稿且雙方都 ready → **收斂** → 雙方 toggle ON
- **安全上限**：白板累計 100 則 `MASON_MESSAGE` 未收斂 → 停止並報告

**議題指引**（prompt 層）：

共有者的 `masonContext`／`buildMasonDraftPrompts`／`buildMasonResponsePrompts` 與狼版（`wolfContext`／`buildDraftPrompts`／`buildResponsePrompts`）**同構同編排**，逐行對應，只有身分差異：

| 狼版 | 共有者 V8 | 差異原因 |
|---|---|---|
| `可刀目標（只能從以下選）` | `白天可鎖定的對象（只能從以下選）` | 共有者不刀人，白天的討論對象就是可鎖定對象（排除自己＋夥伴） |
| 任務①「你刀誰」 | 任務①「你 CO 還是隱匿」 | 共有者無夜間動作；夜晚的唯一決策是身分是否公開 |
| 模式選單：潛伏／引導投票／製造假資訊／假跳對跳 | 模式選單：CO／隱匿／拋話題／分工觀察 | 共有者的白天行動選項 |
| 【對跳結構】 | 【CO 決策】／【反假跳】／【第一天】／【互信分工】／【雙 CO 期表態】 | 共有者的硬規則區塊 |
| stance＝今晚刀人目標 | stance＝明天安排的準備狀態（準備好了／資訊不足） | 引擎既有語意（`masonReadyMap`），不可動 |

**草稿定位（V8 核心設計）**：草稿不是發言稿，是**給夥伴看的行動筆記**。
- 只寫四類資訊：做什麼（誰做什麼、CO 與否）／關鍵理由一句／分工／預期走向一句
- 推演與理由要保留，但不詳細
- **不得寫明天要說的逐字台詞**（那是展開階段才決定的）
- 角色（persona）**只參與決策**（風險承受、怎麼評估 CO、誰拋話題），**不決定措辭**；措辭留給後續展開步驟
- 覆寫共享 `buildSystemPrompt` 的「完整通順口語」傾向：不寫成完整敘述，用短句列重點
- 草稿的措辭不進入白板：發布前由引擎的 EXPAND 步驟展開（§13.6），草稿只承載行動與決策資訊
- 展開失敗時以草稿原文發布（連續 3 次重試後），保證會議不中斷

`buildMasonResponsePrompts` 的 `speak` 分支同樣遵守上述定位，並額外禁止：評價式開頭（「你的判斷是對的」）、覆述夥伴剛講的內容、逐字台詞。

**仍不變的硬規則**：
- 明天白天會議我們的行動方針（誰主動發言、誰觀察、誰攻擊誰）
- 我們對局勢的判斷（誰可疑、誰可能是狼）
- 如果被人質疑，我們怎麼回應
- 不要暴露「我們是共有者」這件事給其他人聽（私頻只有雙方看到）
- 第 1 天沒有發言可引用 → 禁止對未發言玩家下判斷，只能拋話題／觀察
- 質疑必須引用實際發言（第 2 天起）

### 12.4 白天討論（DAY_DISCUSSION）

- 复用 lobby 的 `SEND_MESSAGE` / `MESSAGE`（公頻）【已上線】
- **無私頻**：WOLF_CHAT / MASON_CHAT 僅 NIGHT 可用，白天只有公頻
- 結束方式：所有存活玩家 toggle「準備投票」ON → 進入投票（同狼會議模式，可隨時 toggle 開/關）【已上線】；房主另可送 `END_DISCUSSION` 提前結束（已實作）
- **AI 驅動（V-Day；source 現況／外部 harness）**：AI 玩家走「策略先行 + 逐輪發言 + 全員回應」loop，完整流程見 §13.6a。核心順序：
  1. 所有**未 ready** 的 AI 各出「行動筆記」草稿（`Promise.all`，互不可見）
  2. judge 盲選一篇（只讀草稿、不標作者）
  3. 選中草稿走 **EXPAND** 展開成角色語氣的完整發言（3 次重試；全失敗 → 以草稿原文 fallback，不阻塞）
  4. expanded 經**既有** `MESSAGE` 事件廣播到公頻（引擎 `sendDayMessage`）→ **公頻沒有新增 WS 事件**
  5. 發言者 toggle ready；其他 AI 讀**同一段 expanded** 回應（`Promise.all`：ready／speak 出新草稿／wait）
  6. 全 AI ready → 收斂，進 `DAY_VOTING`；若無人出新稿但還有未 ready → 強制那些 AI 出稿
- **【production 未接線】** 正式 server 開局只建立 `GameEngine`，不建立 `AiController` → 線上真人局目前沒有 AI 發言（§13.7）
- **【目標／待實作】已死亡玩家不能發言**：`SEND_MESSAGE` 目前只檢查「在房內」＋200 字上限（`room-manager.sendMessage`），**不檢查 alive／phase** → 死者（與觀戰者）目前仍能在公頻打字。前端灰化屬 M6。
- **【目標／待實作】** 公頻可見範圍的 server 端區分（觀戰者 vs 參戰 vs 死者）尚未實作；目前一律 broadcast 全房。

### 12.5 投票（DAY_VOTING）

- 全存活玩家各投 1 票：`CAST_VOTE { targetId }` 或 `CAST_VOTE { targetId: null }`（棄票）
- 不可投自己
- 等待所有存活玩家皆已投票（含棄票）→ 立即結算
- 結算：票最高者出局；**最高票不唯一（平票）→ 無人出局**：`tie=true`、`eliminatedClientId=null`（已實作，不隨機、不淘汰）
- 棄票（`null`）不計入計票
- 被票死者身分不公開（僅霊能者得知）

### 12.6 勝利判定

每輪 DAY_RESULT 後檢查：
- **狼數** = 存活人狼 + 存活狂人
- **村數** = 存活村民 + 占い師 + 守衛 + 霊能者 + 共有者（不含狂人）
- **村勝**：狼數 == 0（所有狼＋狂人都死）
- **狼勝**：狼數 ≥ 村數
- 平局不可能（狼 ≥ 村 時狼已勝）

### 12.7 死亡規則

- 夜殺：身分完全不公開（任何人不知道，含霊能者）
- 票死：身分不公開（僅霊能者得知）
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
| S→C | `WOLF_SPEECH_SELECTED` | `{ round, from, text }` | judge 選出的代表發言（**已實作**；`text` 為 EXPAND 後的完整發言，展開失敗則為草稿原文；僅發給狼，其他狼讀完表態） |
| S→C | `MASON_SPEECH_SELECTED` | `{ round, from, text }` | 共有者 judge 選出的代表發言（**已實作**；`text` 同樣是 EXPAND 後的完整發言或 fallback 草稿原文；僅發給共有者雙方） |
| S→C | `WOLF_MEETING_ABORTED` | `{ count, reason }` | 狼會議安全上限觸發：白板累計 100 則 `WOLF_MESSAGE` 未收斂 → 停止並通知（**已實作**；僅測試用 `wolfMessageCap > 0` 時啟用；觸發後不再受理 `WOLF_CHAT`／`TOGGLE_WOLF_READY`，不自動收斂、不強制決選） |
| S→C | `DAY_READY_STATUS` | `{ ready: [{ id, nickname }], total: number }` | 哪些玩家已準備投票（**已實作**；進入 `DAY_DISCUSSION` 時先 broadcast 一次全 false，每次 `TOGGLE_VOTE_READY` 再 broadcast；對象為全房，含觀戰者） |
| S→C | `ROLE_REVEALED` | `{ role, displayName, description, partners? }` | 私發各玩家自己的角色 |
| S→C | `NIGHT_RESULT` | `{ peacefulNight: bool, deaths: [{ id, nickname }] }` | 夜間結果（broadcast） |
| S→C | `SEER_RESULT` | `{ targetId, nickname, result: 'villager'\|'werewolf' }` | 私發占い師 |
| S→C | `GUARD_RESULT` | `{ targetId, nickname, blocked: bool }` | 私發守衛 |
| S→C | `MEDIUM_RESULT` | `{ targetId, nickname, result: 'villager'\|'werewolf' }` | 私發霊能者（黎明） |
| S→C | `VOTE_RESULT` | `{ votes: Record<number, number>, eliminatedId: number\|null, tie: bool }` | 投票結果（broadcast） |
| S→C | `PLAYER_ELIMINATED` | `{ id, nickname, cause: 'wolf_kill'\|'vote' }` | 有人出局（broadcast） |
| S→C | `GAME_OVER` | `{ winner: 'village'\|'werewolf', players: [{ id, nickname, role, alive }] }` | 終局（broadcast，公布全部角色） |
| S→C | `WOLF_MESSAGE` | `{ from, text, ts }` | 人狼私頻（僅存活人狼）。`text` 為 EXPAND 展開後的完整發言；展開失敗時為草稿原文 |
| S→C | `MASON_MESSAGE` | `{ from, text, ts }` | 共有者私頻（僅雙方）。`text` 為 EXPAND 展開後的完整發言；展開失敗時為草稿原文 |

> **AI 白天發言不新增事件**：AI 白天 EXPAND 後的發言直接走既有 `MESSAGE`（公頻），與真人 `SEND_MESSAGE` → `MESSAGE` 同一路徑（§12.4、§13.6a）。
>
> **【source 現況】** 上表「已實作」＝`src/lobby-server` 真的會送這個事件；「待實作」＝規格已定但程式碼沒有對應事件。`MASON_READY` / `WOLF_READY` / `DAY_READY_STATUS` / `WOLF_VOTE_SPLIT` / `WOLF_SPEECH_SELECTED` / `MASON_SPEECH_SELECTED` / `WOLF_MEETING_ABORTED` 目前主要由引擎回呼觸發、並被外部 harness 觀察；**正式 server 尚未接 AI 控制器**（§13.7），所以線上不會有 AI 觸發的那些事件。

### 12.9 前端 UI 需求（M6）

| 元件 | 說明 |
|---|---|
| Phase 指示器 | 頂欄顯示當前 phase（夜/昼）+ 天數 + 等待狀態（「等待 N 人行動…」） |
| 角色揭示畫面 | ROLE_REVEAL phase 全螢幕顯示自己的角色（10 秒後自動消失） |
| 夜間操作面板 | 依角色顯示不同 UI：人狼→選目標（排除自己/狂人）；占い師→選目標；守衛→選目標（Day1 灰化） |
| 人狼私頻 | 僅人狼可見的聊天區（可折疊） |
| 投票面板 | DAY_VOTING 時顯示所有存活玩家按鈕 + 棄票按鈕 |
| 死亡公告 | NIGHT_RESULT / DAY_RESULT 時全螢幕 toast（3 秒） |
| 玩家狀態更新 | 死亡玩家灰化 + ☠ 標記；不能發言/投票 |
| 結算畫面 | GAME_OVER 全螢幕：勝負結果 + 全部角色揭露 |
| 霊能者/占い師/守衛私訊 | 各自的結果以 toast 顯示（僅自己可見） |

### 12.10 與 main 分支共用

- `ROLE_CONFIG`、`Role`、`Team`、`ROLE_TEAM`、`seerSeesAs()` 等常數/函式 → 直接 import 或 copy
- `assignRoles()`、`checkWinCondition()` 邏輯 → 可复用（需確認 import path）
- `night.ts` 的結算邏輯 → 可复用（需改為 async 等待模式）
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
- **真人 = raw chat【已上線】**：玩家送 `WOLF_CHAT` / `MASON_CHAT` → server 原樣收進該白板並 broadcast（`handleWolfChat` / `handleMasonChat`），**不經過 judge、不經過 EXPAND**，也沒有結構化收斂。
- **AI = 結構化 loop【source 現況】**：AI 狼／共有者由 `AiController` 驅動（出稿 → judge 盲選 → EXPAND → 其他成員回應 → 收斂），見 §12.3、§13.6。**目前只有外部 harness 會建立 `AiController`；正式 server 未接線**，所以線上房間裡 AI 不會發言。
- 兩者共用同一組白板事件（`WOLF_MESSAGE` / `MASON_MESSAGE`），payload 格式相同。

**規則：**
- 已死亡玩家不能發送任何私頻訊息（含狼、共有者）【已實作】（server 端檢查 phase／nightStep／role／alive）
- 人狼死亡 → 剩餘存活狼仍可用狼會議【已實作】（broadcast 目標＝存活狼名單）
- 私頻訊息**不記錄在公頻**，其他玩家完全看不到【已實作】
- 觀戰者看不到任何私頻【已實作】（私頻 broadcast 只指定狼／共有者的 clientId 清單）
- 訊息格式與公頻相同：`{ from, text, ts }`【已實作】
- 每則訊息上限 200 字（與公頻相同）【已實作】（`MAX_MESSAGE_LEN`；引擎 `handleWolfChat` / `publishMasonSpeech` 也會擋）
- 共有者一方死亡 → 該頻道停用（剩下一方無法對話）【部分實作】：server 端**沒有**停用判定——殘存方仍可自己發 `MASON_CHAT`，broadcast 對象只有自己（已死亡的夥伴若仍在線仍會收到）。AI 端另有限制：存活共有者 < 2 人時 `runMasonDiscussion` 直接 toggle ON、不開會。

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
| 呼叫 timeout | 無（`llm.ts` 呼叫不設 timeout，等待回傳；reasoning model 長 prompt 可能 >60s） |
| 失敗處理 | LLM 呼叫失敗（5xx / parse error）→ **重試**取得回覆（記錄重試次數）。若 SGLang server 本身掛掉，遊戲無法繼續（所有 AI 呼叫都會失敗）→ 開新局 |

> **【source 現況】** `llm.ts` 只讀 `SGLANG_HOST` / `SGLANG_PORT` / `SGLANG_API_KEY` / `LLM_MODEL`；**沒有**讀 `LLM_TIMEOUT_MS`（AGENTS.md 有列）。`AiController` 自己的重試規則是：最多 **3 次、間隔 2s**（`MAX_LLM_RETRIES` / `RETRY_DELAY_MS`）；仍失敗則該 AI 跳過本次行動（記 `parsed=null`），不阻塞會議／其他玩家。

### 13.3 AI 玩家數量

> **【目標／待實作】** production server 尚未計算 AI 名額或建立 AI 席位；以下是 M7 的目標契約。外部 harness 可直接提供 15 個 AI 定義做全 AI 測試（§13.1）。

- `aiCount = actualPlayerCount - humanPlayerCount`（開局時計算）
- 下限 0（全真人參戰）；上限 `maxPlayers`（純 AI 局，真人全部觀戰）
- AI 玩家在 `ROLE_REVEAL` 前從角色設定檔載入（`character/` 目錄的 persona + memory），非隨機生成

### 13.4 AI 行動生成（現行 `ai-controller.ts`）

> 本節描述 `src/lobby-server/ai-controller.ts`（`AiController`）實際送出的 prompt 與 JSON 契約。舊的 `ai-player.ts` prompt 仍在 repo 裡（見 §13.7），**不是**現行 runtime 路徑。

| 節點 | Prompt 輸入 | 期望輸出（JSON） | 限制 |
|---|---|---|---|
| 白天策略（`DAY_STRATEGY`） | `buildStrategyPrompt`：角色分支（占卜師／共有者／狼／其他）＋存活玩家＋`privateInfo`＋昨晚私頻白板 | `{"strategy": "..."}` | **不掛 `dayContext`**；成功才寫入 memory |
| 白天草稿（`DAY_SPEECH`） | `buildDayDraftPrompts`：`dayContext`＋存活玩家＋`privateInfo`＋當天公頻白板 | `{"strategy_update": "..." 或 null, "speech": "行動筆記", "stance": "準備好了｜資訊不足"}` | **無字數上限**；草稿是決策筆記，不是發言稿 |
| 白天回應（`DAY_STANCE`） | `buildDayResponsePrompts`：`dayContext`＋公頻白板＋剛發表的 expanded | `{"strategy_update": "..." 或 null, "action": "ready｜speak｜wait", "speech": "...", "stance": "..."}` | 只有 `speak` 才需要 `speech`＋`stance` |
| 白天投票（`DAY_VOTE`） | `buildDayVotePrompts`：存活玩家（排除自己）＋`privateInfo`＋當天公頻白板 | `{"target": "<displayName>"}` 或 `{"target": null}`（棄票） | 不可投自己；名字對不到存活玩家 → 觸發重試 |
| 狼草稿／回應（`WOLF_SPEECH` / `WOLF_STANCE`） | `buildDraftPrompts` / `buildResponsePrompts`：`wolfContext`＋可刀目標＋狼白板＋剛發布的 expanded | 草稿 `{"speech": "...", "stance": "投[人名]｜資訊不足"}`；回應 `{"action": "vote"｜"speak"｜"wait", "target"／"speech"／"stance": ...}` | stance 硬規則＝**今晚刀人目標**；可刀目標排除自己／狼隊／狂人 |
| 共有者草稿／回應（`MASON_SPEECH` / `MASON_STANCE`） | `buildMasonDraftPrompts` / `buildMasonResponsePrompts`：`masonContext`＋白天可鎖定對象＋共有者白板 | 草稿 `{"speech": "...", "stance": "準備好了｜資訊不足"}`；回應 `{"action": "vote"（`target` 固定 `"ready"`）｜"speak"｜"wait", ...}` | stance 硬規則＝**明天安排的準備狀態**（引擎既有 `masonReadyMap` 語意） |
| EXPAND（三個會議共用） | `buildExpandPrompts`：被選中的草稿筆記＋該會議的 context | `{"speech": "完整發言"}` | 3 次重試；全失敗 → fallback 草稿原文；不得新增筆記外的行動、對象或結論 |
| 狼刀（`WOLF_KILL`） | `buildWolfKillPrompts`：狼隊同夥＋狂人＋可刀目標＋最近訊息 | `{"target": "<displayName>"}` | 不可選自己／狂人 |
| 占い（`SEER_CHECK`）／守衛（`GUARD_PROTECT`） | `buildTargetPrompts`：角色＋存活玩家＋`privateInfo` | `{"target": "<displayName>"}` | 不可選自己；守衛 Day1 不行動（引擎擋） |
| judge 選言（`JUDGE`） | `buildJudgePrompts`：**只讀草稿 `speech`**（編號、不標作者） | `{"scores": [n, ...], "best": index}` | 全盲評分；LLM 失敗或全 0 分 → 隨機 fallback（不阻塞） |

- **沒有**「每輪最多發言 2 次」「一句話」「≤50 字」這類舊限制：現行 controller 不用字數上限控制發言，改用 **P12 排版規範**（>50 字換行、≤3 段，見 §13.5）。`ai-player.ts` 的舊 prompt 裡仍留有 `≤50字` / `≤150字` 字串，但該檔不是現行 runtime 路徑（§13.7）。
- 每則 WS 訊息 200 字上限仍在（`MAX_MESSAGE_LEN`）：真人 `WOLF_CHAT`／`MASON_CHAT` 與引擎的 `handleWolfChat` / `publishMasonSpeech` 會擋。`sendDayMessage` 目前**不擋**長度（公頻 expanded 長度不受此上限約束）。

### 13.5 Prompt 結構（現行 `ai-controller.ts`）

**System 段**（`buildSystemPrompt`）：角色名 + `persona` 前 600 字 + `profile.memory`（非空才帶）＋共用硬規則：
- 全繁體中文；只回 JSON，不要多餘文字
- 禁「我先講…」前言、禁「不是…而是…」對立修正、禁「宣告你在回應對方」的開頭（「我接」「你說得對」等同族）
- 說人話：完整通順口語、禁單詞質問、禁鋪陳場面話；動作要具體；禁日文漢字與簡體字混入
- **P12 排版**：`超過 50 字換行分段，≤3 段`（注意：這是**換行規則**、不是字數上限）
- 場上證據邊界：純口頭推理，唯一可用資訊是發言／表態／投票，禁假設玩家持某立場

**Context 段**（附加在 system 之後的 Two-Level Split：Level 1 策略核心／戰術字典／硬規則，Level 2 角色只影響決策）：

| 會議 | context | 掛在哪裡 |
|---|---|---|
| 狼會議 | `wolfContext`（刀人優先序、假跳／對跳結構、投票鎖定、戰術字典） | 狼草稿、狼回應、**狼 EXPAND** |
| 共有者會議 | `masonContext`（與 `wolfContext` 同構，只換身分差異：CO 決策／反假跳／第一天／互信分工／雙 CO 期） | 共有者草稿、共有者回應、**共有者 EXPAND** |
| 白天討論 | `dayContext`（全角色共用：只用公開發言為證據、禁質疑未發言者、禁只談討論方法） | **白天草稿、白天回應、白天 EXPAND**；**不掛** `buildStrategyPrompt` |
| 夜間目標選擇（狼刀／占い／守衛）、白天投票 | 不掛 context（只帶角色＋存活玩家＋情報） | — |

**Memory**：`appendMemory()` 追加到 `profile.memory`（跨階段不重置、**4000 字上限**超出砍最舊；`character/<id>/memory.md` 初始化）。寫入點：`DAY_STRATEGY`（`[Day{N} 策略] …`）、白天草稿與白天回應的 `strategy_update`（`[Day{N}] …`）。

**JSON 契約**（現行欄位）：

```
白天草稿：{"strategy_update": "..." 或 null, "speech": "行動筆記要點", "stance": "準備好了" 或 "資訊不足"}
白天回應：{"strategy_update": "..." 或 null, "action": "ready" | "speak" | "wait", "speech": "...", "stance": "..."}
EXPAND：  {"speech": "完整發言"}
judge：   {"scores": [n, ...], "best": index}
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
- **⚠️ ubuntu 版沒有這條 pipeline 的 runtime**：沒有 120s 定時器、沒有 CD 計時器、也沒有 60s 靜默觸發。ubuntu 的白天 loop 是 §13.6a 的 toggle 制。

#### 狼會議（連續對話 loop，見 §12.3）【source 現況／外部 harness】

AI 狼依 §12.3 的 loop 驅動（非 SpeechScheduler 管線，是持續對話）：

| 步驟 | AI 狼的動作 |
|---|---|
| **出草稿** | 每隻 AI 狼**平行**（`Promise.all`）獨立 LLM 生成草稿（`speech` 行動筆記 + `stance`，符合 persona）；互不可見 |
| **Judge 選言** | judge LLM 全盲評分所有草稿（只讀 speech、不標作者）、選最高分 → 展開後發布到白板（broadcast `WOLF_SPEECH_SELECTED`）；失敗 → 隨機 fallback（不阻塞） |
| **展開草稿** | 將選中的草稿用狼的角色語氣重述成完整發言（`EXPAND` log kind）；失敗重試 3 次後用草稿原文，不阻塞 |
| **讀白板＋回應** | 除發言者外每隻 AI 狼**平行**（`Promise.all`）判斷：「投XXX」（準備投票）／「我要講」（出新草稿）／「資訊不足」（不出草稿）。已 ready 的狼也可撤回（改出草稿） |
| **強制發言** | 若無人出草稿但有狼「資訊不足」→ controller 直接替那些狼再出草稿 |
| **投票** | 收斂後，每隻 AI 狼依自己的 stance **平行**提交 `WOLF_KILL`（不可選自己/狂人） |

- **收斂**：所有狼 stance =「投XXX」且無人出新草稿 → controller 逐狼 `handleToggleWolfReady` → 引擎切 `VOTING` 並回呼 `runWolfVoting`
- **優先序**：有人想講 → 先講（回 ②）；都沒人想講且全 ready → 才投票
- **stance 正規化**：發布時若草稿／展開文已點名可刀目標但 stance 漏「投」前綴 → 補成 `投<目標>` 視為已承諾
- **安全上限**：白板累計 100 則 `WOLF_MESSAGE` 未收斂 → 引擎 broadcast `WOLF_MEETING_ABORTED` 並停止受理（controller 見 `wolfMeetingAborted` 即停驅動，記 `WOLF_ABORT` log）；controller 另有 150 輪迭代 guard 防無限 loop
- **LLM 失敗**：最多 3 次、間隔 2s（見 §13.2）；最終失敗 → 該狼本次視為「等待」／不出草稿（不阻塞，由安全上限兜底）
- **併發**：`x-override-priority: 100+i` 錯開請求（SGLang `--max-running-requests 2` 自動排隊）

#### 共有者會議（連續對話 loop，見 §12.3）【source 現況／外部 harness】

與狼會議同構的 loop 機制，AI 共有者依同一模式驅動：

| 步驟 | AI 共有者的動作 |
|---|---|
| **出草稿** | 每個 AI 共有者**平行**獨立 LLM 生成草稿（`speech` 行動筆記 + `stance`）；互不可見 |
| **Judge 選言** | judge LLM 全盲評分所有草稿、選最高分 → 展開後發布到共有者白板（`publishMasonSpeech`：broadcast `MASON_MESSAGE` + `MASON_SPEECH_SELECTED`，僅雙方） |
| **展開草稿** | 將選中的草稿用共有者的角色語氣重述成完整發言（`EXPAND` log kind）；失敗重試 3 次後用草稿原文，不阻塞 |
| **讀白板＋回應** | 非發言者 AI 共有者 LLM 判斷：「準備好了」（ready）／「我要講」（出新草稿）／「資訊不足」（不出草稿） |
| **收斂** | 雙方都 ready 且無人出新草稿 → 雙方 toggle ON（`handleToggleMasonEndTurn`）解鎖狼的環節 |

- **議題**：明天白天的行動方針（誰主動發言、誰觀察、誰攻擊誰、被質疑時怎麼回應）
- **存活共有者 < 2 人**：直接 toggle ON、不開會（避免夜間卡死）
- **安全上限**：controller 的 `messageCap`（測試時傳 100）→ 停止討論；結束前仍會把未 ready 的共有者 toggle ON
- **LLM 失敗**：最多 3 次、間隔 2s；最終失敗 → 該共有者視為「等待」；全員失敗 → 全員 toggle ON 不卡夜

#### 夜間行動 / 投票（直接呼叫）【source 現況／外部 harness】

- 占い／守衛／白天投票不需 loop，各 AI 玩家一次 LLM 呼叫 → 直接提交引擎（`handleNightAction` / `handleVote`）
- 狼刀走上方「狼會議」的 `VOTING` 階段（`runWolfVoting`，全併發），不在此處
- 若 LLM 呼叫失敗 → 重試 3 次後跳過該 AI 本次行動（不阻塞其他玩家）

#### 清理【source 現況】

- 房間回收時 `game.destroy()` 清所有 phase timer；harness 結束時 `ai.destroy()` → 取消進行中的重試排程（進行中的 fetch 無法中斷，結果會被丟棄）
- **【production 未接線】** `server.ts` 尚未建立 `AiController`，因此正式 server 目前沒有這套排程／清理路徑

#### 13.6a 白天討論（`AiController.runDayDiscussion`，現行流程）

> **【source 現況】** 外部 harness `scripts/external-test-stage2.mjs` 會 `new AiController(...)`，並把 engine callback 接到 `onNightStepActive` / `onWolfSubphaseChange` / `handleBroadcast` / `handlePrivate`，因此以下流程在 harness 可完整觀察。**【production 未接線】** 正式 server 尚未建立 controller（§13.7）。
>
> 這是白天 **V-Day** 概念規格：草稿是**行動筆記**（判斷誰／依據／要表態什麼），完整發言由 EXPAND 產生（§12.4）。

**進入時的狀態重建（resume 友善）**：從 `game.getDayState()` 取回 `dayMessages` 補進本地 dayBoard、取回 `dayReady` 補進 `dayReadyMap`；**只讓未 ready 的 AI 參與**。全部已 ready → 直接結束（不重跑策略與發言）。

**流程：**

```
DAY_DISCUSSION 開始（引擎 broadcast PHASE_CHANGED）
  └─ DAY_STRATEGY：每個存活 AI 一次策略生成（Promise.all）
       └─ 成功才 appendMemory('[Day{N} 策略] …')
  loop（安全 guard 50 輪）：
    ① 所有未 ready 的 AI 各出「行動筆記」草稿（Promise.all）
       └─ strategy_update 非 null → appendMemory('[Day{N}] …')
    ② judge 盲選一篇（只讀草稿、不標作者；失敗 → 隨機 fallback）
    ③ EXPAND：把選中草稿展開成角色語氣的完整發言（3 次重試 + fallback 草稿原文）
    ④ expanded 經既有 MESSAGE 廣播到公頻（game.sendDayMessage）
       └─ 發言者 toggle ready（dayReadyMap 同步）
    ⑤ 其他 AI 讀同一段 expanded → 回應（Promise.all）
         ├─ ready → toggle ready
         ├─ speak → 出新草稿（進下一輪 ①；若原本已 ready 則撤回 ready）
         └─ wait  → 不動作，維持等待
       └─ strategy_update 非 null → appendMemory
    ⑥ 收斂判斷：全 AI ready → break（此時引擎已進 DAY_VOTING）
    ⑦ 有 speak → 新草稿進下一輪 ①
    ⑧ 無 speak 但還有未 ready → 強制那些 AI 出草稿（回 ①）
  結束：確保所有 AI 都 toggle ready ON
```

**各步驟細節：**

| 步驟 | 現行實作 | 重點 |
|---|---|---|
| DAY_STRATEGY | `generateDayStrategies` → `buildStrategyPrompt`，**`Promise.all` 全併發**（不是 14 個 sequential）；依角色分支（占卜師／共有者／狼／其他）；輸出 `{"strategy": "…"}`；**不掛 `dayContext`** | 成功才寫 memory；失敗不阻塞討論 |
| 白天草稿 | `generateDayDrafts` → `buildDayDraftPrompts`：對**所有未 ready** 的 AI **一輪 `Promise.all` 全併發**；輸出含 `strategy_update` | **無字數上限**（不是「一句話 ≤50 字」）；草稿是決策筆記，非發言稿 |
| judge | `judgePickDayDraft` → `judgeScoreIndex`，**只讀草稿 `speech`**、編號不標作者 | 只有一篇草稿時免 judge 直接用 |
| EXPAND | `expandSpeech(..., 'day')`：3 次重試（間隔 2s），全失敗 → fallback 草稿原文 | 私頻那套「2-4 句／給隊友提醒」**不套用到白天**；白天版是「判斷/結論→動作/表態」＋禁「沒人發言」字眼；排版沿用 P12（>50 字換行、≤3 段） |
| expanded broadcast | `game.sendDayMessage(clientId, expanded)` → 既有 `MESSAGE`（公頻），`dayMessages` 保留最近 50 則 | **公頻沒有新增 WS 事件**（§12.8） |
| 其他 AI 回應 | `dayRespond`（`Promise.all`）：`ready` / `speak` / `wait` | 讀的是**同一段 expanded**（不是草稿原文） |
| 收斂 | 全 AI `dayReady` ON → `handleToggleVoteReady` 觸發 `DAY_VOTING`；loop 結束也會補齊未 ready 的 | 對應 `DAY_READY_STATUS` 事件 |
| 安全 guard | `guard > 50` 中止 loop，結束後確保全 toggle ON | 不會無限 loop |

**`dayContext`（全角色共用）**：白天草稿、**白天回應**、**白天 EXPAND** 都掛 `dayContext`（唯一可用證據是公開發言、禁質疑未發言者、禁假設他人立場、禁只談討論方法）；**`buildStrategyPrompt` 不掛 `dayContext`**（策略階段只要角色情報與昨晚私頻白板）。

**草稿定位**：白天的「草稿」同樣是**行動筆記**（判斷誰／依據是對方實際講過什麼／要表態什麼），不是發言稿，不寫逐字台詞；完整口語由 EXPAND 依角色語氣生成。Memory（4000 字上限、跨階段不重置）與 P12 排版規則見 §13.5。

**外部 harness 執行方式（`scripts/external-test-stage2.mjs`）：**

- 15 人全 AI 局：`new AiController(defs, { messageCap: 100 })` + `new GameEngine('STAGE2', ...)`，兩個方向的 callback 互接
- 階段 timeout：**NIGHT / DAY 都是 `0`（不限時）**；每 10 分鐘印一次進度；狼會議 abort 時停止
- 操作者可用 `timeout --signal=INT --kill-after=30s 5m ...` 在外部做 5 分鐘分段；SIGINT 會讓 harness 寫報告與 checkpoint，**不改腳本內部正式 timeout**
- `--stop-at NIGHT_RESULT | DAY_RESULT | GAME_OVER`（預設 `DAY_RESULT`）
- `--save-state <path>`：寫 `game.saveState()` ＋ `.events.json` ＋ `.log.json`
- `--resume <path>`：`game.restoreState()` 直接進 `DAY_DISCUSSION`（跳過 ROLE_REVEAL/NIGHT），`ai.restoreLog()` 把前段 LLM log 縫回報告
- 報告（md）：會議流程、白板、夜間結算、投票軌跡、收斂、LLM 失敗／重試、事件時間軸
- **沒有** 5 分鐘 timeout、**沒有**「從未 ready 的 AI 中隨機選一個」（judge 從**所有**未 ready 的草稿中選）

**仍待做【目標／待實作】：**

- **白天 V-Day 行為驗證（部分完成）**：`medium` 第一段 server 測試於 5 分鐘內完成 14/14 `DAY_STRATEGY` 與 13/14 `DAY_SPEECH`，28/28 個實際 request 都帶 `reasoning_effort=medium`；因 SGLang `max-running-requests=1`，尚未走到 `JUDGE`／`EXPAND`／`MESSAGE`。checkpoint `/tmp/day-medium-5m.json` 可續跑；公頻品質仍待後續分段與 oracle 驗證
- **公頻策略洩漏觀察**（尚未驗證 AI 白天 expanded 發言是否洩漏夜頻策略／身分）；目前**沒有**「白天不得公開夜間私密資訊」的硬規則，等 expanded 公頻稿出現後再決定是否加入

### 13.7 模組

| 檔案 | 說明 | 現行地位 |
|---|---|---|
| `src/lobby-server/llm.ts` | LLM client：`chat(messages, { temperature, priority })` → `fetch(localhost:9090/v1/chat/completions)`（Bearer auth、`x-override-priority`）；失敗回 `null`；不設 timeout | 【source 現況】實際被呼叫的一層，`AiController` 的所有 LLM 呼叫都走這裡 |
| `src/lobby-server/ai-controller.ts` | **實際的 AI loop**：`AiController`（狼會議／共有者會議／白天討論、EXPAND、目標選擇、LLM log、memory 4000 字），import `llm.ts` ＋ `ai-player.ts` 的 persona/memory loader 與 JSON parser | 【source 現況／外部 harness】由 `scripts/external-test-stage2.mjs` 建立；**`server.ts` 尚未 import**（production 未接線） |
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
