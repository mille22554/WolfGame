# 進度追蹤（ubuntu 分支）

> 更新：2026-10-02
> 用途：新 session 接手時讀此文件即可無縫繼續。

## 目前狀態

**目前暫停點：** judge 分工條改計畫內 CO 豁免。現版三套模板見 `docs/strategy-prompt-variables.md`。正式 service 未重啟。

- ✅ **共有者 prompt V8 落地**（2026-09-24，oracle 雙共有者第 1 夜流程驗證後落地）：三函數（`masonContext`／`buildMasonDraftPrompts`／`buildMasonResponsePrompts`）全面對齊狼版編排，只有身分差異；草稿定位改為「行動筆記非發言稿」
- ✅ **私頻稱呼修正**（2026-09-24，stage 1 實測發現＋oracle 驗證後落地）：2 人私頻用「你／名字＋你」，禁「他／她」與「你們」
- ✅ **私頻 EXPAND 機制＋草稿要點化**（2026-09-24，oracle 兩段式驗證後落地）：草稿＝行動筆記 → 引擎展開成角色語氣完整發言才進白板；狼與共有者兩側同步
- ✅ **白天 V-Day 實作＋本機驗證完成**（2026-09-24，第一段 server `medium` 測試已完成；公頻 judge／EXPAND 段待續跑）：新增全角色 `dayContext`；白天草稿／回應也走「行動筆記 → EXPAND → 公頻發言」；移除 3 處 `≤50字`
- ✅ **外部測試安全 runner 已落地**（2026-09-24，已用於本輪 server 測試；未上線）：`scripts/run-external-test-safe.sh` 讓金鑰只進 process environment，不進 node／curl argv；用 `setpriv` 降權到 `morowin`；支援新開局與 `--resume`
- ✅ **`docs/ubuntu-spec.md` source／harness 現況對齊**（2026-09-24）：全文改用【已上線】／【source 現況】／【production 未接線】／【目標／待實作】標記；同步 V-Day、實際 loops、WS 事件狀態、部署與 systemd 缺口；明確區分外部 harness 可跑與 production 尚未接 `AiController`
- ✅ **Qwen `medium` variant 第一段 server 測試**（2026-09-24，5 分鐘）：新增 `LLM_REASONING_EFFORT` per-request 映射；28/28 個 SGLang request 都帶 `reasoning_effort=medium`；完成 14 個策略與 13 個白天草稿，1 個草稿在 SIGINT 時中止，尚未進入 judge／EXPAND
- ✅ **Checkpoint Phase 1：GameEngine day restore**（2026-09-24，Oracle Gate 1 attempt 2 GO）：保留 dayReady／dayMessages、day/seq/id、copy-based getter、idempotent `setDayReady`／`reconcileDayReady`、wolfTargetId round-trip；focused build + 43/43 tests 通過。AI private snapshot／harness envelope 尚待 Phase 2/3
- ✅ **Checkpoint Phase 2/3 + 首句 bounded 控制（已 push）**（2026-09-29，commits `cfc4659`／`d36f032`／`a0e8fe5`）：AI day snapshot、單一 v2 envelope、restore barrier、SIGINT settle、atomic save、`--stop-after-first-message`；本機 harness 17/17＋lobby focused 50/50 通過
- ✅ **本輪 medium server 實測**（2026-09-29）：night 重跑完成並產生 `/tmp/night-v2-medium.json`（schemaVersion=2、`game.phase=DAY_DISCUSSION`、`ai.stage=strategies`）；再 resume 到第一則公頻 `MESSAGE` 後停止，沒有 day responses／第二輪 draft
- ✅ **夜晚重跑 attempt-01 已通過**（2026-09-29，`LLM_REASONING_EFFORT=medium`）：`NIGHT_RESULT` 只有村民鈴死亡；狼（健太、美咲、翔太）與狂人（小晴）皆存活。v2 envelope 驗證有效：`schemaVersion=2`、`game.phase=DAY_DISCUSSION`、`ai.stage=strategies`、21 events／20 aiLog。server 存檔：`/tmp/night-v2-medium-attempt-01.json`；本機 night 報告已覆蓋 `C:\Users\user\Desktop\FrankTests\Temp\ai-trace-stage2-night.md`
- ✅ **raw SGLang 白天模擬完成**（2026-09-29，未接回 engine）：用 attempt-01 的實際 `ChatMessage[]` 檔案直呼 SGLang，14 strategy、14 draft、judge、expand 全部 HTTP 200；最多 3 條並行。judge `best=12`，選中裕子。
- ✅ **原始 EXPAND 結果**（2026-09-29）：實際輸出含簡體字；曾以 OpenCC `cn→tw` 轉換後展示，但轉換只改字形，沒有修正語意，也未落地到程式。
- ✅ **臨時 EXPAND 規則驗證**（2026-09-29，未修改 source）：在暫存 prompt 以正式規則口吻加入「私有計畫不可寫成公頻既成事實」；重跑後不再假設千尋問題已發生，但仍出現「一輪／一圈」。
- ⏳ **目前等待使用者指出問題**（2026-09-29）：不要把任何臨時 prompt／OpenCC 轉換結果當成已落地修正。
- ✅ **白天 prompt 五項修正落地**（2026-09-29，raw SGLang 直呼多輪驗證後落地，已 commit，`src`＋`dist`）：
  1. 新增 `discussionMechanism()` helper，注入三個 context（`wolfContext`／`masonContext`／`dayContext`）——說明連續對話制（無輪次、無順序、挑選隨機），禁用輪次／回合／第幾段／發言位置等結構詞。
  2. 修正兩處 prompt 自相矛盾：`buildDayDraftPrompts` 的「沒人發言」禁令改為「不要在你的發言裡說」；「白板狀況」改為「討論狀況」。
  3. 新增 `notePrivacyRules()` helper，注入白天 draft＋response prompt（狼／共有者暫不同步）：筆記獨立成立、未發生不寫成已發生、不寫成自己不發言、speech 與 strategy_update 一致；另加骨幹要求（實質判斷、時序正確、同人只點一次）。
  4. `buildExpandPrompts()` 拆三會議共用段＋白天專屬段：私有計畫轉當前意圖、公頻不洩漏私頻、輪次詞只能是建議、用玩家日常話（正面範本）、受詞明確、一句一次、刪裝飾詞、刪空威脅、段落空行；新增 `boardText` 參數，`expandSpeech()` 按會議傳入白板供時序推理。
  5. `buildJudgePrompts()` 加 `meeting` 參數＋評分標準（獨立成立、言行一致、結構詞、有新東西、可核對、實際動作、時序、格式vs遊戲）；draft／response 輸出新增 `importance`／`urgency`／`impact` 自評欄位，judge 顯示並核對（灌水扣分、低分過濾）。
  - 驗證：`npm run build` 通過；`npm test` 186 pass／0 fail；lobby 27／27；checkpoint 17／17。
  - 未落地：OpenCC 繁體強轉（需加 npm 依賴，待決策）、狼／共有者 draft prompt 同步、段落數驗證、同分選擇規則。
