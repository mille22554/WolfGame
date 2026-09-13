/**
 * character-session.test.ts — buildPrompt / summarizeDay / 截斷測試
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, summarizeDay, buildPreSpeechPrompt, buildJudgePrompt, buildExpandPrompt, PRE_SPEECH_BUDGET, buildWolfPreSpeechPrompt, buildWolfExpandPrompt, summarizeWolfDiscussion } from './character-session.js';
import { createGameState, transition, getNightActors } from './game-state.js';
import type { GameState } from './types.js';
import { Role } from './types.js';

function joinAll(state: GameState, count: number): void {
  for (let i = 0; i < count; i++) transition(state, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
}

/** 狼密談收斂：全存活狼 ready → NIGHT_COLLECTING（新流程：START_GAME/ADVANCE_DAY 先進 NIGHT_DISCUSSION_OPEN） */
function convergeWolfDiscussion(s: GameState): void {
  for (const p of s.players) {
    if (p.alive && p.role === Role.WEREWOLF) {
      const r = transition(s, p.controlledBy === 'human'
        ? { type: 'HUMAN_WOLF_READY', playerId: p.id }
        : { type: 'AI_WOLF_READY', playerId: p.id });
      assert.equal(r.accepted, true);
    }
  }
  assert.equal(s.phase, 'NIGHT_COLLECTING');
}

function discussionState(count = 9): GameState {
  const s = createGameState(count);
  joinAll(s, count);
  transition(s, { type: 'START_GAME' });
  convergeWolfDiscussion(s);
  transition(s, { type: 'ACTION_TIMEOUT', gateId: 'night-1' });
  transition(s, { type: 'RESOLVE_NIGHT' });
  assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
  return s;
}

function aliveIds(s: GameState): number[] {
  return s.players.filter((p) => p.alive).map((p) => p.id);
}

test('buildPrompt 含角色卡/規則/公開知識/私有知識/當天討論/摘要/任務指令', () => {
  const s = discussionState();
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  transition(s, { type: 'HUMAN_SPEAK', playerId: aliveIds(s)[0], text: '大家早安' });
  s.daySummaries.push('第0天摘要標記');
  const prompt = buildPrompt(s, wolf.id, 'speech');
  assert.ok(prompt.includes('人格設定'));
  assert.ok(prompt.includes('公開知識'));
  assert.ok(prompt.includes('你的編號'));
  assert.ok(prompt.includes('人狼同盟')); // 狼私有知識
  assert.ok(prompt.includes('大家早安')); // 當天討論
  assert.ok(prompt.includes('第0天摘要標記')); // 歷史摘要
  assert.ok(prompt.includes('任務')); // 任務指令
});

test('buildPrompt 私有知識依角色：seer 有查驗紀錄', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  convergeWolfDiscussion(s);
  const seer = s.players.find((p) => p.role === Role.SEER)!;
  for (const pid of getNightActors(s)) {
    transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: aliveIds(s).filter((id) => id !== pid)[0] });
  }
  transition(s, { type: 'RESOLVE_NIGHT' });
  const prompt = buildPrompt(s, seer.id, 'night');
  assert.ok(prompt.includes('查驗紀錄'));
});

test('截斷：超長討論 → 先丟 daySummary 再丟當天最舊', () => {
  const s = discussionState();
  const speaker = aliveIds(s)[0];
  const filler = '填充'.repeat(25); // 每則約 50+ 字
  for (let i = 0; i < 60; i++) {
    transition(s, { type: 'HUMAN_SPEAK', playerId: speaker, text: `發言${i}${filler}` });
  }
  s.daySummaries.push('摘要標記應被先丟棄' + filler);
  const full = buildPrompt(s, speaker, 'speech', 1_000_000);
  assert.ok(full.includes('發言0'));
  assert.ok(full.includes('摘要標記應被先丟棄'));
  const budget = full.length - 2000;
  const truncated = buildPrompt(s, speaker, 'speech', budget);
  assert.ok(truncated.length < full.length);
  assert.ok(!truncated.includes('摘要標記應被先丟棄'), 'daySummary 應先被丟棄');
  assert.ok(!truncated.includes('發言0'), '當天最舊討論應被丟棄');
  assert.ok(truncated.includes('發言59'), '最新討論應保留');
});

