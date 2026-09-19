# 進度追蹤（ubuntu 分支）

> 更新：2026-09-18
> 用途：新 session 接手時讀此文件即可無縫繼續。

## 目前狀態

**卡在哪：** 白天（DAY_DISCUSSION）外部測試進行中；發現白天討論「meta 繞圈」問題，已修 prompt，待重跑。

- ✅ 夜流程（NIGHT_RESULT）已通過多次驗證
- ✅ 狼會議收斂邏輯修好（不再 premature VOTING）
- ✅ Wolf prompt 重構（Two-Level Split + 防幻覺 + 防重複 + 防假設性回應 + 防前綴）
- ✅ 白天討論 prompt 加「純口頭推論」限制（防 Among Us 路徑/軌跡/不在場證明）
- ✅ 報告完整合併（events 存 .events.json，resume 時載入前段一起出報告）
- ✅ 全併發 LLM 呼叫（strategy/drafts/responses/voting 全部 `Promise.all`）
- ✅ `x-override-priority` header（併發時 100+i 錯開，SGLang 依 priority 排程）
- ✅ **證據邊界硬規則**（`buildSystemPrompt`）：場上無時間線/地點/行蹤/在場證明，推理只限發言、矛盾、表態、投票——修白天討論「meta 繞圈」（玩家脑補「時間差三分鐘」等不存在證據）
- ✅ **白天策略/草稿/回應/投票 prompt 加「點名具體玩家」+ 禁止規則空談**（引用 `docs/ai-rp-prompt-research.md`：Level 1 策略核心 + 防編造 + reminder）
- ✅ **persona 修正**：shinichi/yuko/tatuya 的「時間線/分鐘/看到的現象」範例改為發言矛盾型（真一「昨晚和誰同點、時間差三分鐘」即源自 persona 範例腦補）
- ✅ 白天測試紀錄（`stage2-day-report.md`）：狼會議不完整是舊格式 `night1.json` 無 `.log.json`（非渲染 bug）——要完整狼會議需重跑整局 night
- ✅ **白天開場「捏造他人立場」幻覺修復**：良子第一句「不跟佐雪的立場走」——佐雪全程零發言，立場是憑空捏造（白板空＋強迫點名的 prompt 側效果）。system prompt 證據邊界新增「禁止假設任何玩家持某立場/講過什麼，除非實際出現在白板」；strategy/draft/response prompt 加降級規則「只能質疑已發言的實際內容，沒人發言就談自己觀察」（參考 `docs/ai-rp-prompt-research.md` §4 anti-fabrication）
- ⏳ 白天收斂測試重跑（用重跑的 night 存檔，待驗證新 prompt）

**本 session 修的東西：**
- `isWolfReady`/`isMasonReady` 改回讀本地 map（不讀 game.state——private）
- Wolf loop 不再在 loop 中呼叫 `game.handleToggleWolfReady`（會觸發 premature VOTING 轉換）
  - loop 中只用 `wolfReadyMap` 本地追蹤 + `broadcastToWolves` 通知
  - loop 收斂後才呼叫 `game.handleToggleWolfReady` 同步 state 觸發 VOTING
- Wolf prompt 重構為 Two-Level Split（照 `docs/ai-rp-prompt-research.md`）
  - Level 1：策略核心（MANDATORY）——刀人優先序、Dead Players、禁止/正確做法對照
  - Level 2：角色語氣（2-4 句）
- 防幻覺：「此頻道只有狼。不要引用沒在白板上出現的發言。」
- 防重複：「不要重複你已講過的內容。沒有新東西就 vote 確認。」
- 防假設性回應：「如果有人問我我就說...」→ 禁止，直接說明天要怎麼做
- 防前綴：「speech 裡出現 P1、P13、#1 等任何編號/前綴」→ 禁止
- `wait` 語意修正：已表態的狼用 `vote` 確認，`wait` 只給還沒表態過的狼
- 白天討論 prompt 加：「⚠️ 純口頭推論遊戲。沒有路徑、軌跡、不在場證明、操作記錄。」
- 測試腳本：DAY timeout = 300s（5 分鐘，測試方便；非正式需求）
- 報告完整合併：events 存進 `.events.json`，resume 時載入前段 events 一起出報告
- 全併發 LLM 呼叫：`generateDayStrategies`/`generateDayDrafts`/day responses/wolf responses/wolf voting/day voting 全部改 `Promise.all`（SGLang 端自動排隊）
- `x-override-priority` header：所有併發 LLM 呼叫加 priority（100+i），SGLang 依 priority 排序處理
  - `llm.ts`：`ChatOptions` 加 `priority?: number`；fetch headers 加 `x-override-priority`
  - `ai-controller.ts`：`llmWithRetry` 加 `priority` 參數；所有 `Promise.all` 的 map 回調用 `100 + i`
