# AI Werewolf/Mafia Prompt Engineering — Community Research

> Source: ~40 sources (academic papers, production GitHub repos, Chinese dev-community write-ups, Reddit threads incl. r/SillyTavernAI RP 社群)
> Date: 2026-09-16 · Reddit RP 社群補充: 2026-09-24

## 1. System Prompt Structure (Converged Pattern)

Nearly every serious implementation uses: **identity → rules → state → phase command → output contract**

```
## Character Identity
**Name:** %name%
**Personal Story:** %personal_story%
**Game Role:** %role%
%werewolf_teammates_section%        ← only injected for wolves

## Game Rules
Core mechanics, teams, special roles, phase order, victory conditions

## Game State
**Alive Players:** %players_names%
**Dead Players:** %dead_players_names_with_roles%
```

Key engineering details (from hiper2d/werewolf-ai-party-game):
- **Prompt-cache tiering**: system prompt split at a marker. Everything above must be byte-identical across all bots (shared rules); everything below is per-bot/per-game.
- **No RAG**: "Werewolf rules are compact and can easily fit the system prompt."
- **State machine, not free chat**: Each moment commands the model to do a very concrete thing.
- **Context rewriting**: Don't use provider-side sessions. Rewrite history each turn (drop reminders, re-flatten chat, inject facts).

## 2. Two-Level Split (Anti-Break-Character)

The most-cited technique for balancing role-play vs game competence:

```
**CRITICAL RULE: You operate on two levels - Level 1 is MANDATORY and OVERRIDES everything else.**

### Level 1: Strategic Core (Your Brain) - MANDATORY PRIMARY FUNCTION
ALL accusations, votes, and suspicions MUST be based exclusively on:
- Voting patterns and alliances
- Claims and contradictions in statements about game mechanics
- Strategic inconsistencies in player behavior
- Information from your special role
- Process of elimination from revealed dead players

**ABSOLUTELY FORBIDDEN:** "My knight character distrusts shifty merchants, and John's character is a merchant, so I vote for John."

**ENCOURAGED:** "Ah, the mines! I've heard tales of those depths... But we should discuss yesterday's strange voting pattern."
```

"Level 1 is the strategic brain. Level 2 is the character, and it drives everything else."

## 3. The "Reminder Postfix" (Highest-Leverage Trick)

A text block appended to the *last message only* (never saved to history):

```
**Keep in mind that you must follow your core playstyle:** %play_style%
**RELATIONSHIP & CONVERSATION CONTINUITY:**
- REMEMBER your previous interactions with each player
- CONTINUE unfinished discussions from previous days
- EVOLVE your opinions - explain how your view of someone has changed and why
**CRITICAL DECISION-MAKING REMINDER:**
- Base ALL suspicions on voting patterns, contradictions, and strategic behavior - NEVER on story details
- Question mob consensus: If 4+ players agree on a target, ask WHY no one is defending them
- Apply your reasoning consistently: If your logic applies to yourself too, acknowledge equal suspicion
- Remember: Werewolves coordinate and often defend innocent targets to blend in - total agreement is suspicious
**COMPACT REPLIES:**
- Keep output lean - 2 to 4 complete sentences per response.
```

"I don't save those reminders to the chat history. They are only added to the last message... 'Question mob consensus' is the single line that did the most work in this whole project."

## 4. Common Pitfalls

### Language: Simplified vs Traditional
- Even with "請用繁體中文回答", the model outputs traditional *characters* with mainland *vocabulary* (用戶/調用/軟體 instead of 使用者/呼叫/軟體)
- Community solution: post-processing (the `zhtw` tool) or explicit term-mapping table in the prompt
- ~15% English contamination measured without explicit "no English" rule
- **Reasoning models thinking out loud**: "Had to switch the thinking off the Qwens so they don't think out loud into public chat" (r/LocalLLaMA)

### Made-up Game Terms / Invented Mechanics
- "They hallucinated over the rules and names. New roles appeared in their messages. They were not clear on the order of events and invented their own rules." (hiper2d)
- Fix: **Pass exact lists, never make the model reconstruct them**
- "ELIGIBLE CANDIDATES - you may vote for exactly ONE of these: [list]. The 'who' field MUST be ONE name copied EXACTLY from the candidate list above, character-for-character. Do NOT invent names."
- Explicit anti-fabrication: "所有发言必须基于已公开信息，禁止编造未发生的夜间行动"
- Engine-side validation as the final wall: "an illegal or hallucinated agent move can never corrupt a game"