test('跨日分隔線：多天討論以 === 第N天 === 分隔；單日時無分隔線', () => {
  const s = discussionState();
  const speaker = aliveIds(s)[0];
  transition(s, { type: 'HUMAN_SPEAK', playerId: speaker, text: '今天第一句' });
  // 單日：無分隔線（與舊輸出一致）
  const single = buildPrompt(s, speaker, 'speech', 1_000_000);
  assert.ok(single.includes('今天第一句'));
  assert.ok(!single.includes('=== 第'), '單日時不應有分隔線');
  // 跨日：直接塞前一天紀錄，prompt 應出現分隔線＋兩天內容
  const today = s.day;
  s.discussionLog.unshift({ playerId: speaker, text: '昨天說過的話', day: today - 1 });
  const multi = buildPrompt(s, speaker, 'speech', 1_000_000);
  assert.ok(multi.includes(`=== 第${today - 1}天 ===`), '應有前一天分隔線');
  assert.ok(multi.includes(`=== 第${today}天 ===`), '應有當天分隔線');
  assert.ok(multi.includes('昨天說過的話'), '應保留前一天內容');
  assert.ok(multi.includes('今天第一句'), '應保留當天內容');
  // 分隔線順序：舊天在前
  assert.ok(multi.indexOf(`=== 第${today - 1}天 ===`) < multi.indexOf(`=== 第${today}天 ===`), '天數應由舊到新');
});

test('跨日分隔線：狼討論跨日時同樣分隔', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  s.wolfDiscussionLog.push({ playerId: wolf.id, text: '昨晚說殺P3', day: s.day });
  // 推進一天（不清空狼紀錄）：直接改 day 模擬跨日
  const nextDay = s.day + 1;
  s.day = nextDay;
  s.wolfDiscussionLog.push({ playerId: wolf.id, text: '今晚改殺P5', day: nextDay });
  const prompt = buildPrompt(s, wolf.id, 'wolf_speech', 1_000_000);
  assert.ok(prompt.includes('=== 第1天 ==='), '應有前一晚分隔線');
  assert.ok(prompt.includes('=== 第2天 ==='), '應有今晚分隔線');
  assert.ok(prompt.includes('昨晚說殺P3'), '應保留前一晚內容');
  assert.ok(prompt.includes('今晚改殺P5'), '應保留今晚內容');
});

test('buildPrompt 預設預算 4000：超量輸入截到 ≤4000（daySummaries 機制保留）', () => {
  const s = discussionState();
  const speaker = aliveIds(s)[0];
  const filler = '填充'.repeat(50); // 每則約 100+ 字，60 則遠超預算
  for (let i = 0; i < 60; i++) {
    transition(s, { type: 'HUMAN_SPEAK', playerId: speaker, text: `發言${i}${filler}` });
  }
  s.daySummaries.push('摘要標記' + filler);
  const prompt = buildPrompt(s, speaker, 'speech');
  assert.ok(prompt.length <= 4000, `預設預算 prompt ${prompt.length} 字元應 ≤ 4000`);
  assert.ok(prompt.includes('發言59'), '最新討論應保留');
});

test('summarizeDay 格式：top3 指控 + 投票結果', () => {
  const s = discussionState();
  const ids = aliveIds(s);
  const [a, b, c] = ids;
  transition(s, { type: 'HUMAN_SPEAK', playerId: a, text: `我懷疑 P${b}，他很可疑` });
  transition(s, { type: 'HUMAN_SPEAK', playerId: c, text: `我也覺得 P${b} 有問題，票投 P${b}` });
  transition(s, { type: 'HUMAN_SPEAK', playerId: b, text: '我是好人' });
  const summary = summarizeDay(s, s.day);
  assert.ok(summary.includes(`第${s.day}天摘要`));
  assert.ok(summary.includes(`P${b}`));
});