- Day log kind 修正：`generateDayDrafts` 從 `'WOLF_SPEECH'`→`'DAY_SPEECH'`；`dayRespond` 從 `'WOLF_STANCE'`→`'DAY_STANCE'`；`runDayVoting` 從 `'WOLF_KILL'`→`'DAY_VOTE'`（修報告把 day 輸出歸到狼會議的 bug）
- 併發實測（5 路 `x-override-priority` 100~104）：全 200 有內容，SGLang 正常；報告的 DAY_STRATEGY「null」是假警報（`ai-controller.ts:599` 成功後 log attempt=0 + response=null 標記，被報告過濾器誤當失敗）→ 報告過濾器改為忽略 `attempt=0`（`aebf062`）
- **報告跨段修復（`77dee55` 後續）：AI log 併入 save-state（`<存檔>.log.json`），harness resume 時 `ai.restoreLog()` 縫回**——狼會議/共有者/白天流程不再因 resume 遺失 LLM 記錄
  - `ai-controller.ts`：新增 `restoreLog(entries)`（push 前段 log）
  - `external-test-stage2.mjs`：resume 讀 `.log.json`；save 寫 `.log.json`
  - 附註：WOLF_READY 每狼 2 筆是設計（loop 預覽廣播＋收斂後 `handleToggleWolfReady` sync 廣播各一次），非 bug
- **白天 meta 繞圈根因與修復**：真一「昨晚和誰同點、時間差三分鐘誰圓」是 LLM 從 persona 範例（shinichi「第三分鐘/第五分鐘/時間線」）腦補出的虛構證據；全場跟著訂「三欄比對/口徑」等空頭規則 → 28 分鐘僅 2/14 ready
  - `buildSystemPrompt` 加「場上證據邊界」硬規則：無時間線/地點/行蹤/在場證明，推理只限發言、矛盾、表態、投票（參考 `docs/ai-rp-prompt-research.md` §4 anti-fabrication）
  - 白天 strategy/draft/response/vote prompt：要求「點名具體玩家」；禁止只談討論方法（「定規則」「訂口徑」＝空轉不算發言）
  - persona：shinichi 範例改為發言矛盾型質問；yuko「時間線對完」→「把發言對一對」；tatuya「看到的現象」→「觀察到的發言現象」
- 併發實測補充（14 路全過）：5 併發 967 tokens 全 200；14 併發 ~9.2K tokens 全 200、~49s 完成（SGLang `--max-running-requests 1` 依 priority 排隊）。先前 5 併發測試因 PowerShell 管道把中文打成 `?`（prompt=65 是亂碼），改用 base64 上傳後為正常 prompt（~79 tokens）

**下一步（依序）：**
1. resume `/tmp/night1.json`（不重跑 night；resume 直接進 DAY_DISCUSSION）→ 跑白天收斂
2. 驗證新 prompt：白天討論是否具體點名、不再 meta 繞圈、ready 收斂速度
3. 觀察白天討論品質（發言內容、收斂速度、狼的表現）
4. 若 AI 品質有問題 → 調 prompt → 重跑
5. 全部通過 → Step 5（AI 接 production server）

**Server 上跑測試的正確方式：**
```bash
# 先 kill 舊 process
ssh ssh.morowin.win "pkill -f external-test-stage2"

# 跑夜晚 + 存檔（~3 min）
ssh ssh.morowin.win "cd /opt/wolfgame && SGLANG_API_KEY=ec1f8d... node scripts/external-test-stage2.mjs --stop-at NIGHT_RESULT --save-state /tmp/night1.json"

# 從存檔接白天（5 分鐘一段，可多次接續）
ssh ssh.morowin.win "cd /opt/wolfgame && SGLANG_API_KEY=ec1f8d... node scripts/external-test-stage2.mjs --resume /tmp/night1.json --stop-at DAY_RESULT --save-state /tmp/day1.json"

# 接續下一段（報告會合併前段 events）
ssh ssh.morowin.win "cd /opt/wolfgame && SGLANG_API_KEY=ec1f8d... node scripts/external-test-stage2.mjs --resume /tmp/day1.json --stop-at DAY_RESULT --save-state /tmp/day2.json"

# 取回報告
scp ssh.morowin.win:/opt/wolfgame/ai-trace-stage2-day.md "C:\Users\user\Desktop\FrankTests\Temp\ai-trace-stage2-day.md"
```

