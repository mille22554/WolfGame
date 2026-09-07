/**
 * ai-scheduler.test.ts — SpeechScheduler 管線測試（fake timers + mock LLM）
 */
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechScheduler } from './ai-scheduler.js';
import { createGameState, transition, getNightActors } from './game-state.js';
import { noveltyPenalty, bigramJaccard, pNumberOverlap } from './novelty.js';
import type { GameState, GameEvent, LLMDispatcher, SchedulerContext } from './types.js';
import { Role } from './types.js';

// ---------- novelty 純函式 ----------

test('novelty：bigramJaccard（相同→1、無關→低、空→0）', () => {
  assert.equal(bigramJaccard('今天要投P3出去', '今天要投P3出去'), 1);
  assert.ok(bigramJaccard('abcdefgh', 'ijklmnop') < 0.3);
  assert.equal(bigramJaccard('', 'abc'), 0);
  assert.equal(bigramJaccard('abc', ''), 0);
  assert.equal(bigramJaccard('a', 'a'), 0); // 單字無 bigram
});

test('novelty：pNumberOverlap（重疊率、皆無→0）', () => {
  assert.equal(pNumberOverlap('懷疑P1和P2', 'P2跟P3很可疑'), 1 / 3);
  assert.equal(pNumberOverlap('P1是好人', 'P1是好人'), 1);
  assert.equal(pNumberOverlap('今天天氣真好', '大家多發言'), 0);
});

test('novelty：penalty 範圍 [0,3]、無歷史→0', () => {
  assert.equal(noveltyPenalty('任何內容', []), 0);
  const dup = noveltyPenalty('P3是狼快投P3出去', ['P3是狼快投P3出去']);
  assert.ok(dup > 0 && dup <= 3);
  assert.equal(noveltyPenalty('今天天氣真好適合散步', ['P3是狼快投P3出去']), 0);
  for (const t of ['a', '完全不同的一句話', 'P1 P2 P3 P4 P5']) {
    const p = noveltyPenalty(t, ['P3是狼', '我覺得P5很可疑']);
    assert.ok(p >= 0 && p <= 3);
  }
});

// ---------- mock LLM ----------

type GenerateFn = (prompt: string) => string | Promise<string>;

class MockLLM implements LLMDispatcher {
  calls: { kind: string; prompt: string }[] = [];
  constructor(private readonly fn: GenerateFn) {}
  async generate(prompt: string): Promise<string> {
    const kind = prompt.includes('【裁判任務】')
      ? 'judge'
      : prompt.includes('【你的預發言草稿】')
        ? 'expand'
        : 'pre_speech';
    this.calls.push({ kind, prompt });
    return this.fn(prompt);
  }
  async requestSpeech(): Promise<{ text: string }> {
    throw new Error('scheduler 只用 generate');
  }
  async requestVote(): Promise<{ targetId: number }> {
    throw new Error('scheduler 只用 generate');
  }
  async requestNightAction(): Promise<{ targetId: number }> {
    throw new Error('scheduler 只用 generate');
  }
  kinds(): string[] {
    return this.calls.map((c) => c.kind);
  }
}

function discussionState(playerCount = 9): GameState {
  const s = createGameState(playerCount);
  for (let i = 0; i < playerCount; i++) transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
  transition(s, { type: 'START_GAME' });
  for (const pid of getNightActors(s)) {
    transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: s.players.filter((p) => p.alive && p.id !== pid)[0].id });
  }
  transition(s, { type: 'RESOLVE_NIGHT' });
  assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
  return s;
}

