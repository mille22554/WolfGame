# 進度追蹤（ubuntu 分支）

> 更新：2026-09-17
> 用途：新 session 接手時讀此文件即可無縫繼續。

## 目前狀態

**卡在哪：** 外部測試（`scripts/external-test-stage2.mjs`）在 server 上跑 8 分鐘以上無任何輸出（只有第一行「遊戲已開始」）。process 活著、SGLang 回應正常（Unauthorized 是沒帶 key），但 LLM 呼叫似乎沒完成或沒 timeout。需要排查。

**可能原因：**
1. SGLang 負載過高（其他使用者/殘留 process 佔用）
2. LLM timeout 設定（60s）在 nohup 環境下行為異常
3. 測試腳本 WS 連線到 game server 後，game 沒正確 start（room 沒建立？）
4. `llmWithRetry` 的 3 次重試 × 60s timeout = 最壞 180s/call，15 個 AI 就算 sequential 也要很久

**下一步（依序）：**
1. SSH 到 server 手動跑一個最小 LLM 呼叫確認 SGLang 正常：
   ```bash
   curl -s http://127.0.0.1:9090/v1/chat/completions \
     -H "Authorization: Bearer $SGLANG_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"qwen3.8-27b","messages":[{"role":"user","content":"說hi"}],"max_tokens":10}'
   ```
2. 確認 wolfgame service 的 room 有正確建立（看 server log：`journalctl -u wolfgame -n 50`）
3. 若 LLM 正常 → 在 server 上直接跑測試但**不加 nohup**（用 foreground + 大 timeout），觀察即時輸出
4. 若確認是 timeout 問題 → 把 `LLM_TIMEOUT_MS` 調高（如 120000）或減少重試次數
5. 測試通過後 → Step 5（AI 接 production server）

## 已完成（本 session 內）

| 項目 | Commit | 說明 |
|---|---|---|
| Night 流程完整實作 | 多個（見 git log） | mason/wolf/seer 會議 loop + 結算 + NIGHT_RESULT |
| Spec 更新 | `bff5cc5` | 白天項目標注「目標態/待實作」；CD 自動判斷 |
| 100 則上限改可選 | `e95f5d6` | `wolfMessageCap`/`messageCap` 預設 0=停用 |
| Step 1+2：toggle 制 + 平票 | `48b8127` | 移除 120s timer；`TOGGLE_VOTE_READY`/`DAY_READY_STATUS`；平票→無人出局 |
| Step 3+4：AI 白天討論+投票 | `c397b49` | `runDayDiscussion()`/`runDayVoting()`/prompt builders |
| Fix：一次一個 AI 發言 | `c1f65ad` | `generateDayDrafts` 從 15 平行→隨機選 1 個 |
| docs/ai-rp-prompt-research.md | `c19c5e5` | 社群 RP 指南（prompt engineering 研究彙整） |

## 待做

1. **[HIGH] Debug 外部測試無輸出** → 排查 SGLang/WS/room 建立
2. **[HIGH] 外部測試驗證完整一天** → NIGHT→DAY_DISCUSSION→DAY_VOTING→DAY_RESULT
3. **[MED] Step 5：AI 接 production server** → `server.ts` 實例化 `AiController`，room 有 AI 玩家時啟動
4. **[LOW] 前端（ubuntu-web/）** → 等外部測試跑通完整一局再開

## 關鍵檔案

| 檔案 | 說明 |
|---|---|
| `src/lobby-server/game.ts` | GameEngine（~834 行）；toggle 制、sendDayMessage、resolveVotes 平票 |
| `src/lobby-server/ai-controller.ts` | AI 控制器（~1095 行）；night + day 完整邏輯 |
| `src/lobby-server/types.ts` | 協議類型（TOGGLE_VOTE_READY、DAY_READY_STATUS 等） |
| `src/lobby-server/server.ts` | Production server；AiController 尚未接入（Step 5） |
| `scripts/external-test-stage2.mjs` | 外部測試腳本；wait 到 DAY_RESULT；messageCap=100 |
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

# 跑外部測試（server 上）
ssh -F "C:\Users\user\Desktop\FrankTests\.ssh\config" ssh.morowin.win \
  "cd /opt/wolfgame && SGLANG_API_KEY=<REDACTED> node scripts/external-test-stage2.mjs"

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