test('buildPreSpeechPrompt：輕量段落齊全、≤ 2000 字元', () => {
  const s = discussionState();
  const speaker = aliveIds(s)[0];
  transition(s, { type: 'HUMAN_SPEAK', playerId: speaker, text: '大家早安，今天多聽聽' });
  s.daySummaries.push('第0天摘要標記');
  const prompt = buildPreSpeechPrompt(s, speaker);
  assert.ok(prompt.includes('人格設定'), '草稿帶人格：人格是決策依據');
  assert.ok(prompt.includes('persona:'), '草稿帶人格：含 agents.md 內容');
  assert.ok(prompt.includes('你的角色資訊'));
  assert.ok(prompt.includes('當天摘要'));
  assert.ok(prompt.includes('第0天摘要標記'));
  assert.ok(prompt.includes('最近討論'));
  assert.ok(prompt.includes('大家早安'));
  assert.ok(prompt.includes('預發言草稿'));
  assert.ok(prompt.includes('嚴禁任何簡體字'), '白天草稿應明令禁止簡體字');
  assert.ok(prompt.length <= PRE_SPEECH_BUDGET, `預發言 prompt ${prompt.length} 字元應 ≤ ${PRE_SPEECH_BUDGET}`);
});

test('buildJudgePrompt：全盲（打亂匿名、不含 P 編號）+ 評分指令', () => {
  const prompt = buildJudgePrompt('第1天摘要標記', [
    { slot: 1, text: '今天氣氛有點緊張' },
    { slot: 2, text: '多聽聽大家的說法' },
  ]);
  assert.ok(prompt.includes('第1天摘要標記'));
  assert.ok(prompt.includes('1. 今天氣氛有點緊張'));
  assert.ok(prompt.includes('2. 多聽聽大家的說法'));
  assert.ok(prompt.includes('裁判任務'));
  assert.ok(!/P\d+/.test(prompt), '裁判 prompt 不得含 P 編號');
});

test('buildExpandPrompt：標準 speech prompt + 草稿附加', () => {
  const s = discussionState();
  const speaker = aliveIds(s)[0];
  const draft = 'P9：「我比較在意沉默的人。」';
  const prompt = buildExpandPrompt(s, speaker, draft);
  assert.ok(prompt.includes('任務'), '應含標準 speech 任務指令');
  assert.ok(prompt.includes('你的預發言草稿'));
  assert.ok(prompt.includes(draft));
});

test('buildWolfPreSpeechPrompt：含襲擊/今晚語境 + 殺P 決策旗標指示', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  const prompt = buildWolfPreSpeechPrompt(s, wolf.id);
  assert.ok(prompt.includes('今晚') || prompt.includes('襲擊'));
  assert.ok(prompt.includes('殺P'));
  assert.ok(prompt.includes('資訊不足'));
  assert.ok(prompt.includes('指名目標→殺P編號，未指名→資訊不足'), '平衡句 decided 出口');
  assert.ok(prompt.includes('全篇繁體中文，禁止任何英文'), 'pre 應明令繁體中文＋禁英文');
  assert.ok(prompt.includes('直接提案目標'), '真對話指引');
});