## 已完成

| 項目 | Commit | 說明 |
|---|---|---|
| Night 流程完整實作 | 多個 | mason/wolf/seer 會議 loop + 結算 + NIGHT_RESULT |
| Spec 更新 | `bff5cc5` | 白天項目標注「目標態/待實作」；CD 自動判斷 |
| 100 則上限改可選 | `e95f5d6` | `wolfMessageCap`/`messageCap` 預設 0=停用 |
| Step 1+2：toggle 制 + 平票 | `48b8127` | 移除 120s timer；`TOGGLE_VOTE_READY`/`DAY_READY_STATUS`；平票→無人出局 |
| Step 3+4：AI 白天討論+投票 | `c397b49` | `runDayDiscussion()`/`runDayVoting()`/prompt builders |
| Fix：一次一個 AI 發言 | `c1f65ad` | `generateDayDrafts` 從 15 平行→隨機選 1 個 |
| docs/ai-rp-prompt-research.md | `c19c5e5` | 社群 RP 指南（prompt engineering 研究彙整） |
| 外部測試分階段 | `b657509` | `--stop-at`（NIGHT_RESULT/DAY_RESULT/GAME_OVER）+ 各階段獨立 timeout |
| 存檔/恢復機制 | `1867954` | `GameEngine.saveState()`/`restoreState()` + 測試腳本 `--save-state`/`--resume` |
| 移除 DAY_VOTING 60s timeout | `4602ec3` | spec：不限時，等全員投票 |
| harness 全階段不限時 | `742b9e4` | NIGHT=0, DAY=0（無 timeout 截斷） |
| harness 10 分鐘進度輸出 | `50218d0` | ready/votes/wolfRound 定期 log |
| harness 實時討論 log | `506ddd8` | `/tmp/day-discussion.log`（MESSAGE + READY） |
| fix: log 抓 MESSAGE | `d25ee5d` | sendDayMessage broadcast type 是 MESSAGE 非 DAY_MESSAGE |
| 白天策略先行+全局memory+滾動調整 | `d6b8e99` | `generateDayStrategies` + `appendMemory`（4000 字上限）+ `strategy_update` |
| 報告 phase 修正 | `e990f68` | converged 時報告顯示 STOP_AT（非 current phase） |
| Wolf prompt Two-Level Split | `4b00f5e` | Level 1 策略核心 + Level 2 角色；Dead Players；禁止/正確做法 |
| 防幻覺 prompt | `4b00f5e` | 「此頻道只有狼。不要引用沒在白板上出現的發言。」 |
| Wolf loop 收斂修正 | `4814bb5` | 不在 loop 中呼叫 handleToggleWolfReady（防 premature VOTING） |
| 防重複 prompt | `2685b8a` | 「不要重複你已講過的內容。沒有新東西就 vote 確認。」 |
| 防假設性回應+防前綴 | `7338ff6` | 禁止「如果有人問我就說...」；禁止 P13 前綴 |
| wait 語意修正 | `9bd607c` | 已表態的狼用 vote 確認；wait 只給還沒表態的狼 |
| 白天 5 分鐘 timeout | `e9e6a24` | 測試方便；超時→存檔+報告，可 --resume 接續 |
| 防 Among Us prompt | `09c9887` | 「純口頭推論遊戲。沒有路徑、軌跡、不在場證明、操作記錄。」 |
| 報告完整合併 | `e3d6787` | events 存 .events.json；resume 時載入前段 events 一起出報告 |
| x-override-priority | `17df6c4` | 併發 LLM 呼叫加 priority header（100+i）；SGLang 依 priority 排程 |

## 待做

1. **[HIGH] 白天討論外部測試（進行中）** → 5 分鐘分段跑，觀察 AI 品質
   - `/tmp/day1.json` 已存（第一段完成）
   - 接續：`--resume /tmp/day1.json --stop-at DAY_RESULT --save-state /tmp/day2.json`
   - 觀察：發言內容是否自然、狼是否暴露、收斂是否正常
2. **[MED] Step 5：AI 接 production server** → `server.ts` 實例化 `AiController`
3. **[LOW] 前端（ubuntu-web/）** → 等外部測試跑通完整一局再開

## 測試腳本用法