- ✅ **OpenCC＋狼／共有者同步落地**（2026-09-29，已 commit，`src`＋`dist`＋依賴）：
  - 新增 `opencc-js` 依賴；`expandSpeech()` 發布邊界 `cn→tw` 強轉（三會議共用，含 fallback 草稿原文）。Codepoint 驗證通過（剛→剛、對／講／尋／實／們正確；沉默的沉、兩岸同形字正確保留）。
  - `notePrivacyRules()` 同步注入狼 draft／response、共有者 draft／response 四個 prompt。
  - 使用者決策：段落數驗證＝不管；同分選擇＝維持現狀（LLM 決定）。
  - 驗證：`npm run build` 通過；`npm test` 186 pass／0 fail；lobby＋checkpoint 44／44。
- ⏳ **夜晚共有者精修（臨時驗證，未落地 source）**（2026-10-01，白板清空後轉向）：mason draft→judge→expand 跑 m1–m4；後改單段直出（mason-full，省一次 SGLang）；策略步獨立（mason-strat s1–s5，只想策略不跑 judge）。
  - 手冊對齊：`docs/ai-rp-prompt-research.md`（identity→rules→state→phase→output；800 字內；禁令換合法清單＋正反範例；人設瘦身）。
  - 已驗證有效：遊戲機制陽光知識（選查理由絕跡）；【0 身分錨定】＋知識還原（harness 曾漏灌 knowledge致全員失憶，已修）；OpenCC 隻→只白名單；格式外移 validator（`Temp/opencode/validate-mason.mjs`：他／簡體(OpenCC比對)／黑話／假機制題／口量詞，report-only）。
  - 已證實無效：urgency 封頂（prompt 壓不住，落地需程式硬夾）；effort xhigh（字數漲品質不漲）；temp 0.7（無差異，已回 1.0）；thinking steering／prefill（零引用）。
  - 待決：mason 第一句未定稿；source 落地時機（V-Day 白天＋mason 夜晚＋character 人設瘦身＋judge sharedCriteria 結構詞舊標準已移除待 commit）。
  - 2026-10-02 更新：策略步定稿路徑重寫——身分＋行事風格（改用 agents.md「性格與說話方式」，無策略指導）＋遊戲規則（補齊 7 職說明＋勝負＋關鍵規則）＋進度＋任務自由體＋戰術提點（6 條事實提醒，不指導）＋回覆內容要求（800 字內、明日目標／分工／狼兩反應、末行 ready/speak/wait）。已驗證：戰術提點拔掉「話多＝狼」；回覆內容要求壓 1832→940 字且品質不掉；靈能身分→陣營修正；平票＝無人出局＝靈能無資料提醒後矛盾句消失。mason-strat-judge（策略版 6 條判詞＋規則/進度）已建，拔掉 buildJudgePrompts sharedCriteria 結構詞舊標準後首跑 千尋 8／裕子 9（`ai-controller.ts` line 930 已移除，build 通過，未 commit）。
