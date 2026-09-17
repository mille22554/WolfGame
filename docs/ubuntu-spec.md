# Ubuntu 版規格書：多人實時狼人殺伺服器

分支：`ubuntu`
狀態：M1–M5 已完成並部署上線；M6（前端遊戲 UI）+ M7（AI 補位）待實作

## 1. 定位

外部真人玩家的線上狼人殺入口。支援 6–15 人房間，含完整遊戲流程（角色分配、夜間行動、白天討論投票、勝利判定）。真人不足時由 AI 補位（同機 SGLang 跑 Qwen3.8-27B）。

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
- **獨立**：伺服器架構（main 是單人本地，ubuntu 是多房多人）、前端（main 是 Electron 桌面，ubuntu 是網頁）、房間管理
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
| M7 | AI 補位：LLM client + AI 玩家行動生成（發言/投票/夜間行動）+ SpeechScheduler 管線 | 1 真人 + 5 AI 可跑完整局；AI 發言自然、投票有邏輯、夜間行動合法；LLM 失敗以重試處理，server 掛 → 開新局 | ⬜ |

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
         │    DAY_VOTING ◄──(all players toggle ready)── DAY_DISCUSSION
         │         │
         └─────────┘  (next night)
```

| Phase | 說明 | 結束條件 |
|---|---|---|
| `ROLE_REVEAL` | 各玩家看到自己的角色（私發）；人狼互見、共有者互見 | 10 秒（固定） |
| `NIGHT` | 收集夜間行動：人狼刀人、占い師查人、守衛護人 | 所有有行動的玩家皆已提交 |
| `NIGHT_RESULT` | 公布昨晚結果（死者/平安夜）；霊能者收到黎明資訊 | 10 秒（固定） |
| `DAY_DISCUSSION` | 全存活玩家自由發言（复用 lobby chat） | 所有存活玩家 toggle「準備投票」ON（**目標態**；目前引擎用 120s 定時器） |
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

狼會議是一場**持續的對話 loop**。平票時 round+1 重新討論（非平票不增）。議題包含兩項：**刀人目標**（刀誰）＋**明天白天的行動方針**（誰裝白、誰攻擊、誰安靜）。兩項議題在同一場對話中自然帶出，不分開成兩個階段。每隻狼的草稿包含 `speech`（要說的話）+ `stance`（「投XXX」或「資訊不足」），狼自己宣告自己的狀態。

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
- 該篇的 `speech` 發布到狼白板（WOLF_MESSAGE）
- 該狼的 `stance` 記錄下來

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
- **② Judge 盲選 → 發布**：從草稿中盲選一篇，`speech` 發布到共有者白板（`MASON_MESSAGE`）
- **③ 另一方讀白板 → 回應**：「準備好了」（ready）／「我要講」（出新草稿）／「資訊不足」（不出草稿）
- **④ 收斂判斷**：有出新草稿 → 回 ②；都沒新草稿且雙方都 ready → **收斂** → 雙方 toggle ON
- **安全上限**：白板累計 100 則 `MASON_MESSAGE` 未收斂 → 停止並報告

**議題指引**（prompt 層）：
- 明天白天會議我們的行動方針（誰主動發言、誰觀察、誰攻擊誰）
- 我們對局勢的判斷（誰可疑、誰可能是狼）
- 如果被人質疑，我們怎麼回應
- 不要暴露「我們是共有者」這件事給其他人聽（私頻只有雙方看到）

### 12.4 白天討論（DAY_DISCUSSION）

- 复用 lobby 的 `SEND_MESSAGE` / `MESSAGE`（公頻）
- **無私頻**：WOLF_CHAT / MASON_CHAT 僅 NIGHT 可用，白天只有公頻
- 結束方式：所有存活玩家 toggle「準備投票」ON → 進入投票（同狼會議模式，可隨時 toggle 開/關）（**目標態**；目前引擎用 120s 定時器）
- 已死亡玩家不能發言

### 12.5 投票（DAY_VOTING）

- 全存活玩家各投 1 票：`CAST_VOTE { targetId }` 或 `CAST_VOTE { targetId: null }`（棄票）
- 不可投自己
- 等待所有存活玩家皆已投票（含棄票）→ 立即結算
- 結算：票最高者出局；**平票→無人出局**（不隨機）（**目標態**；目前引擎平票 random 淘汰一人）
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
- 死者不發言、不投票、不操作（前端灰化）
- 死者可看公頻聊天（觀戰）
- 狂人死 → 狼數 -1（狂人算狼）

### 12.8 新增 WS 協議

| 方向 | type | payload | 說明 |
|---|---|---|---|
| C→S | `NIGHT_ACTION` | `{ type: 'WOLF_KILL'\|'SEER_CHECK'\|'GUARD_PROTECT', targetId }` | 提交夜間行動 |
| C→S | `TOGGLE_MASON_END_TURN` | — | 共有者 toggle 回合結束（開/關） |
| C→S | `TOGGLE_WOLF_READY` | — | 人狼 toggle「準備投票」（開/關） |
| C→S | `TOGGLE_VOTE_READY` | — | 存活玩家 toggle「準備投票」（開/關），全部 ON → 進投票 |
| C→S | `CAST_VOTE` | `{ targetId: number \| null }` | 投票（null=棄票） |
| C→S | `WOLF_CHAT` | `{ text }` | 人狼私頻發言（僅 NIGHT） |
| C→S | `MASON_CHAT` | `{ text }` | 共有者私頻發言 |
| S→C | `PHASE_CHANGED` | `{ phase, day }` | phase 切換通知（broadcast 全房） |
| S→C | `NIGHT_STEP_CHANGED` | `{ step: 'guard'\|'mason'\|'wolf'\|'seer' }` | NIGHT 內部子步驟切換（broadcast） |
| S→C | `MASON_END_TURN_STATUS` | `{ ended: [{ id, nickname }] }` | 哪些共有者已 toggle ON（僅發給共有者）（**待實作**；目前用個別 `MASON_READY` 事件） |
| S→C | `WOLF_READY_STATUS` | `{ ready: [{ id, nickname }], voting: bool }` | 哪些狼已準備投票 + 是否進入投票環節（僅發給狼）（**待實作**；目前用個別 `WOLF_READY` 事件） |
| S→C | `WOLF_VOTE_SPLIT` | `{ votes: Record<number, number> }` | 狼投票平票→回討論（僅發給狼） |
| S→C | `WOLF_SPEECH_SELECTED` | `{ round, from, text }` | judge 選出的代表發言（狀態 0.5；僅發給狼，其他狼讀完表態） |
| S→C | `DAY_READY_STATUS` | `{ ready: [{ id, nickname }], total: number }` | 哪些玩家已準備投票（broadcast 存活玩家）（**待實作**） |
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
- `night.ts` 的結算邏輯 → 可复用（需改為 async 等待模式）
- **不共用**：`engine.ts`（事件佇列太複雜）
- **部分共用**：`ai-scheduler.ts` 的 SpeechScheduler 管線邏輯（PRE_SPEECH→JUDGE→SELECT→EXPAND→BROADCAST）；`character-session.ts` 的 prompt 結構可參考，但 ubuntu 版簡化為單一 `ai-player.ts`
- ubuntu 版用更簡單的 **phase 狀態機 + 直接 state mutation** 模式（不需 event queue）

### 12.11 私頻頻道

| 頻道 | 可用 phase | 可見範圍 | 功能定位 |
|---|---|---|---|
| 狼會議（`WOLF_CHAT`） | `NIGHT` | 所有存活人狼 | 協調刀人目標（「我們刀 3 號吧」） |
| 共有者交談（`MASON_CHAT`） | `NIGHT` | 僅共有者雙方 | 確認彼此身份、交換情報 |

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
- 前端視角：AI 玩家與真人玩家完全無區別（不加任何符號/標記，不暴露「這是 AI」）
- 房主可純 AI 局（0 真人參戰 + N AI，真人全部觀戰看 AI 內鬥）也可混合局（1+ 真人 + 剩餘 AI 補位）或全真人局（0 AI）

### 13.2 LLM 端點

| 項目 | 值 |
|---|---|
| 模型 | Qwen3.8-27B-AWQ（INT4，mattbucci 量化）+ DSpark 推測解碼 |
| 推理引擎 | SGLang（`sglang-server.service`） |
| 位址 | `http://127.0.0.1:9090`（同機 localhost） |
| API 格式 | OpenAI-compatible（`POST /v1/chat/completions`） |
| 認證 | `Authorization: Bearer ${SGLANG_API_KEY}`（env 變數，部署時注入） |
| 環境變數 | `SGLANG_API_KEY`、`LLM_MODEL`（model name，預設 `qwen3.8-27b`） |
| 併發限制 | `--max-running-requests 2`（與 PRE_SPEECH 每批 2 個吻合，不需排隊） |
| 呼叫 timeout | 單次 HTTP 請求 60 秒（GPU 27B + DSpark，100 token ≈ 3-8 秒） |
| 失敗處理 | LLM 呼叫失敗（timeout / 5xx / parse error）→ **重試**取得回覆（記錄重試次數）。若 SGLang server 本身掛掉，遊戲無法繼續（所有 AI 呼叫都會失敗）→ 開新局 |