```bash
# 跑夜晚 + 存檔（~3 min）
node scripts/external-test-stage2.mjs --stop-at NIGHT_RESULT --save-state /tmp/night1.json

# 從存檔接白天（5 分鐘一段）
node scripts/external-test-stage2.mjs --resume /tmp/night1.json --stop-at DAY_RESULT --save-state /tmp/day1.json

# 接續下一段（報告自動合併前段 events）
node scripts/external-test-stage2.mjs --resume /tmp/day1.json --stop-at DAY_RESULT --save-state /tmp/day2.json

# 跑完整局（多天）
node scripts/external-test-stage2.mjs --stop-at GAME_OVER
```

各階段 timeout：NIGHT=0（不限時）、DAY=300s（5 分鐘，測試方便）。
存檔含：game state + events（`.events.json`）。resume 時自動載入前段 events，報告是完整的。

## 關鍵檔案

| 檔案 | 說明 |
|---|---|
| `src/lobby-server/game.ts` | GameEngine（~920 行）；toggle 制、sendDayMessage、resolveVotes 平票、saveState/restoreState |
| `src/lobby-server/ai-controller.ts` | AI 控制器（~1250 行）；night + day 完整邏輯；wolf Two-Level Split prompt |
| `src/lobby-server/types.ts` | 協議類型（TOGGLE_VOTE_READY、DAY_READY_STATUS 等） |
| `src/lobby-server/server.ts` | Production server；AiController 尚未接入（Step 5） |
| `scripts/external-test-stage2.mjs` | 外部測試腳本；分階段 + 存檔/恢復 + events 合併報告 |
| `docs/ubuntu-spec.md` | 權威規格（WS 協定、房間生命週期、phase 狀態機、里程碑） |
| `docs/ai-rp-prompt-research.md` | 社群 RP 指南（prompt engineering 研究彙整） |

## 部署流程

```bash
# 本機
cd C:\Users\user\Desktop\FrankTests\Other\人狼遊戲
npm run build
git add -A && git commit -m "..." && git push

# Server
ssh -F "C:\Users\user\Desktop\FrankTests\.ssh\config" ssh.morowin.win \
  "cd /opt/wolfgame && git pull && sudo systemctl restart wolfgame"

# 跑外部測試（server 上，分階段）
ssh -F "C:\Users\user\Desktop\FrankTests\.ssh\config" ssh.morowin.win \
  "cd /opt/wolfgame && SGLANG_API_KEY=ec1f8d6ef95e81135aac5b9ac19b121836cc00e9d6511472c135c5d5bfb0c89e node scripts/external-test-stage2.mjs --stop-at NIGHT_RESULT --save-state /tmp/night1.json"

ssh -F "C:\Users\user\Desktop\FrankTests\.ssh\config" ssh.morowin.win \
  "cd /opt/wolfgame && SGLANG_API_KEY=ec1f8d6ef95e81135aac5b9ac19b121836cc00e9d6511472c135c5d5bfb0c89e node scripts/external-test-stage2.mjs --resume /tmp/night1.json --stop-at DAY_RESULT --save-state /tmp/day1.json"

# 取回報告
scp -F "C:\Users\user\Desktop\FrankTests\.ssh\config" \
  ssh.morowin.win:/opt/wolfgame/ai-trace-stage2-day.md \
  "C:\Users\user\Desktop\FrankTests\Temp\ai-trace-stage2-day.md"
```

## 使用者核心規則（調人設時必守）

- 不准限時；AI 與真人完全同權
- 人設要自然性格描述 + 說話範例，不要機械式語癖
- 禁止 AI 口癖：前言、對立修正句型、抽象策略語言、模糊未來計畫、被動語態文件感
- 角色語氣符合當下社交情境，不製造不存在的衝突
- 不要提「沒有發言紀錄」「沒人發言」「沒有白天討論」
- 用名字稱呼隊友，不用「我跟你」
- 同意時用目標名字，不要「就他」
- 所有會議統一格式（出稿→judge→回應→收斂 loop）
- CD 自動判斷：無真人→0（立即）；有真人→60s
- 120s timer 已完全移除，不保留 fallback
- 100 則安全上限只限測試（正式版預設 0=停用）
- **不要動 engine，不允許重生成**——AI 必須被 prompt 訓練到每次都能直接說出對的話
- **有人想發言就不是 ready**（出新草稿 = 撤回 ready）
- **純口頭推論遊戲**——沒有路徑、軌跡、不在場證明、操作記錄（那是 Among Us）
- 5 分鐘白天 timeout 只是測試方便，不是正式需求