- ⏳ **第二輪直呼臨時規則（已作廢，白板清空；僅留紀錄）**（2026-09-29，美咲開局）：
  - Judge＋草稿：不要重複白板論點；宣告不算內容；純程序扣分；質疑認同觀察同等評分；重要性自評過濾；要求本身不合理扣分；預設身份扣分；不腦補局勢；白話描述候選。
  - Expand：白板時序推理；口語原則＋例示（持續擴充）；受詞明確；逐點對應＋忠實三條（不改時態、不加規範、不斷尾）；開門見山＋鋪陳已搬回草稿層；空威脅刪除；段落空行。
  - 草稿：開門見山＋鋪陳全刪；觀察帶結論；白話（學術／策略／引擎詞禁令）；引用核對出處；條件句禁令；不合理要求禁令；身份預設禁令。
  - 已驗證有效（當時）：白板重複過濾（真一 8→2）、腦補消除、自評過濾（葵／佐雪低分）。
  - 已作廢（2026-10-01）：白板清空，轉夜晚共有者精修；source 落地待新一輪驗收後統一決策。

## 本 session 交接（2026-09-29）

- **已推送程式基線**：`e2e3770`（Phase 1 GameEngine restore）、`cfc4659`（Phase 2 AI day snapshot）、`d36f032`（v2 envelope／resume harness）、`a0e8fe5`（`--stop-after-first-message`）。`main` 未動。
- **本輪 server 實測**：attempt-01 通過；只有 villager 鈴死亡，狼與狂人皆存活。server 存檔：`/tmp/night-v2-medium-attempt-01.json`。
- **本輪白天驗證方式**：沒有 resume 實際遊戲 engine；改以 raw SGLang runner 直接送實際 builder 產生的 `ChatMessage[]`，最多 3 條並行。這是 prompt／模型行為驗證，不是 game state 接續。
- **已驗證結果**：14 strategy、14 draft、judge、expand 全部 HTTP 200；judge 選中裕子。原始 EXPAND 有簡體字；OpenCC 轉換只在展示層做過，未落地。
- **臨時 EXPAND 測試**：加入正式口吻的「私有計畫不可寫成公頻既成事實」規則後，重跑不再把千尋的問題當成已發生；但仍出現「一輪／一圈」。暫存 prompt 沒有修改 source。
- **目前工作樹**：只剩 `dist/lobby-server/llm.d.ts` 的既有 line-ending 狀態，**不要暫存**。
- **下一 agent 的恢復順序**：
  1. 等使用者檢視本輪 raw 結果與指出問題。
  2. 不要重開 subagent 模擬；目前已改用 raw SGLang 才能保證 prompt 內容。
  3. 若使用者批准修 prompt，先決定只改 `buildExpandPrompts()` 還是同時處理「一輪／一圈」與繁體輸出 enforcement。
  4. 未經使用者明確批准，不把臨時 prompt 或 OpenCC 轉換落地到 source。

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
- ⏳ **白天 V-Day 行為驗證**：已完成 raw SGLang 14 strategy／14 draft／judge／expand 模擬；未接回遊戲 engine。EXPAND 語意問題與暫時修正驗證結果已記錄於上方，等待使用者裁示。

**私頻稱呼修正（2026-09-24，stage 1 實測發現、oracle 驗證通過後落地）：**

**問題**（stage 1 報告共有者 round 3 實測）：共有者發言讀起來不像 2 人對話，像向群體宣布計畫。
- 第三人稱指稱夥伴：「假跳共有者**由鈴**公開身分反，只有**他**被集中討論才反」
- 複數第二人稱：鈴的發言裡出現「**你們**別急着點名」——兩人頻道不該有「你們」
- 狼側指涉不明：「誰要軟我就反咬**他**」

