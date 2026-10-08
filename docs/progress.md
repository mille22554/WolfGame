# 進度追蹤（ubuntu 分支）

> 更新：2026-10-08
> 用途：新 session 接手時讀此文件即可無縫繼續。歷史明細按天存於 `docs/history/YYYY-MM-DD.md`，本檔只留現況與操作指南。

## 目前狀態

**目前暫停點：** spec 精度收尾完成；@oracle 獨立 review 發現記入待做 6–12，現逐條分析中（第 1 條已定案改完：統一熔斷）。source 落地等分析完再動。正式 service 未重啟。

## 歷史索引（明細見各檔）

| 日期檔 | 內容 |
|---|---|
| `docs/history/2026-09-21.md` | 狼會議 prompt 最終修訂 |
| `docs/history/2026-09-22.md` | 狼會議 prompt 精簡版＋四項修正、本 session 修的東西、server 測試方式 |
| `docs/history/2026-09-24.md` | 共有者 V8、私頻稱呼、EXPAND＋要點化、V-Day 實作、runner、medium 實測、Phase 1 |
| `docs/history/2026-09-29.md` | Phase 2/3、medium 實測、attempt-01、raw 白天模擬、五項修正、OpenCC、盲評、session 交接 |
| `docs/history/2026-10-01.md` | 夜晚共有者精修、第二輪直呼作廢紀錄 |
| `docs/history/2026-10-07.md` | 夜間會議規格改寫（統一 loop＋模板重寫） |
| `docs/history/2026-10-08.md` | spec 統一全檢＋二～十三次確認、夜白逐項同形、fallback 精度統一、用詞拾遺全清、對話保留不限上限、SSH 雙裝置、history 建立 |

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

1. **[HIGH] source 落地** → 先修 `ai-controller.ts` 3 個 TS 錯（`wolfReadyMap`／`masonReadyMap` 殘留引用、被刪的 `judgeScoreIndex`），再收尾夜間 loop 替換＋落地測試＋拆 `sendDayMessage` 50 則截斷（對話不限上限；夜間 board 一併驗證無截斷）
2. **[HIGH] 夜間落地測試** → mock LLM 覆蓋 judge／單人免 judge／validator 重試／wait 重問／收斂接投票／記憶寫入
3. **[MED] @oracle 審查夜間流程** → 落地後再 commit＋push
4. **[MED] 白天 prompt 直呼驗證** → 模板待補；白天四步 reasoning effort 逐次指定一併定；另加形狀對照實驗（原形 vs 全塞 system＋策略扮 assistant，看收斂品質說話，不直接搬）
13. **[HIGH] 記憶日記體直呼驗證（T1 通過；切三修重測中）** → 第一人稱＋禁機制詞七詞；T1 轉寫自然零殘留（跟着一處 OpenCC 兜底）、續用不復活鈴且跟上佐雪定案；切錯譯根因定位（發言思考鏈原句：刀疑黑話→殺嫌直接→拿策略切當安全牌），模板已進三修（策略一律繁體中文＋切語義事實＋密談場合＋私頻掃成密談，動詞指定已 ban 不寫），code 端 night-prompts.ts 缺檔待驗過重建；策略重出驗證中；口徑條已驗有效、隨 revert 退掉待重加；T2 prefill 對照、T3 白天投票雙軌待跑；過了才落 spec＋source
5. **[LOW] 前端（ubuntu-web/）** → 等外部測試跑通完整一局再開
6. **[HIGH] oracle-1 安全上限統一熔斷（已改）** → 定案：觸發即凍結受理＋輸出熔斷報告＋進程立即停止（不自動收斂；共有者強制 toggle 已刪）；source 熔斷退出路徑歸 Phase 1
7. **[HIGH] oracle-2 System 段三方打架（已改）** → 定案：§13.5 改寫成直呼落地版（system＝兩段，約束散見模板），code／模板不動；另見 system/user 設計討論（下）
8. **[MED] oracle-3 狼刀全文 vs 最近訊息（未決）** → L317 全文 vs L534／code（`recentMessages` 上限 30 則）；修法＝L317 改最近 30 則
9. **[MED] oracle-4 B 裝置 SSH 續行（未決）** → `\` 在 PS 5.1 靜默失效（pull＋restart 沒跑還不報錯）；修法＝B 塊收單行，A 塊保留
10. **[MED] oracle-5 白天掛 source 現況不實（未決）** → code 白天仍是舊 stage machine；二選一：白天各處補【目標／待實作】先誠實標記，或等 code 追平
11. **[MED] oracle-6 judge 全 0 分邊界（未決）** → spec 有、模板無、code 認 best；定案三方對齊（code 歸 Phase 1）
12. **[LOW] oracle 小項（未決）** → L334 陣營二字、L649 混合局括號、L723「只有」→摘錄、模板 L247 半句；code 漂移三處（勝利行狂人／合併標題／最佳篇號）＋verbatim 缺口歸 Phase 1

## 設計討論備忘（system／user，2026-10-08）

- 通用設計：system＝立法（身分／紅線／格式，位階高、終端使用者不可見），user＝行政（當次材料＋任務）；judge 無 system（裁判只要材料）。
- 本專案現狀是對的：身分住 system，任務住 user；靜態指令（規則／任務／提點／回覆要求）故意跟動態資料（進度／記憶）放同一段，保閱讀流與順序效應。
- 否決案：靜態全塞 system＋策略扮 assistant——三坑：進度進 system 殺 prefix cache（每輪全量重算）；assistant 塞入選策略＝偽造歷史且常認領別人的稿（persona 污染＋斷頭假多輪）；換形狀＝重驗證。列入白天直呼對照實驗，不直接搬。
- token 成本：AI 自架，不計；不動 prompt 的理由是保已驗證版本，不是省錢。

## 測試腳本用法

```bash
# 重跑夜晚，產生可 resume 的 v2 envelope
node scripts/external-test-stage2.mjs --stop-at NIGHT_RESULT --save-state /tmp/night-v2-medium.json