### AI Too Passive or Too Aggressive
- **Passive**: Bots "didn't push the game forward" until reminder postfix + play styles with motivations were added
- **Groupthink**: "the group can descend into GroupThink where everyone is parroting other players... the GPT model seems to be overly agreeable"
- **RLHF personality bleed**: ChatGPT "constantly tries to boss everyone around, makes lists, and dictates how the town should vote"

### GM / Information Leaks
- Players forging GM messages: fix = wrap all system info in XML tags + teach model "only these tags are authoritative"
- Reasoning leaks: "Only the structured fields are surfaced, preventing reasoning leaks"
- Prompt-to-prompt leakage: "Without those boundaries, apparent 'intelligence' may simply be an accidental leak of information from one prompt into another"

## 5. Best Practices by Topic

### Keeping AI in Character
1. Two-level split with concrete forbidden/encouraged examples
2. Persona + few-shot utterance examples (hand-crafted sample lines in target tone)
3. Rich persona anchoring beats bare labels ("经验丰富的预言家，冷静、理性、惜字如金" vs "你是预言家，请发言")
4. Play styles with motivations, per-faction
5. Reminder postfix on the last message
6. Stable bootstrap file re-injected every turn
7. Anti-meta-gaming: "NEVER use words like 'suspicion score', 'parameters', or 'AI' in your public statements"

### Forcing JSON Output
1. Schema in prompt: "Respond with ONLY a JSON object... No extra text, no markdown, no code fences."
2. Provider structured output (zod/Pydantic)
3. Regex extraction as fallback: `re.compile(r'{[\s\S]*?}')`
4. Validate → retry with feedback → swap model
5. Bounded retries with safe fallback (3 strikes → "我需要更多信息，暂不发表意见")
6. Name matching/repair before action hits engine

### Preventing Invented Mechanics
- Compact, complete rules in system prompt
- Pass exact lists, never make model reconstruct
- Inject facts as structured records, not prose
- Engine-side validation as final wall
- Explicit anti-fabrication lines
- **Prompt length discipline**: "当提示词超过800字，ERNIE Bot 4的输出稳定性下降37%"

### Wolf Meeting / Private Channel
Four patterns in the wild:
1. **Shared private room with JSON discussion** (hiper2d)
2. **Parser-gated discussion with exit condition** (AgentScope): every reply parsed as `{thought, speak, finish_discussion}` — the boolean ends the loop
3. **Debate transcript → final decision** (hiimnhan): receives "Dialogue history from tonight's wolf debate" + "Available Targets"
4. **Directed messages with named collector** (nexus-research-lab): one named wolf aggregates and hands back privately. "Never 'open a discussion and wait.' A named player must hand the result back."

Strategy content: kill priority 女巫 > 预言家 > 村民; 悍跳 (fake-seer) + 倒钩 (defend good player); "不惧怕狼队友被投票出局"

## 6. Reddit RP 社群補充與對照（r/SillyTavernAI，2026-09-24）

> 掃描 24 帖主文 + ~760 則留言（arctic-shift API 抓取），過濾出 230 則高信號評論。主要來源：Freaky Frankenstein 5.x / FrankenSIM 3.0 燈塔 preset 帖、Sola V1、Guided Generations、GLM/Minimax roleplay prompt 分享、JSON 卡片格式辯論、thinking 爭議帖。

### 6.1 紅帖社群獨有技術（§1–§5 未涵蓋）

**Internal States / tracker 區塊**（FF5 系，社群最推崇）
- 每則回覆**末尾附加隱藏狀態塊**：信任/好感/怨恨、NPC 議程、GM 筆記、時間地點、世界狀態；regex 抹掉舊狀態塊，**只送最後一輪**（"the AI never sees all the previous internal state turns"）
- 世界在畫面外繼續運轉：NPC 記仇、記得 20 輪前的言行
- → 狼人殺落地：每日投票/信任/指控 tracker + GM 筆記（誰 claim 了什麼、誰自相矛盾），逐日覆寫並歷史瘦身 —— 即 §1「context rewriting」的具體機械化