**根因**：兩條規則夾擠。Level 2 寫「**用名字稱呼夥伴**」＋禁止條寫「**用代詞指代玩家**」，模型不能用「你」又不能用代詞，只能寫名字。問題出在**草稿階段**（stage 1 草稿原文就是第三人稱），EXPAND 只是忠實展開，所以修 EXPAND 無效。

**修正**（wolfContext / masonContext / 兩個 draft / 兩個 response，共 9 處）：
- 禁止條：`用代詞指代玩家`／裸 `用代詞` → `用「他／她」等第三人稱指稱玩家`（共有者版加註「含你的夥伴」）
- 正確條新增：`用「名字＋你」直接稱呼對方（「鈴，你怎麼看？」）；兩人私頻直接用「你」，不要用「你們」`
- Level 2：`用名字稱呼夥伴` → `用「名字＋你」或直接用「你」稱呼夥伴`
- 解除私頻錯置的封鎖：`「我跟你」「同意夥伴」類讓人看出同盟的呼應`（私頻只有兩人，無暴露風險；原規則從狼版照抄，錯置）
- 修正 prompt 自身的三人稱殘留：任務行 `（你們已決定時可省略）` → `（雙方已決定時可省略）`；response ⚠️ `此頻道只有你們兩個` → `只有你和夥伴兩個人`
- 四處 draft/response 的 ⚠️ `用名字，不用代詞` 一併同步改寫（**漏改會造成 system 與 user 指示互相矛盾**）

**oracle 驗證**：以 stage 1 真實情境（白板放夥伴先前發言）重跑，第三人稱指稱**完全消失**，改用「你」5 次；「你們」不再出現；對第三方玩家（健太/小晴/佐雪）仍正確保留名字。

**stage 1 另發現（本次未修）**：共有者會幻覺遊戲狀態（「小晴明天都不在了」——第 1 夜無人死過，無依據）。屬既有問題，與稱呼無關。

**stage 1 實測基線**（15 人全 AI 局，9m50s，到 NIGHT_RESULT）：EXPAND 12 次全部 attempt=1（零重試零 fallback）＝5 共有者＋7 狼；12 筆展開逐一比對**零幻覺**；簡體字僅 6 處且全在草稿（`两轮`/`抛话题`/`对`），EXPAND 輸出 0 處→夜晚對玩家零影響；白板文字全部為完整角色語氣發言。

**白天 V-Day＋安全測試 runner（2026-09-24，實作與本機驗證完成；尚未 oracle／server 實測）：**

- **使用者裁示**：白天比照私頻做 EXPAND；移除字數／句數約束；建立全角色 `dayContext`；公頻是否公開身分屬博弈內容，暫不加入隱私硬規則
- **`dayContext`**：Two-Level Split，全角色共用；目標不寫死「好人必勝」，避免狼收到矛盾指令；含公開證據邊界、禁止空轉、依據質疑／拉回人身上／表態投票、角色只影響決策
- **白天資料流**：`generateDayDrafts`／`dayRespond` 只產生行動筆記；judge 仍盲評草稿；選中後 `expandSpeech(..., 'day')`，再將同一份 `expanded` 用於 `sendDayMessage` 與其他 AI 的 `dayRespond`
- **fallback**：`llmWithRetry` 內建 3 次重試；全失敗用草稿原文，不阻塞白天討論
- **字數限制**：`DAY_STRATEGY`、`DAY_SPEECH`、`DAY_STANCE` 三處 `≤50字` 全移除，改用「判斷誰／依據／表態」結構描述
- **展開差異**：day 不沿用私頻的 `2-4 句`與「給隊友提醒」；wolf/mason 既有展開規則不變；JSON 鍵與 stance 值域不動
- **刻意未做**：沒有新增「白天不得公開夜間私密資訊」硬規則。狼的夜間刀人目標、占卜結果可能經 memory 進白天草稿，EXPAND 是否會把這些內容帶到公頻，留待 stage 2 觀察後再決定
- **本機驗證**：`npm run build` 通過；`node --test dist/lobby-server/room-manager.test.js dist/lobby-server/server.test.js dist/lobby-server/game-wolf.test.js` 為 33 pass / 0 fail；`src` 與 `dist` 的 `≤50字` 均為 0 處；`git diff --check` 通過
- **安全 runner**：新增 `scripts/run-external-test-safe.sh`。金鑰只從 `/etc/sglang/api-key.env` 進 process environment；curl header 由 stdin config 傳入；`setpriv` 降權到 `morowin` 後執行 `external-test-stage2.mjs "$@"`。支援新開局與 `--resume`，且不把金鑰放進 node／curl argv
- **runner 驗證**：Git for Windows `sh -n` 語法檢查通過；尚未上傳、執行或連到 server
- **SPEC 現況同步**：`docs/ubuntu-spec.md` 已改用【已上線】／【source 現況】／【production 未接線】／【目標／待實作】四種標記；補齊 V-Day、實際 loops、WS 事件狀態、部署與 systemd 缺口，並明確寫出正式 server 尚未接 `AiController`
- **目前邊界**：只證明引擎接線、編譯與本機測試正確；prompt 行為品質、公頻內容與 EXPAND 成效仍待後續實測