test('狼 prompt：極簡 pre 列合法目標（不含同盟）；expand 沿用舊約束', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  const allies = s.players.filter((p) => p.role === Role.WEREWOLF && p.alive && p.id !== wolf.id);
  const pre = buildWolfPreSpeechPrompt(s, wolf.id);
  assert.ok(pre.includes('今晚可襲擊：'), '極簡 pre 應列合法目標');
  const seg = pre.split('今晚可襲擊：')[1]?.split('。')[0] ?? '';
  for (const a of allies) {
    assert.ok(!seg.includes(`P${a.id}`), `合法目標清單不應含同盟 P${a.id}`);
  }
  assert.ok(pre.includes(`你的同盟是 ${allies.map((a) => `P${a.id}`).join('、')}。`), '身份段應列同盟');
  const expand = buildWolfExpandPrompt(s, wolf.id, 'P1：「今晚先襲擊P3。」');
  assert.ok(!expand.includes('守衛可能保誰'), '不應引導討論無法得知的守衛動向');
  assert.ok(expand.includes('指名'), 'expand 應要求指名具體目標');
  assert.ok(expand.includes('同盟不可襲擊'), 'expand 應禁止殺同盟');
  assert.ok(expand.includes('繁體中文'), 'expand 應要求繁體中文');
  assert.ok(expand.includes('與簡體字'), 'expand 應明令禁止簡體字');
  assert.ok(expand.includes('今晚可襲擊的存活玩家'), 'expand 應列舉合法目標');
  assert.ok(expand.includes('不得以任何守衛相關猜測') && expand.includes('作為選擇或排除目標的理由'), 'expand 應禁止以守衛猜測為理由');
});

test('summarizeWolfDiscussion：讀 wolfDiscussionLog 並統計襲擊目標提及', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  s.wolfDiscussionLog.push({ playerId: wolf.id, text: '我懷疑P3，今晚襲擊P3', day: s.day });
  s.wolfDiscussionLog.push({ playerId: wolf.id, text: 'P3威脅最大，投P3出去', day: s.day });
  const summary = summarizeWolfDiscussion(s, s.day);
  assert.ok(summary.includes('P3'));
  const empty = createGameState(9);
  joinAll(empty, 9);
  transition(empty, { type: 'START_GAME' });
  assert.ok(summarizeWolfDiscussion(empty, empty.day).includes('尚無明確目標'));
});

test('buildWolfExpandPrompt：狼 speech prompt + 草稿附加', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  const draft = 'P1：「今晚先襲擊P3。」';
  const prompt = buildWolfExpandPrompt(s, wolf.id, draft);
  assert.ok(prompt.includes('你的預發言草稿'));
  assert.ok(prompt.includes(draft));
  assert.ok(prompt.includes('襲擊') || prompt.includes('今晚'));
});

test('防幻覺觀察：狼 pre 走極簡規則內 grounding；expand／白天沿用舊聲明', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  assert.equal(s.discussionLog.length, 0);
  assert.equal(s.wolfDiscussionLog.length, 0);
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  const pre = buildWolfPreSpeechPrompt(s, wolf.id);
  assert.ok(pre.includes('只能談你自己的狀態'), '極簡 pre 應含自身狀態 grounding');
  assert.ok(pre.includes('不得描述其他玩家的行為、狀態或感覺'), '極簡 pre 應禁述他人');
  const expand = buildWolfExpandPrompt(s, wolf.id, 'P1：「今晚先襲擊P3。」');
  assert.ok(expand.includes('現實材料狀態'), 'expand 首夜仍帶材料狀態聲明');
  assert.ok(expand.includes('第一晚沒有任何公開發言或行為紀錄'), 'expand 沿用空板事實陳述');
  // 白天 pre_speech：材料全空（第一天且狼密談也無紀錄）時同樣帶聲明
  const dayPre = buildPreSpeechPrompt(s, aliveIds(s)[0]);
  assert.ok(dayPre.includes('現實材料狀態'), '白天 pre_speech 應含材料狀態聲明');
  assert.ok(dayPre.includes('第一晚沒有任何公開發言或行為紀錄'), '白天 pre_speech 同步新措辭');
});

