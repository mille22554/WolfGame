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
  assert.ok(!prompt.includes('人格設定'), '草稿中性：不含人格設定');
  assert.ok(!prompt.includes('persona:'), '草稿中性：不含 agents.md 內容');
  assert.ok(prompt.includes('你的角色資訊'));
  assert.ok(prompt.includes('當天摘要'));
  assert.ok(prompt.includes('第0天摘要標記'));
  assert.ok(prompt.includes('最近討論'));
  assert.ok(prompt.includes('大家早安'));
  assert.ok(prompt.includes('預發言草稿'));
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
});

test('狼 prompt：要求指名具體目標、禁止討論無法得知的資訊', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  const pre = buildWolfPreSpeechPrompt(s, wolf.id);
  const expand = buildWolfExpandPrompt(s, wolf.id, 'P1：「今晚先襲擊P3。」');
  for (const prompt of [pre, expand]) {
    assert.ok(!prompt.includes('守衛可能保誰'), '不應引導討論無法得知的守衛動向');
    assert.ok(prompt.includes('指名'), '應要求指名具體目標');
    assert.ok(prompt.includes('同盟以外'), '應禁止殺同盟');
    assert.ok(prompt.includes('繁體中文'), '應要求繁體中文');
  }
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
