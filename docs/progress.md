# 進度追蹤（ubuntu 分支）

> 更新：2026-09-24
> 用途：新 session 接手時讀此文件即可無縫繼續。

## 目前狀態

**卡在哪：** 無阻塞。共有者（mason）prompt V8 已落地（對齊狼版編排＋草稿＝行動筆記定位）；白天（DAY_DISCUSSION）外部測試為先前進度（見下方）。

- ✅ **共有者 prompt V8 落地**（2026-09-24，oracle 雙共有者第 1 夜流程驗證後落地）：三函數（`masonContext`／`buildMasonDraftPrompts`／`buildMasonResponsePrompts`）全面對齊狼版編排，只有身分差異；草稿定位改為「行動筆記非發言稿」
- ✅ **私頻稱呼修正**（2026-09-24，stage 1 實測發現＋oracle 驗證後落地）：2 人私頻用「你／名字＋你」，禁「他／她」與「你們」
- ✅ **私頻 EXPAND 機制＋草稿要點化**（2026-09-24，oracle 兩段式驗證後落地）：草稿＝行動筆記 → 引擎展開成角色語氣完整發言才進白板；狼與共有者兩側同步

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
- **未測路徑**：EXPAND 在真實 SGLang 上的行為、`normalizePublishedStance` 的 stance 補漏路徑、白天的 EXPAND（本次不實作，白天等測試範圍確定）
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
ssh ssh.morowin.win "cd /opt/wolfgame && SGLANG_API_KEY=<REDACTED> node scripts/external-test-stage2.mjs --stop-at NIGHT_RESULT --save-state /tmp/night1.json"

# 從存檔接白天（5 分鐘一段，可多次接續）
ssh ssh.morowin.win "cd /opt/wolfgame && SGLANG_API_KEY=<REDACTED> node scripts/external-test-stage2.mjs --resume /tmp/night1.json --stop-at DAY_RESULT --save-state /tmp/day1.json"

# 接續下一段（報告會合併前段 events）
ssh ssh.morowin.win "cd /opt/wolfgame && SGLANG_API_KEY=<REDACTED> node scripts/external-test-stage2.mjs --resume /tmp/day1.json --stop-at DAY_RESULT --save-state /tmp/day2.json"

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
  "cd /opt/wolfgame && SGLANG_API_KEY=<REDACTED> node scripts/external-test-stage2.mjs --stop-at NIGHT_RESULT --save-state /tmp/night1.json"

ssh -F "C:\Users\user\Desktop\FrankTests\.ssh\config" ssh.morowin.win \
  "cd /opt/wolfgame && SGLANG_API_KEY=<REDACTED> node scripts/external-test-stage2.mjs --resume /tmp/night1.json --stop-at DAY_RESULT --save-state /tmp/day1.json"

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
