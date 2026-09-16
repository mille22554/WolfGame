# Ubuntu 版規格書：多人實時狼人殺伺服器

分支：`ubuntu`
狀態：M1–M5 已完成並部署上線；M6（前端遊戲 UI）+ M7（AI 補位）待實作

## 1. 定位

外部真人玩家的線上狼人殺入口。支援 6–15 人房間，含完整遊戲流程（角色分配、夜間行動、白天討論投票、勝利判定）。真人不足時由 AI 補位（同機 llama.cpp 跑 Qwen3.8 27B）。

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
│                                       ▼  │       │
│                              ┌──────────────────┐ │
│                              │ llama-server      │ │
│                              │ (Qwen3.8 27B)    │ │
│                              │ port 2064        │ │
│                              │ OpenAI-compat API │ │
│                              └──────────────────┘ │
└─────────────────────────────────────────────────────┘
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
- **共用**：遊戲規則常數（角色定義、勝利條件）、類型定義（`Role`、`PlayerState`）、LLM client 模式（OpenAI-compatible API 呼叫）
- **獨立**：伺服器架構（main 是單人本地，ubuntu 是多房多人）、前端（main 是 Electron 桌面，ubuntu 是網頁）、房間管理、AI 排程（ubuntu 用錯峰 timer，main 用 event queue）
- 若共用代碼維護成本 > 獨立，則完全分開，只 sync 規則常數

## 5. 房間生命週期

```
建立 → Lobby（等待玩家）→ 遊戲中（Night/Day 循環）→ 結束 → 清理
                │                    │
                │                    ├── 遊戲中斷（房主解散）→ 回到 Lobby
                │                    └── 全部掉線 → 暫停（5 分鐘未回來→清理）
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
| M7 | AI 補位：LLM client + AI 玩家行動生成（發言/投票/夜間行動）+ 錯峰排程 | 1 真人 + 5 AI 可跑完整局；AI 發言自然、投票有邏輯、夜間行動合法；LLM timeout 不卡死遊戲 | ⬜ |

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
         │    DAY_VOTING ◄──(host ends discussion)── DAY_DISCUSSION
         │         │
         └─────────┘  (next night)
```

| Phase | 說明 | 結束條件 |
|---|---|---|
| `ROLE_REVEAL` | 各玩家看到自己的角色（私發）；人狼互見、共有者互見 | 10 秒（固定） |
| `NIGHT` | 收集夜間行動：人狼刀人、占い師查人、守衛護人 | 所有有行動的玩家皆已提交 |
| `NIGHT_RESULT` | 公布昨晚結果（死者/平安夜）；霊能者收到黎明資訊 | 10 秒（固定） |
| `DAY_DISCUSSION` | 全存活玩家自由發言（复用 lobby chat） | 房主手動結束 |
| `DAY_VOTING` | 全存活玩家投票（含棄票） | 所有存活玩家皆已投票 |
| `DAY_RESULT` | 公布投票結果（死者身分不公開）；霊能者得知票死者身分 | 10 秒（固定） |
| `GAME_OVER` | 公布所有角色、勝負結果 | 永久（直到房間解散/重開） |

> **不限時設計**：NIGHT / DAY_DISCUSSION / DAY_VOTING 皆等待所有玩家完成行動才推進。玩家可從容思考，不被倒數逼迫。掉線處理見 §5（全部掉線 → 暫停 5 分鐘 → 清理）。

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

各角色可提交的行動：

| 角色 | 行動 | 限制 |
|---|---|---|
| 人狼 | `WOLF_KILL { targetId }` | 所有存活人狼各自提交；不可選自己、不可選狂人；多數決（同目標票最高；平票→先提交者）；提交前可通過狼會議（WOLF_CHAT）協調 |
| 占い師 | `SEER_CHECK { targetId }` | 不可選自己；每夜一次 |
| 守衛 | `GUARD_PROTECT { targetId }` | Day1 不可；不可自護（自護→隨機護他人）；可連續護同一人 |
| 霊能者 | 無（被動） | 黎明自動收到昨日票死者身分 |
| 共有者 | 無主動行動 | 可發 `MASON_CHAT`（僅雙方可見） |
| 村民/狂人 | 無 | — |

**結算順序**（server-side，不可並行）：
1. 守衛護 → 記錄 `guardedTargetId`
2. 人狼刀 → 若目標 == guardedTargetId → 平安夜（kill blocked）；否則目標死亡
3. 占い師查 → 結果僅發給占い師
4. 黎明：霊能者收到「昨天被票死者」身分（Day1 無）

