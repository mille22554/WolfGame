# AI Werewolf/Mafia Prompt Engineering — Community Research

> Source: ~30 sources (academic papers, production GitHub repos, Chinese dev-community write-ups, Reddit threads)
> Date: 2026-09-16

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

## 6. Key Sources

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