**Qwen `medium` variant 5 分鐘實測（2026-09-24）：**

- **設定**：從原始 `/tmp/night1.json` resume；`LLM_REASONING_EFFORT=medium`；用 `timeout --signal=INT 5m` 優雅中斷；不重啟 SGLang／wolfgame
- **為何用 env**：Qwen3.8 UI 的 `variant=medium` 對應 OpenAI/SGLang request 頂層 `reasoning_effort: "medium"`，不是 `variant` 欄位；新增 `llm.ts` per-request mapping，未設時完全保持原 request
- **時間窗口**：`07:53:06–07:58:06 UTC`；SGLang `max-running-requests=1`
- **實際請求**：journal 證實 28/28 個 OpenAI request 都含 `reasoning_effort: 'medium'`
- **完成進度**：14/14 `DAY_STRATEGY` 完成；13/14 `DAY_SPEECH` 草稿完成，第 14 個在 5 分鐘 SIGINT 時中止；已完成的 27 筆皆 attempt=1、零重試
- **尚未發生**：因全部策略＋草稿已吃掉 5 分鐘，尚未進入 `JUDGE`／`EXPAND`／`MESSAGE`；故這不是「EXPAND 失敗」或「引擎不發言」，而是時序預算尚未走到 publish
- **checkpoint**：`/tmp/day-medium-5m.json`（另有 `.events.json`／`.log.json`），可從這裡續跑到 judge／EXPAND／公頻
- **segment 2（08:05–08:10 UTC）**：從 `/tmp/day-medium-5m.json` resume；再次完成 14 策略＋14/14 草稿；08:09:46 已送出 judge request，但回應尚未完成就收到 SIGINT；沒有完成 JUDGE／EXPAND，最終 state 仍為 `ready=0`、`dayMessages=0`
- **5 分鐘限制根因**：`game.saveState()` 只保存 `dayMessages`／`dayReady` 等 engine state，不保存已完成但尚未 publish 的策略／草稿集合；`runDayDiscussion()` resume 時會無條件重跑 `DAY_STRATEGY` 與所有未 ready AI 的 `DAY_SPEECH`。因此再跑第三個 5 分鐘 segment 只會重做同一輪，不能前進到 EXPAND
- **報告**：server `/tmp/ai-trace-stage2-day.md`；本機 `C:\Users\user\Desktop\FrankTests\Temp\ai-trace-stage2-day.md`
- **本機驗證**：build 通過；lobby-server 33/33；mock HTTP server 確認實際 request JSON 含 `reasoning_effort: "medium"`
- **下一步（已選定）**：先完成 checkpoint Phase 2 Gate 2，再做 Phase 3 harness envelope；完成前不要重複 5 分鐘 resume。Phase 3 後才重新跑 segment 2，目標是復用已完成策略／草稿並產生首則 `JUDGE → EXPAND → MESSAGE`。

**私頻 EXPAND 機制＋草稿要點化（2026-09-24，oracle 兩段式驗證通過後落地）：**

修的是「引擎錯誤」——V8 把草稿定位改成行動筆記，但私頻 loop 缺展開步驟（SPEC §13.6 有 EXPAND，程式碼沒有），導致筆記直接進白板。