### 13.3 AI 玩家數量

- `aiCount = actualPlayerCount - humanPlayerCount`（開局時計算）
- 下限 0（全真人參戰）；上限 `maxPlayers`（純 AI 局，真人全部觀戰）
- AI 玩家在 `ROLE_REVEAL` 前從角色設定檔載入（`character/` 目錄的 persona + memory），非隨機生成

### 13.4 AI 行動生成

AI 玩家在以下節點由 LLM 決定行動：

| 節點 | Prompt 輸入 | 期望輸出 | 限制 |
|---|---|---|---|
| 討論發言 | 角色 persona + 當天討論記錄（最近 N 條）+ 存活玩家 + 自己的情報 | 一句發言（自然語言） | ≤ 100 token；每輪最多發言 2 次 |
| 投票 | 角色 + 討論記錄摘要 + 存活玩家列表 + 自己的情報 | `targetClientId`（或 null 棄票） | 不可投自己 |
| 夜間行動（狼） | 狼隊成員 + 存活玩家 + 討論觀察 + 狼白板 | 狼會議 loop（見 §13.6） | 不可選自己/狂人 |
| 夜間行動（共有者） | 共有者夥伴 + 存活玩家 + 討論觀察 + 共有者白板 | 共有者會議 loop（見 §13.6） | 收斂後雙方 toggle ON |
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