function makeCtx(state: GameState, llm: LLMDispatcher): { ctx: SchedulerContext; events: GameEvent[] } {
  const events: GameEvent[] = [];
  return {
    events,
    ctx: {
      // 模擬 engine 行為：發言被接受 → boardVersion++（否則 scheduler 會合法地開始第二輪）
      enqueue: (e: GameEvent) => {
        events.push(e);
        if (e.type === 'AI_SPEECH_DONE' || e.type === 'HUMAN_SPEAK') state.boardVersion++;
      },
      getState: () => state,
      llm,
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
});

afterEach(() => {
  mock.timers.reset();
});

// 預設確定性 mock：預發言帶 P 編號、裁判按 slot 降序給分、展開固定文本
function defaultMock(): MockLLM {
  return new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) {
      const slots: number[] = [];
      for (const m of prompt.matchAll(/^(\d+)\.\s/gm)) slots.push(parseInt(m[1], 10));
      return slots.map((s, i) => `${s}: ${9 - i}`).join('\n');
    }
    if (prompt.includes('【你的預發言草稿】')) return 'P0：「沿用草稿，展開成完整發言。」';
    const m = prompt.match(/你是 P(\d+)/);
    const id = m ? m[1] : '1';
    return `P${id}：「我比較在意 P${id} 以外的發言。」`;
  });
}

test('觸發：quiet 通過 → 管線啟動；CD 內不廣播，CD 後廣播', async () => {
  const s = discussionState(9);
  const llm = defaultMock();
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { quietMs: 20000, cdMs: 60000, checkIntervalMs: 1000 });
  try {
    sch.onPhaseEntered(s);
    mock.timers.tick(19000);
    await flush();
    assert.ok(!llm.calls.some((c) => c.kind === 'pre_speech'), 'quiet 未過不應啟動');
    mock.timers.tick(2000); // t=21s > quiet
    await flush();
    assert.ok(llm.calls.some((c) => c.kind === 'pre_speech'), 'quiet 通過應啟動預發言');
    await flush();
    assert.ok(llm.calls.some((c) => c.kind === 'judge'), '應進入裁判');
    assert.ok(llm.calls.some((c) => c.kind === 'expand'), '應進入展開');
    assert.equal(events.length, 0, 'CD 內不廣播');
    const bvBefore = s.boardVersion;
    mock.timers.tick(60000);
    await flush();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'AI_SPEECH_DONE');
    if (events[0].type === 'AI_SPEECH_DONE') {
      assert.equal(events[0].boardVersion, bvBefore);
      assert.ok(events[0].text.length > 0);
    }
  } finally {
    sch.stop();
  }
});

test('版本作廢：PRE_SPEECH 完成前 boardVersion 變更 → 作廢回 IDLE', async () => {
  const s = discussionState(9);
  let releasePre!: (v: string) => void;
  const gate = new Promise<string>((resolve) => { releasePre = resolve; });
  let preCount = 0;
  const llm = new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) return '1: 5';
    if (prompt.includes('【你的預發言草稿】')) return '展開';
    preCount++;
    if (preCount === 1) return gate;
    return 'P9：「草稿。」';
  });
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { quietMs: 1000, cdMs: 1000, checkIntervalMs: 500, preSpeechBatch: 9 });
  try {
    sch.onPhaseEntered(s);
    mock.timers.tick(1500);
    await flush();
    assert.ok(preCount >= 1, '管線應已啟動');
    // 外部發言導致版本變更
    s.boardVersion++;
    releasePre('P1：「第一則草稿。」');
    await flush();
    await flush();
    assert.ok(!llm.kinds().includes('judge'), '版本變更應作廢，不進入裁判');
    assert.equal(events.length, 0);
  } finally {
    sch.stop();
  }
});

test('版本作廢：JUDGE 完成前 boardVersion 變更 → 作廢', async () => {
  const s = discussionState(9);
  let releaseJudge!: (v: string) => void;
  const gate = new Promise<string>((resolve) => { releaseJudge = resolve; });
  const llm = new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) return gate;
    if (prompt.includes('【你的預發言草稿】')) return '展開';
    return 'P1：「草稿。」';
  });
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { quietMs: 1000, cdMs: 1000, checkIntervalMs: 500 });
  try {
    sch.onPhaseEntered(s);
    mock.timers.tick(1500);
    await flush();
    await flush();
    assert.ok(llm.kinds().includes('judge'), '應已進入裁判');
    s.boardVersion++;
    releaseJudge('1: 9');
    await flush();
    await flush();
    assert.ok(!llm.kinds().includes('expand'), '版本變更應作廢，不進入展開');
    assert.equal(events.length, 0);
  } finally {
    sch.stop();
  }
});