- **新增 `buildExpandPrompts(entry, draftSpeech, meeting)`**：SYSTEM = `buildSystemPrompt` ＋ 對應的 `wolfContext`/`masonContext`；USER 把選中的行動筆記用角色語氣重述成完整發言
- **新增 `expandSpeech()`**：`llmWithRetry`（內建 3 次重試，間隔 2s）→ 失敗 fallback 草稿原文，**不阻塞會議**
- **插入點**：`runWolfDiscussion`（狼）／`runMasonDiscussion`（共有者），judge 選定後、發布前
- **傳遞鏈**：展開後文字用於 `handleWolfChat`/`publishMasonSpeech`、廣播 `text`、`normalizePublishedStance`、回應輪 `wolfRespond`/`masonRespond`（夥伴讀到的是發言不是筆記）
- **`normalizePublishedStance` 保險**：新增 `fallbackSpeech` 參數，展開稿或草稿原文任一含刀人暱稱即正規化 stance（防展開品質退化導致 stance 漏判）
- **`AiLogEntry['kind']` 新增 `'EXPAND'`**：可從 ai-trace log 追蹤展開呼叫
- **草稿要點化（狼＋共有者）**：`wolfContext`／`masonContext` 的 Level 2 改「只影響決策」＋三行筆記定位；狼與共有者的 draft prompt 任務段加「寫成短句要點，每行一個重點」；狼 response 的 `speak` 分支同步改要點定位
- **關鍵設計句**（解除模型心理障礙）：`你寫的是筆記，之後會有人把它展開成完整發言；你不需要把它講好講滿。`
- **SPEC 同步**：§12.3 狼／共有者流程各加 ②' 展開（EXPAND）步驟、§13.6 兩張表加「展開草稿」行、§12.8 協議表註明 `text` 為展開後發言或失敗時的草稿原文
- **oracle 驗證兩段**：
  - 草稿 V9：產出三行要點筆記（結構達成；「不要寫成完整句」與「禁逐字台詞」未完全遵守，殘留引號台詞）
  - 展開 V9b：輸入該筆記 → **展開有效**（書面語「狼只要挑一個切」→「狼挑一個砍就完事了…留著這手牌」）、**零幻覺**（無新增行動/對象/結論）、排版三段符合
- **第一版展開失敗的教訓**：原本寫「照筆記的行動與決策講，不要新增…」→ 輸出幾乎等於草稿原文，無展開效果。改成「用你的角色語氣**重述**…不要照抄筆記的寫法」＋放寬為「不要新增行動/對象/結論，但可以改寫」才有效
- **當時未測路徑**：EXPAND 在真實 SGLang 上的行為、`normalizePublishedStance` 的 stance 補漏路徑；白天 EXPAND 已於上方 V-Day 完成實作，但 oracle／server 實測仍待完成
- **測試**：`npm run build` 通過；`node --test dist/lobby-server/room-manager.test.js dist/lobby-server/server.test.js` 27 pass / 0 fail

**共有者 prompt V8 落地（2026-09-24，oracle 雙共有者第 1 夜完整流程驗證通過後落地）：**

設計目標：用已落地的狼 prompt 編排邏輯重寫共有者 prompt，**只有身分差異，流程一致**。不動引擎（loop／JSON 解析／`masonReadyMap`）。

- **三函數全面對齊狼版編排**（逐行對應）：
  - `masonContext` 改成 Two-Level Split：Level 1 策略核心（身分＋目標＋夥伴＋deadNames 條件行）→ 5 個【硬】區塊（CO 決策／反假跳／第一天／互信分工／雙 CO 期表態）→ 禁止/正確 → 戰術字典 3 條 → 勝利綁定兩軸 → Level 2
  - `buildMasonDraftPrompts`：夜晚行 → 存活玩家 → 白天可鎖定的對象（exact list，排除自己＋夥伴）→ 會議紀錄 → 任務三件事 → 硬約束行 → 四件事（軸／四模式選擇題／模式一致性規則句／收場推演）→ 三條 ⚠️ → JSON → stance 硬規則
  - `buildMasonResponsePrompts`：五條評估軸 → 純附和可用 → 分派先回應 → 假設性討論視為成立 → 論點品質關卡 → stance 硬規則 → 三選一 → 五條 ⚠️