### 13.6 AI 排程（沿用 main 分支 SpeechScheduler 管線）

#### 白天討論發言（SpeechScheduler 管線）（**待實作**；目前引擎用 120s 定時器推進，無 AI 發言排程）

```
IDLE →（60s 無訊息 或 全真人跳過）→ PRE_SPEECH → JUDGE → SELECT → EXPAND → BROADCAST → IDLE
```

| 階段 | 說明 | 參數 |
|---|---|---|
| IDLE | 每 1s 檢查；等待 CD 無新訊息 | `cdMs=60000`（有真人）/ `0`（無真人，立即觸發）, `checkIntervalMs=1000` |
| PRE_SPEECH | 所有存活 AI 分批（每批 2 個）依序平行生成草稿（≤100 token）；**等全部 batch 完成才進 JUDGE** | `preSpeechBatch=2`, `temp=1.0` |
| JUDGE | 全部草稿到齊後，單次 LLM 呼叫全盲評分所有草稿（不告知哪個 AI 寫哪段） | `temp=0.7`（不限 token） |
| SELECT | 新穎性懲罰（與最近 3 則訊息比較）+ top3 中隨機選一 | `topK=3`, `recentCompareCount=3` |
| EXPAND | 將選中的草稿展開為完整發言（commit 點，之後不中斷） | `temp=1.0` |
| BROADCAST | 見下方邏輯 | — |

**BROADCAST 邏輯**（60s 靜默到期時）：
1. 若 AI 發言已選出（管線完成）→ 立即 broadcast
2. 若尚未選出 → 等待管線完成；但等待期間若有任何新訊息進入 → 視同 CD 中斷（重置 60s 計時、作廢當前管線、回 IDLE）

- **版本無效化**：管線執行中若 board 版本變更（有人發言/phase 切換）→ 作廢回 IDLE
- **全真人跳過**：CD 歸零（立即觸發管線 + broadcast）

#### 狼會議（連續對話 loop，見 §12.3）

AI 狼依 §12.3 的 loop 驅動（非 SpeechScheduler 管線，是持續對話）：

| 步驟 | AI 狼的動作 |
|---|---|
| **出草稿** | 每隻 AI 狼獨立 LLM 生成草稿（`speech` + `stance`，≤50 字，符合 persona）；互不可見 |
| **Judge 選言** | server 端 judge LLM 全盲評分所有草稿、選最高分 → 發布 `speech` 到白板（broadcast `WOLF_SPEECH_SELECTED`） |
| **讀白板＋回應** | 除發言者外每隻 AI 狼 LLM 判斷：「投XXX」（準備投票）／「我要講」（出新草稿）／「資訊不足」（不出草稿）。已 ready 的狼也可撤回（改出草稿） |
| **強制發言** | 若無人出草稿但有狼「資訊不足」→ server 通知那些狼必須發言（再出草稿） |
| **投票** | 收斂後，每隻 AI 狼依自己的 stance 提交 `WOLF_KILL`（不可選自己/狂人） |