**結束條件**：
- 所有有夜間行動的玩家（存活狼 + 占い師 + 守衛）皆已提交 → 立即結算
- 未提交的玩家會一直等待（前端顯示「等待中…」）
- 人狼多數決：所有存活狼皆提交後，取同目標票最高者；平票→先提交者
- 若某角色已全數死亡（如占い師已死）→ 該角色不需提交，不阻塞 phase 結束

### 12.4 白天討論（DAY_DISCUSSION）

- 复用 lobby 的 `SEND_MESSAGE` / `MESSAGE`（公頻）
- 額外頻道：
  - `WOLF_CHAT` / `WOLF_MESSAGE`：僅存活人狼可見
  - `MASON_CHAT` / `MASON_MESSAGE`：僅共有者雙方可見
- 房主發 `END_DISCUSSION` 進入投票（唯一結束方式）
- 已死亡玩家不能發言（任何頻道）

### 12.5 投票（DAY_VOTING）

- 全存活玩家各投 1 票：`CAST_VOTE { targetId }` 或 `CAST_VOTE { targetId: null }`（棄票）
- 不可投自己
- 等待所有存活玩家皆已投票（含棄票）→ 立即結算
- 結算：票最高者出局；平票→隨機選一位（或無人出局，取「隨機」）
- 被票死者身分不公開（僅霊能者得知）

### 12.6 勝利判定

每輪 DAY_RESULT 後檢查：
- **村勝**：存活人狼數 == 0
- **狼勝**：存活人狼數 ≥ 存活村人陣營數（含狂人、共有者、村民、占い師、守衛、霊能者）
- 平局不可能（狼 ≥ 村 時狼已勝）

### 12.7 死亡規則

- 夜殺：身分完全不公開（任何人不知道，含霊能者）
- 票死：身分不公開（僅霊能者得知）
- 死者不發言、不投票、不操作（前端灰化）
- 死者可看公頻聊天（觀戰）
- 狂人死 → 人狼陣營少一人（但狂人算村人陣營，所以狼數不變）

### 12.8 新增 WS 協議

| 方向 | type | payload | 說明 |
|---|---|---|---|
| C→S | `NIGHT_ACTION` | `{ type: 'WOLF_KILL'\|'SEER_CHECK'\|'GUARD_PROTECT', targetId }` | 提交夜間行動 |
| C→S | `CAST_VOTE` | `{ targetId: number \| null }` | 投票（null=棄票） |
| C→S | `END_DISCUSSION` | — | 房主提前結束討論 |
| C→S | `WOLF_CHAT` | `{ text }` | 人狼私頻發言 |
| C→S | `MASON_CHAT` | `{ text }` | 共有者私頻發言 |
| S→C | `PHASE_CHANGED` | `{ phase, day }` | phase 切換通知（broadcast 全房） |
| S→C | `ROLE_REVEALED` | `{ role, displayName, description, partners? }` | 私發各玩家自己的角色 |
| S→C | `NIGHT_RESULT` | `{ peacefulNight: bool, deaths: [{ id, nickname }] }` | 夜間結果（broadcast） |
| S→C | `SEER_RESULT` | `{ targetId, nickname, result: 'villager'\|'werewolf' }` | 私發占い師 |
| S→C | `GUARD_RESULT` | `{ targetId, nickname, blocked: bool }` | 私發守衛 |
| S→C | `MEDIUM_RESULT` | `{ targetId, nickname, result: 'villager'\|'werewolf' }` | 私發霊能者（黎明） |
| S→C | `VOTE_RESULT` | `{ votes: Record<number, number>, eliminatedId: number\|null, tie: bool }` | 投票結果（broadcast） |
| S→C | `PLAYER_ELIMINATED` | `{ id, nickname, cause: 'wolf_kill'\|'vote' }` | 有人出局（broadcast） |
| S→C | `GAME_OVER` | `{ winner: 'village'\|'werewolf', players: [{ id, nickname, role, alive }] }` | 終局（broadcast，公布全部角色） |
| S→C | `WOLF_MESSAGE` | `{ from, text, ts }` | 人狼私頻（僅存活人狼） |
| S→C | `MASON_MESSAGE` | `{ from, text, ts }` | 共有者私頻（僅雙方） |

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
- `night.ts` 的結算邏輯 → 可复用（需改為 async/timeout 模式）
- **不共用**：`engine.ts`（事件佇列太複雜）、`ai-scheduler.ts`（排程模式不同）
- **部分共用**：`character-session.ts` 的 prompt 結構可參考，但 ubuntu 版簡化為單一 `ai-player.ts`
- ubuntu 版用更簡單的 **phase timer + 直接 state mutation** 模式（不需 event queue）