- **身分差異對照**：`可刀目標`→`白天可鎖定的對象`；`你刀誰`→`你 CO 還是隱匿`；狼四模式（潛伏/引導/假資訊/假跳）→ 共有者四模式（CO/隱匿/拋話題/分工觀察）；`【對跳結構】`→`【CO 決策】/【反假跳】/【第一天】/【互信分工】/【雙 CO 期表態】`
- **草稿定位（核心設計）**：草稿不是發言稿，是給夥伴看的**行動筆記**——只寫做什麼（誰做什麼、CO 與否）／關鍵理由一句／分工／預期走向一句；推演與理由保留但不詳細；**禁寫明天要說的逐字台詞**；角色 persona **只參與決策不決定措辭**
- **response `speak` 分支同規格**：禁評價式開頭（「你的判斷是對了」）、禁覆述夥伴內容、禁逐字台詞
- **移除**：舊版 ≤50 字約束（字數限制影響品質，改用結構描述控粒度）、夥伴行重複、`partnerName` 變數（改由 masonContext 帶）
- **oracle 測試演進**（同一第 1 夜場景重跑）：V4 300+字論述＋幻觉人名＋自我指涉混亂 → V5 200字敘述 → V7 150字（仍帶逐字台詞）→ **V8 130字純要點，無台詞、無敘述**
- **V8 測試結果**：雙方草稿決策一致（都是「我 CO、對方隱匿」）→ judge 盲選 `scores [8,9] best 1` → 真一稿發布 → 美咲回 `vote/ready` → **收斂**
- **未測路徑**：response `speak` 分支、`wait` 分支、第 2 天（deadNames 條件行＋有發言依據的質疑）
- **已知品質缺口（暫不修）**：CO 分支的拋話題缺「沒有具體抓手就別點名」防線（該防線只掛在「拋話題」模式分支上）
- **測試方法備註**：每輪新開 oracle session（模擬引擎每輪獨立 LLM 呼叫）、judge 必須獨立 session 盲評、subagent prompt 用讀檔避免手打汙染

**狼會議 prompt 精簡版＋四項修正落地（2026-09-22，oracle 三狼真實流程＋收斂確認全數驗證通過後落地，已 commit）：**
- **精簡版結構**（`buildSystemPrompt` 全角色共用）：P6/P13/P14/P9/P11/P12 六條併入【說話（硬規則）】單區；場上證據邊界壓縮成 2 行；硬規則列合併成 1 行
- **口癖族禁令（修正③，進【說話（硬規則）】）**：「我接」「你那句我接」「這句話我接」「我收到了」「同意你這說法」「你說得對」「了解」同族一律禁止開頭，開頭直接講判斷或動作
- **wolfContext 精簡版**（Level 1 策略核心）：P4/P5 併入單行、P10+P16 併入【對跳結構＋天數（硬）】4 點、P15 改【對跳期白天票鎖定】、禁止清單 12 條縮成 4 條、戰術字典 5 條縮成 3 條、勝利綁定壓成 1 行
- **修正①（P10#3 改寫）**：禁「晚上刀反跳者」＝自爆（反跳方夜死、假跳方還活著＝承認他是真的）；刀人照會議另選目標，不受白天反跳影響
- **修正②（第 1 天刀人不用寫理由）**：進 wolfContext＋draft prompt ①，第 2 天起理由有觀察依據再寫
- **修正④（stance 硬規則＝今晚刀人目標，非白天投票對象）**：draft/response prompt 均加「白天帶票只寫 speech，不寫進 stance」
- **draft prompt 精簡**：移除 P12 排版引用與「沒有的資訊不要補理由」冗句；四件事思考保留；JSON 鍵維持程式解析的 `speech`
- **response prompt 精簡**：評估軸 5 條壓成 5 條（併入禁刀反跳者提醒）；P1/P2/P8 併入 3 行；三選一＋⚠️ 壓縮；收斂確認結構（白板全部發言＋stance 硬規則）對齊
- deadNames 行改條件顯示（有人死才出現），第 1 夜輸出與測過文字一致

**狼會議 prompt 最終修訂（2026-09-21，oracle 模擬 8 人局雙狼會議逐則驗收後落地，已 commit 未部署）：**
- 新增規則（進 `buildSystemPrompt`，全角色共用）：P6 自然口語（禁單詞式質問/破碎斷句）、P9 禁 meta 確認句、P11 語言純度（全繁體，禁日文漢字/簡體混入）、P12 長發言排版（>50 字換行分段 ≤3 段：結論→動作→提醒）、P13 精簡、P14 動作必須具體（寫不出具體內容的「追問他/看風向」＝空話禁說）
- 新增規則（進 `wolfContext`，狼專用）：P4 說謊是狼的本職（編一個就好，禁「沒依據」反對理由）、P5 演技決定成敗、P10 對跳資訊結構＋天數感知（真占必有真實查驗結果；第 1 天雙CO 無過程可追＝演技戰，第 2 天起「過程」武器才解鎖；假跳真目的＝釣真占現身夜晚刀他）、P15 對跳期白天票鎖定假跳宣稱目標（禁跟真占點的人——可能點到狼自己）、P16 禁幻想破綻（真占不會改口/自亂陣腳，「等他講錯」不存在）；字典補「對跳」
- 新增規則（進 `buildResponsePrompts`）：P1 回答義務、P2 假設情境視為成立、P8 品質關卡版（廢話關＋反打關＋只覆蓋高機率分支）；評估軸加 P10/P16 提醒＋假跳/對跳戰術比較
- D（進 `buildDraftPrompts`）：白天動作選單補「假跳/對跳占卜師」選項＋假跳模式說明（編什麼結果/誰跳/怎麼圓謊）
- 字數限制：draft/response 的「≤50字」移除 → 由 P12 排版規則取代
- 測試抓到的 bug 家族：語言混雜（「占い師」「当场」）、幻想對手破綻（「他會答不出來」→「他會改口」同家族，第一天都不存在）、跟真占點的人投票（可能點到狼自己人）

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
1. 等使用者檢視本輪 raw SGLang 的第一句結果與指出問題。
2. 若要修正，先決定是否只改 `buildExpandPrompts()`：把 action note 的私有計畫轉成公頻發言時，不把「等某人問／某人會說」寫成已發生事實。
3. 「一輪／一圈」是另一個獨立問題，不要與私頻計畫問題混為一談。
4. 繁體輸出目前只有展示時 OpenCC 轉換，尚未落地；是否加入程式強制轉換，等使用者明確批准。
5. 未經批准，不修改 source、不重跑 night、不啟動正式服務。