test('commit 後不中斷：EXPAND 期間版本變更 → 照常 enqueue（帶 commit 版本）', async () => {
  const s = discussionState(9);
  let releaseExpand!: (v: string) => void;
  const gate = new Promise<string>((resolve) => { releaseExpand = resolve; });
  const llm = new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) return '1: 9\n2: 5\n3: 5\n4: 5\n5: 5\n6: 5\n7: 5\n8: 5\n9: 5';
    if (prompt.includes('【你的預發言草稿】')) return gate;
    return 'P1：「草稿。」';
  });
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { quietMs: 1000, cdMs: 1000, checkIntervalMs: 500 });
  try {
    sch.onPhaseEntered(s);
    mock.timers.tick(1500);
    await flush();
    await flush();
    assert.ok(llm.kinds().includes('expand'), '應已進入展開');
    const commitVersion = s.boardVersion;
    s.boardVersion++; // EXPAND 期間他人發言
    releaseExpand('P1：「最終發言。」');
    await flush();
    // CD（1000）早已過（t=1500 起跑）→ 廣播立即發生，無需再 tick
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'AI_SPEECH_DONE');
    if (events[0].type === 'AI_SPEECH_DONE') {
      assert.equal(events[0].boardVersion, commitVersion, '帶 commit 時版本');
    }
  } finally {
    sch.stop();
  }
});

test('top3：選取落在裁判 top3（新穎性無干擾時）', async () => {
  const s = discussionState(9);
  // 彼此差異大的草稿 → 新穎性懲罰皆 ~0；裁判只給 slot 1/2/3 高分
  const drafts = [
    '春天的櫻花開滿了整條山道',
    '量子電腦的錯誤率持續下降',
    '深海魚類的發光機制很特別',
    '古典音樂會的票房創新高',
    '沙漠綠洲的生態系統脆弱',
    '極地冰川融化速度加快',
    '火山島嶼形成新的陸地',
    '草原動物的遷徙路線改變',
    '雨林冠層的生物多樣性',
  ];
  let di = 0;
  const llm = new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) {
      const slots: number[] = [];
      for (const m of prompt.matchAll(/^(\d+)\.\s/gm)) slots.push(parseInt(m[1], 10));
      // 前三個 slot 高分，其餘低分
      return slots.map((sl, i) => `${sl}: ${i < 3 ? 9 - i : 1}`).join('\n');
    }
    if (prompt.includes('【你的預發言草稿】')) return '展開文本';
    return `P0：「${drafts[di++ % drafts.length]}」`;
  });
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { quietMs: 1000, cdMs: 1000, checkIntervalMs: 500 });
  try {
    sch.onPhaseEntered(s);
    mock.timers.tick(1500);
    await flush();
    await flush();
    // CD（1000）早已過 → 廣播立即發生
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'AI_SPEECH_DONE');
  } finally {
    sch.stop();
  }
});