### 12.11 私頻頻道

| 頻道 | 可用 phase | 可見範圍 | 功能定位 |
|---|---|---|---|
| 狼會議（`WOLF_CHAT`） | `NIGHT` + `DAY_DISCUSSION` | 所有存活人狼 | 夜間：協調刀人目標（「我們刀 3 號吧」）；白天：協調投票策略、交換觀察 |
| 共有者交談（`MASON_CHAT`） | `NIGHT` + `DAY_DISCUSSION` | 僅共有者雙方 | 確認彼此身份（開局後首次）、交換情報、協調投票 |

**規則：**
- 已死亡玩家不能發送任何私頻訊息（含狼、共有者）
- 人狼死亡 → 剩餘存活狼仍可用狼會議
- 共有者一方死亡 → 該頻道停用（剩下一方無法對話）
- 私頻訊息**不記錄在公頻**，其他玩家完全看不到
- 觀戰者看不到任何私頻
- 訊息格式與公頻相同：`{ from, text, ts }`
- 每則訊息上限 200 字（與公頻相同）

**與 main 分支的差異：**
- main 分支的「狼隊會議」是 LLM 驅動的結構化對話（多輪 back-and-forth 後投票決選）
- ubuntu 版是**即時聊天頻道**（真人打字、即時 broadcast 給狼隊），更簡單直覺
- 狼隊最終刀誰仍由各自提交 `WOLF_KILL` 決定（多數決），聊天只是協調工具

## 13. AI 補位（M7）

### 13.1 定位

- 真人參戰者 < 實際開局人數時，AI 補滿剩餘席位
- AI 玩家與真人玩家完全同權：发言、投票、夜間行動、私頻聊天
- 前端視角：AI 玩家顯示為普通玩家（暱稱前加 🤖），無特殊標記（不暴露「這是 AI」給其他真人）
- 房主可純 AI 局（1 真人 + N AI）也可全真人局（0 AI）

### 13.2 LLM 端點

| 項目 | 值 |
|---|---|
| 模型 | Qwen3.8 27B（GGUF Q4_K_M 量化） |
| 推理引擎 | llama.cpp server（`llama-server`） |
| 位址 | `http://127.0.0.1:2064`（同機 localhost） |
| API 格式 | OpenAI-compatible（`POST /v1/chat/completions`） |
| 環境變數 | `LLAMA_SERVER_PORT`（預設 2064）、`LLM_MODEL`（model tag，預設空＝server 唯一模型） |
| 超时 | 單次呼叫 30 秒（CPU 27B 推論 60 token ≈ 15-30 秒） |
| 呼叫 timeout | 單次 HTTP 請求 30 秒（CPU 27B 推論 60 token ≈ 15-30 秒） |
| Fallback | LLM 呼叫失敗（timeout / 5xx / parse error）→ server 自動替該 AI 提交預設行動（狼→隨機刀一人；占い→隨機查一人；守衛→隨機護一人；投票→棄票；發言→跳過）。**必須自動提交**，因為 phase 無 timeout，若 AI 永遠不提交則遊戲卡死 |

### 13.3 AI 玩家數量

- `aiCount = actualPlayerCount - humanPlayerCount`（開局時計算）
- 下限 0（全真人）；上限 `maxPlayers - 1`（至少 1 真人房主）
- AI 玩家在 `ROLE_REVEAL` 前生成：隨機 persona + 隨機暱稱（「AI-村夫」「AI-旅人」等）

### 13.4 AI 行動生成

AI 玩家在以下節點由 LLM 決定行動：

| 節點 | Prompt 輸入 | 期望輸出 | 限制 |
|---|---|---|---|
| 討論發言 | 角色 persona + 當天討論記錄（最近 N 條）+ 存活玩家 + 自己的情報 | 一句發言（自然語言） | ≤ 100 token；每輪最多發言 2 次 |
| 投票 | 角色 + 討論記錄摘要 + 存活玩家列表 + 自己的情報 | `targetClientId`（或 null 棄票） | 不可投自己 |
| 夜間行動（狼） | 狼隊成員 + 存活玩家 + 討論觀察 | `targetClientId` | 不可選自己/狂人 |
| 夜間行動（占い） | 角色 + 存活玩家 + 過去查驗記錄 | `targetClientId` | 不可選自己 |
| 夜間行動（守衛） | 角色 + 存活玩家 + 過去守護記錄 | `targetClientId` | 不可自護；Day1 不行動 |

### 13.5 Prompt 結構