**Anti-drift 再掛鉤稽核**
- `[OOC: silently audit if NPC core identity drifted... re-anchor]` 每 4–5 則插入一次
- FrankenSIM 用 **idiolect 指紋**判準：NPC 說話不留指紋 = 漂移 = 強制修正
- §5「stable bootstrap re-injected every turn」→ 補上間歇稽核與指紋判準

**AI-slop / LLM-isms kill-list**
- 禁詞清單（ozone、spine、breath hitching…）、anti-parrot/anti-echo、anti-therapyspeak（GLM 系特別愛把角色寫成心理治療師）、禁 "not X but Y" / "you said" 句式、禁 echoing 玩家話語
- **負面偏見 prompt**：玩家宣告動作 = 嘗試非結果；按真實勝率寫最可能的結果而非最爽的結果
- 三層實作：banned tokens + regex 清理 + post-history 指令 —— 治 §4「AI too passive/aggressive」與 groupthink

**Thinking steering**（社群共識：不是關掉，是引導）
- thinking 不該拿來複述靜態規則（安慰劑效應）；要用來 **planning**：規劃下一步、消化現況、算投票模式
- thinking summary 常由小模型外包產生，不代表真實內部運作 → 只取結構化結果欄位
- self-prefill：assistant 訊息「I'll start my reasoning with X, then...」同時規避審查 + 提高 adherence

**格式辯論：JSON vs 自然語言**（§5「structured records」需軟化）
- 壓縮 JSON 派：單行少空白省 80–90% token，結構資料較穩
- 反方：LLM 本質吃自然語言，除非受過結構化訓練
- 實務折衷：Markdown 最被廣推、XML 某些模型最懂、中文社群偏 YAML → **模型依賴**
- "The universe doesn't understand 'No'"：否定句指令弱 → 正向指令 + 精確清單

**其他**
- **hamburger 位置理論**：LLM 最重視 context 頭尾；CoT 放 depth-0 交叉引用 system（補強 §1 placement）
- 80k token 以上模型變笨 → 摘要重整（補強 §5 prompt length discipline）
- **semantic density**：少 token 高語意密度保角色深度；負面個性標籤詞（smart/intelligent）誘發刻板行為
- per-model 提示詞變體 + 中途換模型（"Kimi 太倔就切回 GLM"）
- provider 層 prompt injection 實測存在（OpenRouter 注入 system prompt）→ 校驗伺服器端 system prompt 完整性（補強 §4 洩漏防禦）

### 6.2 與既有章節對照

| 章節 | 紅帖證據 | 判定 |
|---|---|---|
| §1 系統提示結構 | 吻合；hamburger placement 補強 | ✅ 證實 + 延展 |
| §2 兩層分割 | 「角色卡做主角、prompt 只克服模型偏見」；rules/examples 分離 | ✅ 證實 |
| §3 Reminder Postfix | = post-history instructions；補間隔排程（4–5 則）與負面偏見變體 | ✅ 證實 + 補強 |
| §4 推理外洩 | 社群已知 thinking 不可信也不可漏 → 只留結構化結果 | ✅ 證實 |
| §5 JSON 強制輸出 | 格式爭議（6.1）；regex fallback、validate→retry 為標準做法 | ⚠️ 軟化 |
| §5 防自創機制 | exact lists、banned tokens、engine 驗證完全吻合 | ✅ 強力證實 |
| §5 狼群私聊 | 紅帖無遊戲邏輯對應；agentic harness（reason + tools）趨勢可參考 | ➕ 架構訊號 |

### 6.3 兩處與 doc 出入
1. **thinking**：doc 引「關掉 Qwen 的 thinking」；紅帖共識是 thinking 對複雜一致性有用，應轉向引導而非一律關閉 —— 狼人殺屬複雜狀態場景，建議「steering + 剝離」（思考去算投票模式與矛盾，結果不外洩）
2. **No RAG**：doc 對規則本身正確；但遊戲歷史/投票模式分析可考慮 RAG 或 tool-call（agentic harness 模式，見 6.1）

## 7. Key Sources