- **收斂**：所有狼 stance =「投XXX」且無人出新草稿 → 進投票
- **優先序**：有人想講 → 先講（回 ②）；都沒人想講且全 ready → 才投票
- **安全上限（測試用）**：白板累計 100 則 `WOLF_MESSAGE` 未收斂 → 停止並報告（不自動收斂）
- **LLM 失敗**：重試取得回覆（見 §13.2）；最終失敗 → 該狼本次不出草稿（不阻塞，由安全上限兜底）

#### 共有者會議（連續對話 loop，見 §12.3）

與狼會議完全相同的 loop 機制，AI 共有者依同一模式驅動：

| 步驟 | AI 共有者的動作 |
|---|---|
| **出草稿** | 每個 AI 共有者獨立 LLM 生成草稿（`speech` + `stance`，≤50 字，符合 persona）；互不可見 |
| **Judge 選言** | server 端 judge LLM 全盲評分所有草稿、選最高分 → 發布 `speech` 到共有者白板（broadcast `MASON_SPEECH_SELECTED`） |
| **讀白板＋回應** | 非發言者 AI 共有者 LLM 判斷：「準備好了」（ready）／「我要講」（出新草稿）／「資訊不足」（不出草稿） |
| **收斂** | 雙方都 ready 且無人出新草稿 → 雙方 toggle ON（`handleToggleMasonEndTurn`） |

- **議題**：明天白天的行動方針（誰主動發言、誰觀察、誰攻擊誰、被質疑時怎麼回應）
- **安全上限（測試用）**：白板累計 100 則 `MASON_MESSAGE` 未收斂 → 停止並報告
- **LLM 失敗**：重試取得回覆（見 §13.2）；最終失敗 → 該共有者直接 toggle ON（不阻塞）

#### 夜間行動 / 投票（直接呼叫）

- 非發言類行動（查人、護人、白天投票）不需管線，直接單一 LLM 呼叫
- 各 AI 玩家獨立呼叫（無平行需求，因為每個 AI 只有一個決定要做）
- 狼刀走上方「狼會議（連續對話）」流程，不在此處
- 若 LLM 呼叫失敗 → 重試取得回覆（見 §13.2）

#### 清理

- 遊戲解散（room destroy）時：cancel 管線 + abort 進行中的 LLM 呼叫

### 13.7 新增模組

| 檔案 | 說明 |
|---|---|
| `src/lobby-server/llm.ts` | LLM client：`chat(messages, { timeout })` → `fetch(localhost:9090/v1/chat/completions)`（Bearer auth）；回傳 `string \| null` |
| `src/lobby-server/ai-player.ts` | AI 玩家邏輯：`generateSpeech()`、`generateVote()`、`generateNightAction()` → 組裝 prompt → 呼叫 llm → parse JSON → 回傳行動 |

### 13.8 GameEngine 整合點

- `start()`：分配角色後，為 AI 玩家從角色設定檔載入 persona；AI 玩家不發 `ROLE_REVEALED`（無 WS 連線）
- `transitionTo('NIGHT')`：啟動 AI 夜間行動（直接 LLM 呼叫）
- `transitionTo('DAY_DISCUSSION')`：啟動 AI 發言排程
- `transitionTo('DAY_VOTING')`：啟動 AI 投票排程
- AI 行動走同一個 `handleNightAction()` / `handleVote()` 路徑（engine 不區分真人/AI）
- `destroy()`：clear 所有 AI 排程 timer + abort 進行中的 LLM 呼叫

### 13.9 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `SGLANG_PORT` | `9090` | SGLang server 埠 |
| `SGLANG_HOST` | `127.0.0.1` | SGLang host（同機） |
| `SGLANG_API_KEY` | —（部署時注入） | Bearer token |
| `LLM_MODEL` | `qwen3.8-27b` | model name（`--served-model-name`） |
| `LLM_TIMEOUT_MS` | `60000` | 單次 LLM 呼叫 timeout |
| `AI_ENABLED` | `true` | 設 `false` 可停用 AI 補位（純真人模式） |

### 13.10 systemd 部署

SGLang 已有獨立 systemd service（`sglang-server.service`），wolfgame 只需在 `After=` 依賴它：

```ini
# /etc/systemd/system/wolfgame.service（相關欄位）
[Unit]
After=network-online.target sglang-server.service
Wants=sglang-server.service
```

- `wolfgame.service` 加 `After=sglang-server.service`（確保 LLM 先啟動）
- 模型檔案：`/home/morowin/models/Qwen3.8-27B-AWQ`（~18.7GB，git 外管理）
