# 進度追蹤（ubuntu 分支）

> 更新：2026-09-17
> 用途：新 session 接手時讀此文件即可無縫繼續。

## 目前狀態

**卡在哪：** 白天（DAY_DISCUSSION）外部測試進行中。已確認：
- ✅ MESSAGE 有出現（裕子、良子有發言）
- ✅ ready 有增有減（toggle ON/OFF 正常，非 sticky）
- ⏳ 尚未完成（14 人全 ready → DAY_VOTING → 投票 → DAY_RESULT）

**已修（本 session）：**
- 移除 DAY_VOTING 60s timeout（spec：不限時，等全員投票）
- 移除 harness NIGHT 300s timeout（全階段不限時）
- 移除 spec 中 2 處 token 上限（≤100 token）
- 修正 spec DAY_DISCUSSION 描述（120s 定時器→不限時 toggle）
- harness 每 10 分鐘輸出進度（ready/votes/wolfRound）
- harness 實時討論 log（`/tmp/day-discussion.log`，tail -f 可看）
- fix：discussion log 抓 `MESSAGE`（非 `DAY_MESSAGE`）

**下一步（依序）：**
1. Server 上重跑 `--resume /tmp/night1.json --stop-at DAY_RESULT`（不限時，可能 30-60 min）
2. 用 `tail -f /tmp/day-discussion.log` 觀察討論過程
3. 確認：AI 有發言（MESSAGE）、有 toggle 增減（DAY_READY_STATUS）、有投票（VOTE_RESULT）
4. 若 day 有 bug → 修 → 重跑（不用重跑 night）
5. 全部通過 → Step 5（AI 接 production server）

**Server 上跑測試的正確方式：**
```bash
# 先 kill 舊 process
ssh ssh.morowin.win "pkill -f external-test-stage2"
# 用 nohup + disown 跑（SSH 斷線不會 kill）
ssh ssh.morowin.win "bash -c 'cd /opt/wolfgame && SGLANG_API_KEY=<REDACTED> node scripts/external-test-stage2.mjs --resume /tmp/night1.json --stop-at DAY_RESULT --report /tmp/day-test-report.md > /tmp/day-test.log 2>&1 & disown; echo ok'"
# 觀察
ssh ssh.morowin.win "tail -20 /tmp/day-discussion.log"
ssh ssh.morowin.win "cat /tmp/day-test.log"
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
| NIGHT timeout 調高 | `4dbf085` | 120s→300s（LLM 慢時 120s 不夠） |
| 存檔/恢復機制 | `1867954` | `GameEngine.saveState()`/`restoreState()` + 測試腳本 `--save-state`/`--resume` |
| NIGHT 驗證通過 | — | `--stop-at NIGHT_RESULT` ✅（狼刀健太，3 則白板，round 1） |
| 移除 DAY_VOTING 60s timeout | `4602ec3` | spec：不限時，等全員投票（handleVote 內檢查） |
| harness 全階段不限時 | `742b9e4` | NIGHT=0, DAY=0（無 timeout 截斷） |
| spec 清理 token 上限 | `4602ec3` | 移除 §13.4/§13.6 的「≤100 token」 |
| harness 10 分鐘進度輸出 | `50218d0` | ready/votes/wolfRound 定期 log |
| harness 實時討論 log | `506ddd8` | `/tmp/day-discussion.log`（MESSAGE + READY） |
| fix: log 抓 MESSAGE | `d25ee5d` | sendDayMessage broadcast type 是 MESSAGE 非 DAY_MESSAGE |

## 待做

1. **[HIGH] 外部測試驗證白天（進行中）** → `--resume /tmp/night1.json --stop-at DAY_RESULT`（不限時）
   - 已確認 MESSAGE 有出現、ready 有增有減
   - 尚未完成：等 14 人全 ready → 投票 → DAY_RESULT
2. **[MED] Step 5：AI 接 production server** → `server.ts` 實例化 `AiController`
3. **[LOW] 前端（ubuntu-web/）** → 等外部測試跑通完整一局再開

## 測試腳本用法

```bash
# 跑夜晚 + 存檔（~3 min）
node scripts/external-test-stage2.mjs --stop-at NIGHT_RESULT --save-state /tmp/night1.json

# 從存檔接白天（跳過 night，≤10 min）
node scripts/external-test-stage2.mjs --resume /tmp/night1.json --stop-at DAY_RESULT

# 跑完整天（night + day，~13 min）
node scripts/external-test-stage2.mjs --stop-at DAY_RESULT

# 跑完整局（多天）
node scripts/external-test-stage2.mjs --stop-at GAME_OVER
```

各階段 timeout：NIGHT=0（不限時）、DAY=0（不限時）。無 timeout 截斷，等到收斂或 process 被 kill。

## 關鍵檔案

| 檔案 | 說明 |
|---|---|
| `src/lobby-server/game.ts` | GameEngine（~880 行）；toggle 制、sendDayMessage、resolveVotes 平票、saveState/restoreState |
| `src/lobby-server/ai-controller.ts` | AI 控制器（~1095 行）；night + day 完整邏輯 |
| `src/lobby-server/types.ts` | 協議類型（TOGGLE_VOTE_READY、DAY_READY_STATUS 等） |
| `src/lobby-server/server.ts` | Production server；AiController 尚未接入（Step 5） |
| `scripts/external-test-stage2.mjs` | 外部測試腳本；分階段 + 存檔/恢復 |
| `docs/ubuntu-spec.md` | 權威規格（WS 協定、房間生命週期、phase 狀態機、里程碑） |
| `docs/ai-rp-prompt-research.md` | 社群 RP 指南（調人設時參考） |

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
  "cd /opt/wolfgame && SGLANG_API_KEY=<REDACTED> node scripts/external-test-stage2.mjs --stop-at NIGHT_RESULT --save-state /tmp/night1.json"

ssh -F "C:\Users\user\Desktop\FrankTests\.ssh\config" ssh.morowin.win \
  "cd /opt/wolfgame && SGLANG_API_KEY=<REDACTED> node scripts/external-test-stage2.mjs --resume /tmp/night1.json --stop-at DAY_RESULT"

# 取回報告
scp -F "C:\Users\user\Desktop\FrankTests\.ssh\config" \
  ssh.morowin.win:/opt/wolfgame/ai-trace-stage2-output.md \
  "C:\Users\user\Desktop\FrankTests\Temp\ai-trace-stage2-output.md"
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