**Server 上跑測試的正確方式（金鑰不得放進 argv）：**
```bash
# 只 pull 測試程式碼，不重啟正式服務
ssh ssh.morowin.win "cd /opt/wolfgame && git pull --ff-only"

# 重跑夜晚，產生 v2 envelope；medium 只作用於此測試 process
ssh ssh.morowin.win "sudo timeout --signal=INT --kill-after=30s 20m env LLM_REASONING_EFFORT=medium sh /opt/wolfgame/scripts/run-external-test-safe.sh --stop-at NIGHT_RESULT --save-state /tmp/night-v2-medium-attempt-01.json --report /tmp/ai-trace-stage2-night-v2-medium-attempt-01.md"

# 只有在 NIGHT_RESULT 死亡清單全部是 villager 時，才取回並覆蓋本機 night 報告
scp ssh.morowin.win:/tmp/ai-trace-stage2-night-v2-medium-attempt-01.md "C:\Users\user\Desktop\FrankTests\Temp\ai-trace-stage2-night.md"

# 本輪不 resume 白天；若之後要做，使用已通過的 night attempt-01 存檔
# ssh ssh.morowin.win "sudo timeout --signal=INT --kill-after=30s 15m env LLM_REASONING_EFFORT=medium sh /opt/wolfgame/scripts/run-external-test-safe.sh --resume /tmp/night-v2-medium-attempt-01.json --stop-after-first-message --save-state /tmp/day-v2-medium-seer-alive-first.json --report /tmp/ai-trace-stage2-day-v2-medium-seer-alive-first.md"
```

舊的 `/tmp/night1.json` 是 legacy 三檔格式，不能餵給目前 v2 harness；勿刪除，作为歷史 night 記錄。

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

1. **[HIGH] 使用者檢視 raw SGLang 第一句** → 14 strategy／14 draft／judge／expand 已完成；目前只等指出問題
2. **[HIGH] EXPAND 語意修正決策** → 私頻計畫轉公頻發言的規則已用臨時 direct prompt 驗證有效，但未修改 source；需使用者批准後才落地
3. **[MED] 輪次／一圈詞彙決策** → 目前仍殘留「一輪／一圈」，與私頻計畫問題分開處理
4. **[MED] 繁體輸出 enforcement** → 目前只做過 OpenCC 展示轉換，是否落地到程式待批准
5. **[MED] 新的引擎白天測試** → 需使用者批准 prompt 修正後，從 `/tmp/night-v2-medium-attempt-01.json` 走真實 harness；不重跑 night
6. **[LOW] 前端（ubuntu-web/）** → 等外部測試跑通完整一局再開

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

# Server：正式部署才重啟服務
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
- 所有會議統一格式（出稿→judge→回應→收斂 loop）
- CD 自動判斷：無真人→0（立即）；有真人→60s
- 120s timer 已完全移除，不保留 fallback
- 100 則安全上限只限測試（正式版預設 0=停用）
- **不要動 engine，不允許重生成**——AI 必須被 prompt 訓練到每次都能直接說出對的話
- **有人想發言就不是 ready**（出新草稿 = 撤回 ready）
- **純口頭推論遊戲**——沒有路徑、軌跡、不在場證明、操作記錄（那是 Among Us）
- 5 分鐘白天 timeout 只是測試方便，不是正式需求