# 從 v2 night envelope 只跑到第一則公頻 MESSAGE
node scripts/external-test-stage2.mjs --resume /tmp/night-v2-medium.json --stop-after-first-message --save-state /tmp/day-v2-medium-first.json --report /tmp/ai-trace-stage2-day-v2-medium-first.md

# 之後才從 day checkpoint 繼續完整白天
node scripts/external-test-stage2.mjs --resume /tmp/day-v2-medium-first.json --stop-at DAY_RESULT --save-state /tmp/day-v2-medium-full.json

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
| `scripts/run-external-test-safe.sh` | 安全 runner；金鑰不經 argv，支援新開局與 `--resume` |
| `docs/ubuntu-spec.md` | 權威規格（WS 協定、房間生命週期、phase 狀態機、里程碑） |
| `docs/strategy-prompt-variables.md` | 夜間 prompt 逐字模板＋變數表（夜白同一套 loop；白天逐字實例待直呼補） |
| `docs/ai-rp-prompt-research.md` | 社群 RP 指南（prompt engineering 研究彙整） |

## 部署流程

```bash
# 本機：build 後明確暫存本次檔案，不使用 git add -A（避免帶入 runtime／line-ending 雜訊）
cd C:\Users\user\Desktop\FrankTests\Other\人狼遊戲
npm run build
git add \
  src/lobby-server/ai-controller.ts \
  dist/lobby-server/ai-controller.d.ts \
  dist/lobby-server/ai-controller.d.ts.map \
  dist/lobby-server/ai-controller.js \
  dist/lobby-server/ai-controller.js.map \
  scripts/run-external-test-safe.sh \
  docs/progress.md
git diff --cached --name-only
git commit -m "..."
git push

# Server：正式部署才重啟服務（SSH config 視裝置選用：A 裝置用 `~/.ssh/config`，下例為 B 裝置／目前環境；不確定時先問）
ssh -F "C:\Users\user\Desktop\FrankTests\.ssh\config" ssh.morowin.win \
  "cd /opt/wolfgame && git pull && sudo systemctl restart wolfgame"

# Server：只跑外部測試時，僅 pull，不重啟正式服務
ssh -F "C:\Users\user\Desktop\FrankTests\.ssh\config" ssh.morowin.win \
  "cd /opt/wolfgame && git pull"

ssh -F "C:\Users\user\Desktop\FrankTests\.ssh\config" ssh.morowin.win \
  "sudo sh /opt/wolfgame/scripts/run-external-test-safe.sh --stop-at NIGHT_RESULT --save-state /tmp/night1.json"

ssh -F "C:\Users\user\Desktop\FrankTests\.ssh\config" ssh.morowin.win \
  "sudo sh /opt/wolfgame/scripts/run-external-test-safe.sh --resume /tmp/night1.json --stop-at DAY_RESULT --save-state /tmp/day1.json"

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
- 所有會議統一格式（策略 → validator → judge → 記憶合併 → 發言 → 收斂 loop）
- CD 自動判斷：無真人→0（立即）；有真人→60s
- 120s timer 已完全移除，不保留 fallback
- 100 則安全上限只限測試（正式版預設 0=停用）
- **不要動 engine，不允許重生成**——AI 必須被 prompt 訓練到每次都能直接說出對的話
- **有人想發言就不是 ready**（出新策略 = 撤回 ready）
- **純口頭推論遊戲**——沒有路徑、軌跡、不在場證明、操作記錄（那是 Among Us）
- 5 分鐘白天 timeout 只是測試方便，不是正式需求