test('防幻覺觀察：有討論材料後，prompt 不帶材料狀態聲明', () => {
  const s = discussionState();
  transition(s, { type: 'HUMAN_SPEAK', playerId: aliveIds(s)[0], text: '大家早安' });
  assert.ok(s.discussionLog.length > 0);
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  const pre = buildWolfPreSpeechPrompt(s, wolf.id);
  assert.ok(!pre.includes('現實材料狀態'), '有材料時不應帶空板聲明');
  const dayPre = buildPreSpeechPrompt(s, aliveIds(s)[0]);
  assert.ok(!dayPre.includes('現實材料狀態'), '白天 pre_speech 有材料時不應帶空板聲明');
});

test('非空板：狼 pre 附白天 feed；expand 帶延續版禁令', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  // 第1輪後白板非空：第2輪 pre 附白天 feed（grounding 內建於規則段）
  s.wolfDiscussionLog.push({ playerId: wolf.id, text: '先殺P5，直覺', day: s.day });
  const pre = buildWolfPreSpeechPrompt(s, wolf.id);
  assert.ok(!pre.includes('現實材料狀態'), '極簡 pre 不帶空板聲明');
  assert.ok(pre.includes('【白天討論】'), '非空板 pre 應附白天 feed');
  assert.ok(pre.includes('只能談你自己的狀態'), '規則段 grounding 常駐');
  const expand = buildWolfExpandPrompt(s, wolf.id, 'P1：「先殺P5，直覺。」');
  assert.ok(expand.includes('【討論紀錄使用規則】'), 'expand 非空板亦應帶延續版規則');
});

test('wolf_speech 任務指令：中性依據措辭、無行為描述範例', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  const prompt = buildPrompt(s, wolf.id, 'wolf_speech');
  assert.ok(!prompt.includes('話多可能是占卜師'), '應刪除描述對方行為的範例');
  assert.ok(prompt.includes('僅當討論紀錄中真有此依據時才可引用'), '依據引用應條件化');
  assert.ok(prompt.includes('誠實說直覺或隨機即可'), '無材料時應引導誠實理由');
  assert.ok(!prompt.includes('外圍編號'), '不應再提供編號位置類示例');
  // 狼 pre 已改極簡五段：共用骨架（見極簡五段測試）
  const pre = buildWolfPreSpeechPrompt(s, wolf.id);
  assert.ok(pre.includes('【遊戲規則】'), '極簡 pre 應含規則段');
  // 有材料：後夜附白天 feed
  s.wolfDiscussionLog.push({ playerId: wolf.id, text: '我覺得P5可疑', day: s.day });
  const pre2 = buildWolfPreSpeechPrompt(s, wolf.id);
  assert.ok(pre2.includes('【白天討論】'), '後夜應附白天 feed');
  assert.ok(pre2.includes('我覺得P5可疑') || pre2.includes('（今日尚無白天發言）'), '後夜討論段應就緒');
});

test('expand 潤飾約束：狼/白天 expand 均鎖定草稿目標與理由，只准調整語氣', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  const wolfExpand = buildWolfExpandPrompt(s, wolf.id, 'P1：「今晚先襲擊P3，直覺。」');
  assert.ok(wolfExpand.includes('不得新增草稿中沒有的任何內容'), '狼 expand 應禁止新增任何內容');
  assert.ok(wolfExpand.includes('理由、描述、觀察、感受都不行'), '狼 expand 應明確列舉禁止類型');
  assert.ok(wolfExpand.includes('直接沿用草稿原文'), '狼 expand 應允許沿用草稿');
  assert.ok(!wolfExpand.includes('說不上為什麼'), '狼 expand 不應含固定句式示例（防照搬）');
  const dayExpand = buildExpandPrompt(s, aliveIds(s)[0], 'P1：「我比較在意P3的說法。」');
  assert.ok(dayExpand.includes('草稿的核心論點不得改變'), '白天 expand 應鎖定核心論點');
  assert.ok(dayExpand.includes('不得新增草稿中沒有的理由或觀察'), '白天 expand 應禁止新增理由');
  assert.ok(dayExpand.includes('改寫成自然的口語發言'), '白天 expand 應要求口語化改寫');
});

