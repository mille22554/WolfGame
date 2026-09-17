# 進度追蹤（ubuntu 分支）

> 更新：2026-09-17
> 用途：新 session 接手時讀此文件即可無縫繼續。

## 目前狀態

**卡在哪：** 白天（DAY_DISCUSSION）尚未驗證。Night 已通過（`--stop-at NIGHT_RESULT` ✅）。下一步是用 `--resume` 從存檔接白天，確認 AI 討論/投票/toggle 正常。

**下一步（依序）：**
1. Server 上跑 `--stop-at NIGHT_RESULT --save-state /tmp/night1.json`（~3 min）
2. Server 上跑 `--resume /tmp/night1.json --stop-at DAY_RESULT`（≤10 min，跳過 night）
3. 取回報告確認：AI 有發言（MESSAGE）、有 toggle（DAY_READY_STATUS）、有投票（VOTE_RESULT）
4. 若 day 有 bug → 修 → 重跑 step 2（不用重跑 night）
5. 全部通過 → Step 5（AI 接 production server）

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

## 待做

1. **[HIGH] 外部測試驗證白天** → `--resume /tmp/night1.json --stop-at DAY_RESULT`
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

各階段 timeout：NIGHT=300s、DAY=600s。超時會明確報錯是哪個階段。

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
  "cd /opt/wolfgame && SGLANG_API_KEY=ec1f8d6ef95e81135aac5b9ac19b121836cc00e9d6511472c135c5d5bfb0c89e node scripts/external-test-stage2.mjs --stop-at NIGHT_RESULT --save-state /tmp/night1.json"

ssh -F "C:\Users\user\Desktop\FrankTests\.ssh\config" ssh.morowin.win \
  "cd /opt/wolfgame && SGLANG_API_KEY=ec1f8d6ef95e81135aac5b9ac19b121836cc00e9d6511472c135c5d5bfb0c89e node scripts/external-test-stage2.mjs --resume /tmp/night1.json --stop-at DAY_RESULT"

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