```
System:
  你是「{nickname}」，在狼人殺遊戲中扮演「{roleDisplayName}」。
  {roleDescription}
  你的性格：{personality}
  規則：你只能回覆 JSON，不要多餘文字。

User（討論發言）:
  當前：第 {day} 天 白天討論。
  存活玩家：{playerList}
  你的情報：{privateInfo}（占い結果/狼隊身份/共有者夥伴/無）
  最近討論：
    {recentMessages}
  請發表你的看法（一句話，≤50字）。
  回覆格式：{"speech": "..."}

User（投票）:
  當前：第 {day} 天 投票階段。
  存活玩家：{playerList}
  你的情報：{privateInfo}
  討論摘要：{discussionSummary}
  請選一個你要投票淘汰的玩家。
  回覆格式：{"target": "clientId"} 或 {"target": null}

User（夜間行動）:
  當前：第 {day} 夜。你是 {roleDisplayName}。
  存活玩家：{playerList}
  你的情報：{privateInfo}
  {roleSpecificInstruction}
  回覆格式：{"target": "clientId"}
```

- `privateInfo`：依角色不同——占い師看到過去查驗結果；人狼知道同夥+狂人；共有者知道夥伴；村民/狂人/霊能者（僅票死資訊）
- `roleSpecificInstruction`：狼→「選一個你要刀的人（不可選自己或狂人）」；占い→「選一個你要查驗的人」；守衛→「選一個你要守護的人（不可選自己）」

### 13.6 錯峰排程

避免所有 AI 同時轟擊 LLM（CPU 競爭 → 全部 timeout）：

- AI 行動間隔 **3–5 秒**（隨機）
- 同一 phase 內，AI 依 `joinSeq` 順序依次行動
- 例：5 個 AI 的夜間行動 → AI1 在 t+0s、AI2 在 t+4s、AI3 在 t+7s、AI4 在 t+11s、AI5 在 t+14s 提交
- 討論發言：AI 在 phase 開始後 5s、15s、30s... 隨機時間發言（模擬真人節奏）
- 若遊戲被解散（room destroy）時 AI 的 LLM 呼叫仍在進行中 → abort 該呼叫

### 13.7 新增模組

| 檔案 | 說明 |
|---|---|
| `src/lobby-server/llm.ts` | LLM client：`chat(messages, { timeout, maxTokens })` → `fetch(localhost:2064/v1/chat/completions)`；回傳 `string \| null` |
| `src/lobby-server/ai-player.ts` | AI 玩家邏輯：`generateSpeech()`、`generateVote()`、`generateNightAction()` → 組裝 prompt → 呼叫 llm → parse JSON → 回傳行動 |

### 13.8 GameEngine 整合點

- `start()`：分配角色後，為 AI 玩家生成 persona + 暱稱；AI 玩家不發 `ROLE_REVEALED`（無 WS 連線）
- `transitionTo('NIGHT')`：啟動 AI 夜間行動排程（錯峰 timer）
- `transitionTo('DAY_DISCUSSION')`：啟動 AI 發言排程
- `transitionTo('DAY_VOTING')`：啟動 AI 投票排程
- AI 行動走同一個 `handleNightAction()` / `handleVote()` 路徑（engine 不區分真人/AI）
- `destroy()`：clear 所有 AI 排程 timer + abort 進行中的 LLM 呼叫

### 13.9 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `LLAMA_SERVER_PORT` | `2064` | llama-server 埠 |
| `LLAMA_SERVER_HOST` | `127.0.0.1` | llama-server host（同機） |
| `LLM_MODEL` | `''`（空＝server 唯一模型） | 多模型時指定 model tag |
| `LLM_TIMEOUT_MS` | `30000` | 單次 LLM 呼叫 timeout |
| `LLM_MAX_TOKENS` | `200` | 單次回應 max tokens |
| `AI_ENABLED` | `true` | 設 `false` 可停用 AI 補位（純真人模式） |

### 13.10 systemd 部署

llama-server 需獨立 systemd service（或與 wolfgame 同一 unit 的 ExecStartPre）：

```ini
# /etc/systemd/system/llama-server.service
[Unit]
Description=llama.cpp server (Qwen3.8 27B)
Before=wolfgame.service

[Service]
User=morowin
WorkingDirectory=/opt/llama
ExecStart=/opt/llama/llama-server -m /opt/llama/models/qwen3.8-27b-q4.gguf --port 2064 --host 127.0.0.1 -c 4096
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- `wolfgame.service` 加 `After=llama-server.service`（確保 LLM 先啟動）
- 模型檔案：`/opt/llama/models/`（~16GB Q4_K_M，git 外管理）