test('狼 pre_speech 極簡五段＋預算', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  const pre = buildWolfPreSpeechPrompt(s, wolf.id);
  assert.ok(pre.includes('【遊戲規則】'), '應含規則段');
  assert.ok(pre.includes('【你的身份】'), '應含身份段');
  assert.ok(pre.includes('【你的個性】'), '應含個性段');
  assert.ok(pre.includes('【今晚的討論】'), '應含討論段');
  assert.ok(pre.includes('【輸出】'), '應含輸出段');
  assert.ok(pre.includes('同盟不能被襲擊'), '規則應含同盟禁令');
  assert.ok(pre.includes('平手以先提交者為準'), '規則應含多數決');
  assert.ok(pre.includes('[決定:殺P編號]'), '輸出應含殺P旗標選項');
  assert.ok(pre.includes('[決定:資訊不足]'), '輸出應含資訊不足選項');
  assert.ok(pre.length <= PRE_SPEECH_BUDGET, `極簡 prompt ${pre.length} 字元應 ≤ ${PRE_SPEECH_BUDGET}`);
});

test('狼個性一句話：三欄壓縮、無壓力台詞', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  const pre = buildWolfPreSpeechPrompt(s, wolf.id);
  assert.ok(pre.includes('懷疑度'), '個性應含懷疑度欄');
  assert.ok(pre.includes('拿主意'), '個性應含決策速度欄');
  assert.ok(!pre.includes('壓力台詞'), '個性不得載入壓力台詞');
  assert.ok(!pre.includes('口頭禪'), '個性不得載入口頭禪');
  assert.ok(!pre.includes('## 語言風格'), '不得載入人格原文區塊');
});

test('狼 expand 首夜後夜皆免旗標', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  const first = buildWolfExpandPrompt(s, wolf.id, 'P1：「今晚先襲擊P3。」');
  assert.ok(first.includes('【你的預發言草稿】P1：「今晚先襲擊P3。」 如果草稿已經夠自然'), '首夜附加段照抄（空格連接）');
  assert.ok(first.includes('本發言不需要附加決策旗標——目標沿用草稿，中控自行判讀。'), '首夜 expand 應免旗標');
  s.wolfDiscussionLog.push({ playerId: wolf.id, text: '先殺P5，直覺', day: s.day });
  const later = buildWolfExpandPrompt(s, wolf.id, 'P1：「先殺P5，直覺。」');
  assert.ok(later.includes('本發言不需要附加決策旗標——目標沿用草稿，中控自行判讀。'), '後夜 expand 亦應免旗標');
  assert.ok(later.includes('【討論紀錄使用規則】'), '後夜仍帶延續版規則');
});

test('狼後夜：五段骨架＋白天討論 feed', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  s.wolfDiscussionLog.push({ playerId: wolf.id, text: '先殺P5，直覺', day: s.day });
  const preEmpty = buildWolfPreSpeechPrompt(s, wolf.id);
  assert.ok(preEmpty.includes('【遊戲規則】'), '後夜亦用五段骨架');
  assert.ok(preEmpty.includes('【白天討論】'), '後夜應含白天討論段');
  assert.ok(preEmpty.includes('（今日尚無白天發言）'), '無白天發言時應填佔位');
  assert.ok(preEmpty.includes('先殺P5，直覺'), '討論段應含既有白板');
  const speaker = aliveIds(s)[0];
  s.discussionLog.push({ playerId: speaker, text: '我帶票投P5', day: s.day });
  const preFull = buildWolfPreSpeechPrompt(s, wolf.id);
  assert.ok(preFull.includes('我帶票投P5'), '白天段應含當天實際發言文本');
  assert.ok(preFull.includes('【輸出】'), '後夜亦含輸出段');
  assert.ok(preFull.length <= 4000, '後夜 prompt 應保持可控長度');
});