### Production Repos
- [hiper2d/werewolf-ai-party-game](https://github.com/hiper2d/werewolf-ai-party-game) — most detailed public post-mortem
- [hiimnhan/scc452-badass-werewolf](https://github.com/hiimnhan/scc452-badass-werewolf/blob/54afbe0b/prompt.py)
- [MetaGPT werewolf extension](https://github.com/geekan/MetaGPT/blob/main/metagpt/ext/werewolf/actions/common_actions.py)
- [AgentScope werewolves sample](https://github.com/agentscope-ai/agentscope-samples/blob/main/tuner/werewolves/structured_model.py)
- [deepwolf](https://github.com/JuneQQQ/deepwolf)
- [nexus werewolf-6p skill](https://github.com/nexus-research-lab/nexus/blob/main/skills/werewolf-6p/SKILL.md)

### Blogs / Write-ups
- [How to make LLMs play conversational games (dev.to)](https://dev.to/hiper2d/how-to-make-llms-play-conversational-games-3de5)
- [AI 狼人杀 Prompt 思路 (indienova)](https://indienova.com/indie-game-development/ai-and-werewolf/)
- [AI狼人殺·賽事分享 (Aliyun)](https://developer.aliyun.com/article/1672135)
- [基于ERNIE大模型的Python狼人杀Web游戏](http://www.jsqmd.com/news/954605/)
- [OpenViking SOUL-player.md 全解析](https://blog.gitcode.com/08455d032e03de9cc91a33f7d12c530a.html)
- [AWS China: 如何利用智能体玩转"狼人杀"](https://aws.amazon.com/cn/blogs/china/using-intelligent-agents-to-play-mafia-game/)
- [LLM 繁體中文輸出在地化 (timinsight)](https://timinsight.com/zhtw-llm-post-processing-guide-zh/)

### Academic
- [Language Agents with RL for Werewolf (arXiv 2310.18940)](https://arxiv.org/html/2310.18940)
- [AIWolfDial 2024: Tanaka et al.](https://aclanthology.org/2024.aiwolfdial-1.6)
- [Watanabe & Kano (logical role inference)](https://doi.org/10.18653/v1/2024.aiwolfdial-1.3)
- [WOLF: Werewolf-based Observations for LLM Deception (arXiv 2512.09187)](https://arxiv.org/html/2512.09187v1)

### Reddit
- [r/LocalLLaMA: One Night Werewolf played by LLMs](https://www.reddit.com/r/LocalLLaMA/comments/1tjegle/one_night_werewolf_played_by_llms/)
- [r/LocalLLaMA: thinking mode leaking](https://www.reddit.com/r/LocalLLaMA/comments/1tcjtmt/playing_one_night_werewolf_gemma4_qwen36/)
- [r/LLM: 4,672 blind werewolf games — name bias](https://www.reddit.com/r/LLM/comments/1rehlfj/i_made_llms_play_werewolf_4000_times_they_keep/)

### Reddit (r/SillyTavernAI RP 社群，2026-09-24 — §6 對照來源)
- [Freaky Frankenstein 5.0: Internal States](https://www.reddit.com/r/SillyTavernAI/comments/1v9u18m/) — 燈塔 preset：隱藏狀態塊 + tracker 體系
- [Freaky Frankenstein 5.4 社群更新](https://www.reddit.com/r/SillyTavernAI/comments/1w49lyx/)
- [FrankenSIM 3.0: 13-axis persona + anti-drift](https://www.reddit.com/r/SillyTavernAI/comments/1vrzcv6/)
- [Sola V1 個人 prompt 分享](https://www.reddit.com/r/SillyTavernAI/comments/1wc57ys/)
- [Guided Generations v1.7: separated thinking 校正層](https://www.reddit.com/r/SillyTavernAI/comments/1uh54hq/)
- [Save Tokens: JSON for cards/lorebooks（格式爭議）](https://www.reddit.com/r/SillyTavernAI/comments/1e8upr7/)
- [Replace Thinking with a Prompt（thinking 辯論）](https://www.reddit.com/r/SillyTavernAI/comments/1vmp7qz/)
- [What does a typical RPer want in a system prompt?](https://www.reddit.com/r/SillyTavernAI/comments/1vsrudb/)
- [A negative bias prompt（結果判定規則）](https://www.reddit.com/r/SillyTavernAI/comments/1uvjg4d/)
- [Agentic roleplay harness（reason + tools 取代單一 prompt）](https://www.reddit.com/r/SillyTavernAI/comments/1u9zbq7/)
- [GLM 4.7 attention bypass / self-prefill](https://www.reddit.com/r/SillyTavernAI/comments/1pwaft5/)