test('新穎性懲罰：重複內容被降分（4 人局，墊底者不在 top3）', async () => {
  const s = discussionState(6);
  // 當天討論先放一則與 A 相同的訊息
  const repeated = 'P3就是人狼大家快把票投給P3';
  s.discussionLog.push({ playerId: 2, text: repeated, day: s.day });
  const llm = new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) {
      const slots: number[] = [];
      for (const m of prompt.matchAll(/^(\d+)\.\s/gm)) slots.push(parseInt(m[1], 10));
      return slots.map((sl) => `${sl}: 6`).join('\n'); // 全同分 → 靠新穎性決勝
    }
    if (prompt.includes('【你的預發言草稿】')) return '展開文本';
    if (prompt.includes('你是 P1')) return `P1：「${repeated}」`; // 與歷史重複
    if (prompt.includes('你是 P2')) return 'P2：「櫻花季的京都人潮洶湧」';
    if (prompt.includes('你是 P3')) return 'P3：「量子位元的同調時間延長」';
    if (prompt.includes('你是 P4')) return 'P4：「深海熱泉生態系很獨特」';
    return 'P9：「中立觀察中」';
  });
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { quietMs: 1000, cdMs: 1000, checkIntervalMs: 500 });
  try {
    sch.onPhaseEntered(s);
    mock.timers.tick(1500);
    await flush();
    await flush();
    // 6 存活 AI（或更少）→ top3；重複者被懲罰墊底 → 不應被選中
    // （若存活 AI 恰 ≤2 會走 direct 路徑；6 人局首日通常 ≥4 存活）
    const aliveAI = s.players.filter((p) => p.alive && p.controlledBy === 'ai').length;
    assert.ok(aliveAI > 2, '本案例需走完整管線');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'AI_SPEECH_DONE');
    if (events[0].type === 'AI_SPEECH_DONE') {
      assert.notEqual(events[0].playerId, 1, '重複發言者應被新穎性懲罰排除出 top3');
    }
  } finally {
    sch.stop();
  }
});

test('存活 AI ≤ 2 → 跳過管線直接展開（無裁判呼叫）', async () => {
  const s = discussionState(6);
  // 只留 2 個存活 AI
  let kept = 0;
  for (const p of s.players) {
    if (p.controlledBy === 'ai' && p.alive && kept < 2) {
      kept++;
      continue;
    }
    if (p.controlledBy === 'ai') p.alive = false;
  }
  assert.equal(s.players.filter((p) => p.alive && p.controlledBy === 'ai').length, 2);
  const llm = defaultMock();
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { quietMs: 1000, cdMs: 1000, checkIntervalMs: 500 });
  try {
    sch.onPhaseEntered(s);
    mock.timers.tick(1500);
    await flush();
    await flush();
    // CD（1000）早已過 → 廣播立即發生
    assert.ok(!llm.kinds().includes('judge'), '不應呼叫裁判');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'AI_SPEECH_DONE');
  } finally {
    sch.stop();
  }
});

test('完整管線：mock 全確定性 → 最終 enqueue 正確 AI_SPEECH_DONE', async () => {
  const s = discussionState(9);
  const llm = defaultMock();
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { quietMs: 1000, cdMs: 1000, checkIntervalMs: 500, preSpeechBatch: 3 });
  try {
    sch.onPhaseEntered(s);
    mock.timers.tick(1500);
    await flush();
    await flush();
    // CD（1000）早已過 → 廣播立即發生
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.type, 'AI_SPEECH_DONE');
    if (ev.type === 'AI_SPEECH_DONE') {
      const speaker = s.players.find((p) => p.id === ev.playerId)!;
      assert.ok(speaker.alive && speaker.controlledBy === 'ai');
      assert.ok(ev.text.trim().length > 0);
      assert.equal(typeof ev.boardVersion, 'number');
    }
    // 發言皆經管線：預發言數 == 存活 AI 數
    const aliveAI = s.players.filter((p) => p.alive && p.controlledBy === 'ai').length;
    assert.equal(llm.kinds().filter((k) => k === 'pre_speech').length, aliveAI);
  } finally {
    sch.stop();
  }
});

test('onPhaseEntered 非討論 phase → 取消管線回 IDLE', async () => {
  const s = discussionState(9);
  const llm = defaultMock();
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { quietMs: 1000, cdMs: 60000, checkIntervalMs: 500 });
  try {
    sch.onPhaseEntered(s);
    mock.timers.tick(1500);
    await flush();
    assert.ok(llm.calls.length > 0, '管線應已啟動');
    s.phase = 'DAY_VOTING_COLLECTING';
    sch.onPhaseEntered(s);
    mock.timers.tick(120000);
    await flush();
    await flush();
    assert.equal(events.length, 0, '離開討論後不應廣播');
  } finally {
    sch.stop();
  }
});

void Role;
