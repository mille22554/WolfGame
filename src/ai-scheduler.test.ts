/**
 * ai-scheduler.test.ts — SpeechScheduler 管線測試（fake timers + mock LLM）
 * 白板更新驅動迴圈＋決策 flag 收斂（第 1、2 項新語義）
 */
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SpeechScheduler, parseDecisionFlag, stripDecisionFlags, normalizeTraditional, MAX_UNCERTAIN_ROUNDS,
} from './ai-scheduler.js';
import { createGameState, transition, getNightActors, stripSpeechPrefix } from './game-state.js';
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
  calls: { kind: string; prompt: string; config?: { temperature?: number; maxTokens?: number } }[] = [];
  constructor(private readonly fn: GenerateFn) {}
  async generate(prompt: string, config?: { temperature?: number; maxTokens?: number }): Promise<string> {
    const kind = prompt.includes('【裁判任務】')
      ? 'judge'
      : prompt.includes('【你的預發言草稿】')
        ? 'expand'
        : 'pre_speech';
    this.calls.push({ kind, prompt, config });
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

function discussionState(playerCount = 9): GameState {
  const s = createGameState(playerCount);
  for (let i = 0; i < playerCount; i++) transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
  transition(s, { type: 'START_GAME' });
  convergeWolfDiscussion(s);
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
      // 模擬 engine 行為：發言被接受 → log 落子＋boardVersion++；ready → voteReady
      // （engine 另會呼叫 onBoardUpdated，測試內手動呼叫以保確定性）
      // 保真要點：production 的 transition 會 stripSpeechPrefix，這裡同樣剝離，
      // 否則播出確認比對（lastEntry.text === s.text）永遠成功，測不到前綴相關 bug
      enqueue: (e: GameEvent) => {
        events.push(e);
        if (e.type === 'AI_SPEECH_DONE') {
          state.discussionLog.push({ playerId: e.playerId, text: stripSpeechPrefix(e.text), day: state.day });
          state.boardVersion++;
        }
        if (e.type === 'AI_READY_VOTE' && !state.voteReady.includes(e.playerId)) {
          state.voteReady.push(e.playerId);
        }
        if (e.type === 'AI_WOLF_SPEECH_DONE') {
          state.wolfDiscussionLog.push({ playerId: e.playerId, text: stripSpeechPrefix(e.text), day: state.day });
          state.boardVersion++;
        }
        if (e.type === 'AI_WOLF_READY' && !state.wolfReady.includes(e.playerId)) {
          state.wolfReady.push(e.playerId);
        }
        if (e.type === 'HUMAN_SPEAK') state.boardVersion++;
      },
      getState: () => state,
      llm,
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushN(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await flush();
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
});

afterEach(() => {
  mock.timers.reset();
});

// 預設確定性 mock：預發言帶正規 decided flag、裁判按 slot 降序給分、展開固定文本
function judgeBySlotDesc(prompt: string): string {
  const slots: number[] = [];
  for (const m of prompt.matchAll(/^(\d+)\.\s/gm)) slots.push(parseInt(m[1], 10));
  return slots.map((s, i) => `${s}: ${9 - i}`).join('\n');
}

function defaultMock(): MockLLM {
  return new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) return judgeBySlotDesc(prompt);
    if (prompt.includes('【你的預發言草稿】')) return 'P0：「沿用草稿，展開成完整發言。」';
    const m = prompt.match(/你是 P(\d+)/);
    const id = m ? m[1] : '1';
    return `P${id}：「我比較在意 P${id} 以外的發言。」\n[決定:棄票]`;
  });
}

// 不確定 mock：預發言無 flag（僅不確定語氣）→ 走安全閥路徑
function uncertainMock(): MockLLM {
  return new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) return judgeBySlotDesc(prompt);
    if (prompt.includes('【你的預發言草稿】')) return 'P0：「還在觀察，展開成完整發言。」';
    const m = prompt.match(/你是 P(\d+)/);
    const id = m ? m[1] : '1';
    return `P${id}：「資訊還不足，我無法決定，想再聽聽大家的說法。」`;
  });
}

// ---------- flag 兩層解析 ----------

test('flag 正規解析：投Pn／棄票／資訊不足（全形冒號亦收）', () => {
  assert.deepEqual(parseDecisionFlag('草稿內容\n[決定:投P3]'), { status: 'decided', target: 3 });
  assert.deepEqual(parseDecisionFlag('草稿內容\n[決定：投P12]'), { status: 'decided', target: 12 });
  assert.deepEqual(parseDecisionFlag('草稿\n[決定:棄票]'), { status: 'decided', target: 'abstain' });
  assert.deepEqual(parseDecisionFlag('草稿\n[決定:資訊不足]'), { status: 'uncertain' });
  assert.deepEqual(parseDecisionFlag('草稿\n[決定:殺P3]'), { status: 'decided', target: 3 });
});

test('flag 寬鬆解析：決策語境關鍵字認 decided；不確定類詞認 uncertain；都不中才 uncertain', () => {
  assert.deepEqual(parseDecisionFlag('我想了很久，我投P2'), { status: 'decided', target: 2 });
  assert.deepEqual(parseDecisionFlag('我決定投 P5 吧'), { status: 'decided', target: 5 });
  assert.deepEqual(parseDecisionFlag('這一票要投P7'), { status: 'decided', target: 7 });
  assert.deepEqual(parseDecisionFlag('我決定殺P5'), { status: 'decided', target: 5 });
  assert.deepEqual(parseDecisionFlag('我決定棄票好了'), { status: 'decided', target: 'abstain' });
  assert.deepEqual(parseDecisionFlag('資訊不足，還想再觀察'), { status: 'uncertain' });
  assert.deepEqual(parseDecisionFlag('今天天氣真好'), { status: 'uncertain' });
  // 討論提及（無決策動詞）不誤判為 decided
  assert.deepEqual(parseDecisionFlag('P3 很可疑，大家怎麼看'), { status: 'uncertain' });
});

test('flag 剝離：全域匹配（中置殘留亦清）；解析取最後一個', () => {
  assert.equal(stripDecisionFlags('A[決定:投P3]B\n[決定:棄票]C'), 'AB\nC');
  assert.deepEqual(parseDecisionFlag('前言[決定:投P3]結論[決定:棄票]'), { status: 'decided', target: 'abstain' });
  assert.ok(!stripDecisionFlags('發言\n[決定:投P3]').includes('[決定'));
  // 無方括號裸 flag 整行亦剝離（模型漏寫括號時防白板污染）；句中提及保留
  assert.equal(stripDecisionFlags('發言\n決定:資訊不足\n下一句'), '發言\n下一句');
  assert.equal(stripDecisionFlags('發言\n決定：殺P5  \n下一句'), '發言\n下一句');
  assert.equal(stripDecisionFlags('我決定投P3出去'), '我決定投P3出去');
});

test('flag 寬鬆解析：該殺／先殺亦認 decided（首夜常見說法）', () => {
  assert.deepEqual(parseDecisionFlag('我覺得今晚該殺P12'), { status: 'decided', target: 12 });
  assert.deepEqual(parseDecisionFlag('今晚先殺P5吧'), { status: 'decided', target: 5 });
});

test('簡轉繁正規化：遊戲高頻簡體字映射＋冪等', () => {
  assert.equal(normalizeTraditional('直覺說杀P5'), '直覺說殺P5');
  assert.equal(normalizeTraditional('P5不太对劲，先观察'), 'P5不太對勁，先觀察');
  assert.equal(normalizeTraditional('我懷疑他，有证据吗？派他去臥底保护我方'), '我懷疑他，有證據嗎？派他去臥底保護我方');
  assert.equal(normalizeTraditional('已經是繁體：殺P5、對話'), '已經是繁體：殺P5、對話');
  assert.equal(normalizeTraditional(''), '');
  // 只收無歧義字：只/面/里等多音多義字不動
  assert.equal(normalizeTraditional('只有裡面有只貓'), '只有裡面有只貓');
});

test('安全閥常數：MAX_UNCERTAIN_ROUNDS = 50', () => {
  assert.equal(MAX_UNCERTAIN_ROUNDS, 50);
});

// ---------- 白板更新驅動迴圈 ----------

test('迴圈：進場即開工；生產完成暫存（CD 內不播）；CD 到有貨播出＋decided 發言成功後 enqueue ready', async () => {
  const s = discussionState(9);
  const llm = defaultMock();
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    assert.ok(llm.calls.some((c) => c.kind === 'pre_speech'), '進場即開工生產');
    assert.ok(llm.calls.some((c) => c.kind === 'judge'), '應進入裁判');
    assert.ok(llm.calls.some((c) => c.kind === 'expand'), '應進入展開');
    assert.ok(sch.stashForTest(), '生產完成應暫存');
    assert.equal(events.length, 0, 'CD 內不廣播');
    const bvBefore = s.boardVersion;
    mock.timers.tick(60000);
    await flush();
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'AI_SPEECH_DONE');
    assert.equal(events[1].type, 'AI_READY_VOTE');
    if (events[0].type === 'AI_SPEECH_DONE') {
      assert.equal(events[0].boardVersion, bvBefore);
      assert.ok(events[0].text.length > 0);
      assert.ok(!events[0].text.includes('[決定'), 'flag 永不進白板');
    }
    if (events[1].type === 'AI_READY_VOTE') {
      assert.ok(!('boardVersion' in events[1]), 'AI_READY_VOTE 不帶版本');
    }
  } finally {
    sch.stop();
  }
});

test('純 AI 局 CD=0：做好就播（計時器保留）', async () => {
  const s = discussionState(9);   // CLIENT_JOIN 全員 AI
  assert.ok(!s.players.some((p) => p.controlledBy === 'human'));
  const llm = defaultMock();
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    assert.ok(sch.stashForTest(), '生產完成暫存');
    assert.equal(events.length, 0);
    mock.timers.tick(1);   // CD=0，滴答即到
    await flush();
    assert.equal(events[0].type, 'AI_SPEECH_DONE');
  } finally {
    sch.stop();
  }
});

test('中間更新→暫存作廢＋重跑＋CD 重啟：PRE_SPEECH 完成前版本變更 → 舊生產作廢，新生產用新白板跑完播出', async () => {
  const s = discussionState(9);
  let releasePre!: (v: string) => void;
  const gate = new Promise<string>((resolve) => { releasePre = resolve; });
  let preCount = 0;
  const llm = new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) return judgeBySlotDesc(prompt);
    if (prompt.includes('【你的預發言草稿】')) return '展開文本';
    preCount++;
    if (preCount === 1) return gate;
    const m = prompt.match(/你是 P(\d+)/);
    return `P${m ? m[1] : '9'}：「草稿。」\n[決定:棄票]`;
  });
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 60000, preSpeechBatch: 9 });
  try {
    sch.onPhaseEntered(s);
    await flush();
    assert.ok(preCount >= 1, '管線應已啟動');
    // 中間白板更新（模擬 engine：log 落子＋版本++，再通知 scheduler）
    s.discussionLog.push({ playerId: 1, text: '真人發言', day: s.day });
    s.boardVersion++;
    const newVersion = s.boardVersion;
    sch.onBoardUpdated(s);
    await flush();
    assert.ok(preCount > 1, '應以新白板重跑生產');
    releasePre('P1：「第一則草稿。」\n[決定:棄票]');
    await flushN(3);
    // 舊生產作廢：暫存應為新一輪產物；CD 已重啟 → tick 滿才播
    assert.ok(sch.stashForTest(), '新一輪應完成暫存');
    assert.equal(events.length, 0, 'CD 重啟後未滿不播');
    mock.timers.tick(60000);
    await flush();
    assert.ok(events.some((e) => e.type === 'AI_SPEECH_DONE'), 'CD 到有貨播出');
    const speech = events.find((e) => e.type === 'AI_SPEECH_DONE')!;
    if (speech.type === 'AI_SPEECH_DONE') {
      assert.equal(speech.boardVersion, newVersion, '新一輪帶新版本');
    }
  } finally {
    sch.stop();
  }
});

test('版本作廢：JUDGE 完成前 boardVersion 變更 → 舊生產作廢，新生產用新白板跑完播出', async () => {
  const s = discussionState(9);
  let releaseJudge!: (v: string) => void;
  const gate = new Promise<string>((resolve) => { releaseJudge = resolve; });
  let judgeCalls = 0;
  const llm = new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) {
      judgeCalls++;
      return judgeCalls === 1 ? gate : judgeBySlotDesc(prompt);
    }
    if (prompt.includes('【你的預發言草稿】')) return '展開文本';
    const m = prompt.match(/你是 P(\d+)/);
    return `P${m ? m[1] : '1'}：「草稿。」\n[決定:棄票]`;
  });
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(2);
    assert.ok(llm.kinds().includes('judge'), '應已進入裁判');
    s.boardVersion++;
    const newVersion = s.boardVersion;
    sch.onBoardUpdated(s);
    releaseJudge('1: 9');
    await flushN(4);
    // 舊生產作廢；新生產跑完 → 暫存帶新版本；CD 未滿不播
    const stash = sch.stashForTest();
    assert.ok(stash, '新一輪應完成暫存');
    assert.equal(stash!.boardVersion, newVersion);
    assert.equal(events.length, 0);
    mock.timers.tick(1000);
    await flush();
    const speech = events.find((e) => e.type === 'AI_SPEECH_DONE')!;
    assert.equal(speech.type, 'AI_SPEECH_DONE');
    if (speech.type === 'AI_SPEECH_DONE') {
      assert.equal(speech.boardVersion, newVersion, '播出帶新版本');
    }
  } finally {
    sch.stop();
  }
});

test('版本作廢：EXPAND 期間版本變更 → 作廢不播出（中間更新即重跑，無 commit 後不中斷）', async () => {
  const s = discussionState(9);
  let releaseExpand!: (v: string) => void;
  const gate = new Promise<string>((resolve) => { releaseExpand = resolve; });
  const llm = new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) return judgeBySlotDesc(prompt);
    if (prompt.includes('【你的預發言草稿】')) return gate;
    return 'P1：「草稿。」\n[決定:棄票]';
  });
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    assert.ok(llm.kinds().includes('expand'), '應已進入展開');
    s.boardVersion++;
    sch.onBoardUpdated(s);
    releaseExpand('P1：「最終發言。」');
    await flushN(3);
    assert.ok(!events.some((e) => e.type === 'AI_SPEECH_DONE'), '舊展開作廢不播出');
  } finally {
    sch.stop();
  }
});

test('CD 到沒貨 → 等做好馬上播（無需再等一個 CD）', async () => {
  const s = discussionState(9);
  let releaseExpand!: (v: string) => void;
  const gate = new Promise<string>((resolve) => { releaseExpand = resolve; });
  const llm = new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) return judgeBySlotDesc(prompt);
    if (prompt.includes('【你的預發言草稿】')) return gate;
    const m = prompt.match(/你是 P(\d+)/);
    return `P${m ? m[1] : '1'}：「草稿。」\n[決定:棄票]`;
  });
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    assert.ok(llm.kinds().includes('expand'), '生產卡在展開');
    mock.timers.tick(1500);   // CD 到但沒貨
    await flush();
    assert.equal(events.length, 0, '沒貨不播');
    releaseExpand('P1：「最終發言。」');
    await flushN(2);
    assert.ok(events.some((e) => e.type === 'AI_SPEECH_DONE'), '做好馬上播');
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
  const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    mock.timers.tick(1000);   // CD 到有貨播出
    await flush();
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
  const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    mock.timers.tick(1000);
    await flush();
    // 6 存活 AI → top3；重複者被懲罰墊底 → 不應被選中（人數無關，一律完整管線）
    const aliveAI = s.players.filter((p) => p.alive && p.controlledBy === 'ai').length;
    assert.ok(aliveAI > 2, '本案例需多候選人管線');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'AI_SPEECH_DONE');
    if (events[0].type === 'AI_SPEECH_DONE') {
      assert.notEqual(events[0].playerId, 1, '重複發言者應被新穎性懲罰排除出 top3');
    }
  } finally {
    sch.stop();
  }
});

test('管線裁剪：草稿 ≤3 跳過 judge（直接展開照播）；4 草稿以上仍跑裁判', async () => {
  // 2 候選人 → 跳過 judge
  const s = discussionState(6);
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
  const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    mock.timers.tick(1000);
    await flush();
    assert.ok(!llm.kinds().includes('judge'), '2 草稿應跳過裁判');
    assert.ok(llm.kinds().includes('expand'), '仍應展開');
    assert.equal(events[0].type, 'AI_SPEECH_DONE');
    assert.equal(events[1].type, 'AI_READY_VOTE');
  } finally {
    sch.stop();
  }
  // 4 候選人 → 跑裁判
  const s2 = discussionState(6);
  let kept2 = 0;
  for (const p of s2.players) {
    if (p.controlledBy === 'ai' && p.alive && kept2 < 4) {
      kept2++;
      continue;
    }
    if (p.controlledBy === 'ai') p.alive = false;
  }
  assert.equal(s2.players.filter((p) => p.alive && p.controlledBy === 'ai').length, 4);
  const llm2 = defaultMock();
  const { ctx: ctx2, events: events2 } = makeCtx(s2, llm2);
  const sch2 = new SpeechScheduler(ctx2, { cdMs: 1000 });
  try {
    sch2.onPhaseEntered(s2);
    await flushN(3);
    mock.timers.tick(1000);
    await flush();
    assert.ok(llm2.kinds().includes('judge'), '4 草稿應跑裁判');
    assert.equal(events2[0].type, 'AI_SPEECH_DONE');
  } finally {
    sch2.stop();
  }
});

test('管線裁剪：maxTokens judge=200、expand=100、pre_speech=100', async () => {
  const s = discussionState(9);
  const llm = defaultMock();
  const { ctx } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    mock.timers.tick(1000);
    await flush();
    const cfgs = new Map(llm.calls.map((c) => [c.kind, c.config?.maxTokens]));
    assert.equal(cfgs.get('pre_speech'), 100);
    assert.equal(cfgs.get('judge'), 200);
    assert.equal(cfgs.get('expand'), 100);
  } finally {
    sch.stop();
  }
});

test('完整管線：mock 全確定性 → 最終 enqueue 正確 AI_SPEECH_DONE', async () => {
  const s = discussionState(9);
  const llm = defaultMock();
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 1000, preSpeechBatch: 3 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    mock.timers.tick(1000);
    await flush();
    const ev = events[0];
    assert.equal(ev.type, 'AI_SPEECH_DONE');
    if (ev.type === 'AI_SPEECH_DONE') {
      const speaker = s.players.find((p) => p.id === ev.playerId)!;
      assert.ok(speaker.alive && speaker.controlledBy === 'ai');
      assert.ok(ev.text.trim().length > 0);
      assert.equal(typeof ev.boardVersion, 'number');
    }
    // 發言皆經管線：預發言數 == 存活 AI 數（首輪無上輪發言者，全員草稿）
    const aliveAI = s.players.filter((p) => p.alive && p.controlledBy === 'ai').length;
    assert.equal(llm.kinds().filter((k) => k === 'pre_speech').length, aliveAI);
  } finally {
    sch.stop();
  }
});

test('onPhaseEntered 非討論 phase → 取消管線（不播出、不暫存）', async () => {
  const s = discussionState(9);
  const llm = defaultMock();
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
  try {
    sch.onPhaseEntered(s);
    await flush();
    assert.ok(llm.calls.length > 0, '管線應已啟動');
    s.phase = 'DAY_VOTING_COLLECTING';
    sch.onPhaseEntered(s);
    mock.timers.tick(120000);
    await flushN(2);
    assert.equal(events.length, 0, '離開討論後不應廣播');
    assert.equal(sch.stashForTest(), null);
  } finally {
    sch.stop();
  }
});

test('除上輪發言者外全員草稿：上輪發言者不列入候選；真人不寫草稿', async () => {
  const s = mixedDiscussionState();
  const aliveAI = s.players.filter((p) => p.alive && p.controlledBy === 'ai').map((p) => p.id);
  // 上輪發言者為某 AI
  const lastAI = aliveAI[0];
  s.discussionLog.push({ playerId: lastAI, text: '上一輪發言', day: s.day });
  const llm = defaultMock();
  const { ctx } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    const pres = llm.calls.filter((c) => c.kind === 'pre_speech').map((c) => {
      const m = c.prompt.match(/你是 P(\d+)/);
      return m ? parseInt(m[1], 10) : -1;
    });
    assert.ok(!pres.includes(lastAI), '上輪發言者不應寫草稿');
    for (const id of aliveAI) {
      if (id === lastAI) continue;
      assert.ok(pres.includes(id), `存活 AI P${id} 應寫草稿`);
    }
    // 真人座位絕不出現於草稿 prompt
    for (const h of s.players.filter((p) => p.alive && p.controlledBy === 'human').map((p) => p.id)) {
      assert.ok(!pres.includes(h), `真人 P${h} 不寫草稿`);
    }
  } finally {
    sch.stop();
  }
});

test('唯一候選不斷線：僅剩一人時即使是上輪發言者也繼續（防僵局）', async () => {
  const s = discussionState(6);
  const lone = s.players.filter((p) => p.alive && p.controlledBy === 'ai')[0].id;
  for (const p of s.players) {
    if (p.id !== lone) p.alive = false;
  }
  s.discussionLog.push({ playerId: lone, text: '只剩我一人', day: s.day });
  const llm = defaultMock();
  const { ctx } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(2);
    mock.timers.tick(5000);
    await flush();
    // 唯一候選不斷線：即使是上輪發言者也繼續生產（否則無人能推進白板，永久僵局；
    // 實戰中此態極少見，且 decided 草稿播出後即 ready 離場，不會無限自言自語）
    assert.ok(llm.calls.some((c) => c.kind === 'pre_speech'), '唯一候選應繼續生產');
  } finally {
    sch.stop();
  }
});

test('已就緒者排除候選：ready 的 AI 不再寫草稿（降噪加速收斂）', async () => {
  const s = discussionState(9);
  const readyAI = s.players.filter((p) => p.alive && p.controlledBy === 'ai')[0].id;
  transition(s, { type: 'AI_READY_VOTE', playerId: readyAI });
  assert.ok(s.voteReady.includes(readyAI));
  const llm = defaultMock();
  const { ctx } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    const pres = llm.calls.filter((c) => c.kind === 'pre_speech').map((c) => {
      const m = c.prompt.match(/你是 P(\d+)/);
      return m ? parseInt(m[1], 10) : -1;
    });
    assert.ok(!pres.includes(readyAI), '已 ready 的 AI 不應寫草稿');
    assert.ok(pres.length > 0, '未 ready 者應繼續生產');
  } finally {
    sch.stop();
  }
});

test('跳過按鈕保留但不驅動迴圈：HUMAN_SKIP 不重啟 CD、不另開生產', async () => {
  const s = mixedDiscussionState();
  const humans = s.players.filter((p) => p.alive && p.controlledBy === 'human').map((p) => p.id);
  assert.ok(humans.length >= 1);
  const llm = defaultMock();
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    const preBefore = llm.kinds().filter((k) => k === 'pre_speech').length;
    assert.ok(preBefore > 0, '首輪生產應已啟動');
    // 真人跳過（transition 不 bump 版本；scheduler 未被通知 → 不重跑）
    for (const h of humans) transition(s, { type: 'HUMAN_SKIP', playerId: h });
    await flush();
    const preAfter = llm.kinds().filter((k) => k === 'pre_speech').length;
    assert.equal(preAfter, preBefore, '跳過不應另開生產');
    assert.ok(sch.stashForTest(), '原暫存保留');
    mock.timers.tick(60000);
    await flush();
    const speeches = events.filter((e) => e.type === 'AI_SPEECH_DONE');
    assert.equal(speeches.length, 1, '原 CD 到點播出一次');
  } finally {
    sch.stop();
  }
});

test('expand 輸出清洗：模型自帶 flag 亦剝離才播出', async () => {
  const s = discussionState(9);
  const llm = new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) return judgeBySlotDesc(prompt);
    if (prompt.includes('【你的預發言草稿】')) return 'P0：「展開文本」\n[決定:投P3]';
    const m = prompt.match(/你是 P(\d+)/);
    return `P${m ? m[1] : '1'}：「草稿。」\n[決定:棄票]`;
  });
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    mock.timers.tick(1000);
    await flush();
    const speech = events.find((e) => e.type === 'AI_SPEECH_DONE')!;
    assert.equal(speech.type, 'AI_SPEECH_DONE');
    if (speech.type === 'AI_SPEECH_DONE') {
      assert.ok(!speech.text.includes('[決定'), 'broadcast 前應清洗 expand 輸出');
      assert.equal(speech.text, '「展開文本」', 'broadcast 前應剝離 Px：前綴');
    }
  } finally {
    sch.stop();
  }
});

test('生產失敗 → 預設 60 秒後重試（重試前不播出）', async () => {
  const s = discussionState(9);
  let calls = 0;
  const llm = new MockLLM(() => {
    calls++;
    throw new Error('llm down');
  });
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(2);
    const c1 = calls;
    assert.ok(c1 > 0, '首輪生產應已嘗試');
    assert.equal(events.length, 0);
    mock.timers.tick(59999);
    await flush();
    assert.equal(calls, c1, '60 秒未滿不重試');
    mock.timers.tick(1);
    await flushN(2);
    assert.ok(calls > c1, '60 秒到重試生產');
    assert.equal(events.length, 0, '重試前不播出');
  } finally {
    sch.stop();
  }
});

test('重試間隔 env 可調（SPEECH_RETRY_MS）', async () => {
  const prev = process.env.SPEECH_RETRY_MS;
  process.env.SPEECH_RETRY_MS = '5000';
  try {
    const s = discussionState(9);
    let calls = 0;
    const llm = new MockLLM(() => {
      calls++;
      throw new Error('llm down');
    });
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
    try {
      sch.onPhaseEntered(s);
      await flushN(2);
      const c1 = calls;
      mock.timers.tick(4999);
      await flush();
      assert.equal(calls, c1, '5 秒未滿不重試');
      mock.timers.tick(1);
      await flushN(2);
      assert.ok(calls > c1, 'env 指定 5 秒到重試');
    } finally {
      sch.stop();
    }
  } finally {
    if (prev === undefined) delete process.env.SPEECH_RETRY_MS;
    else process.env.SPEECH_RETRY_MS = prev;
  }
});

test('安全閥：連續資訊不足達上限 → 強制 decided，發言成功後 enqueue ready；decided 重置計數', async () => {
  const s = discussionState(6);
  const llm = uncertainMock();
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 100, maxUncertainRounds: 3 });
  try {
    // 第 1 輪（首輪無上輪發言者，全員草稿）：計數皆 1，無 ready
    sch.onPhaseEntered(s);
    await flushN(3);
    mock.timers.tick(100);
    await flush();
    const round1AI = s.players.filter((p) => p.alive && p.controlledBy === 'ai').map((p) => p.id);
    for (const id of round1AI) assert.equal(sch.uncertainCountForTest(id), 1);
    assert.ok(!events.some((e) => e.type === 'AI_READY_VOTE'), '未達安全閥不 enqueue ready');
    // 後續輪（每輪播出即版本推進）：草稿達 3 次上限 → 強制 decided → 播出後 enqueue ready
    // （winner 為 top3 隨機，計數落後的 AI 可能連莊，輪數有隨機性；收斂本身有界）
    let readyPid = -1;
    for (let r = 0; r < 12 && readyPid < 0; r++) {
      sch.onBoardUpdated(s);
      await flushN(3);
      mock.timers.tick(100);
      await flush();
      const ready = events.find((e) => e.type === 'AI_READY_VOTE');
      if (ready && ready.type === 'AI_READY_VOTE') readyPid = ready.playerId;
    }
    assert.ok(readyPid >= 0, '安全閥強制 decided 後應 enqueue ready');
    assert.equal(sch.uncertainCountForTest(readyPid), 0, 'decided 後計數重置');
  } finally {
    sch.stop();
  }
});

test('flagStats：decided／棄票／資訊不足計數＋隔天歸零', async () => {
  const s = discussionState(6);
  const llm = new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) return judgeBySlotDesc(prompt);
    if (prompt.includes('【你的預發言草稿】')) return '展開文本';
    const m = prompt.match(/你是 P(\d+)/);
    const id = m ? parseInt(m[1], 10) : 1;
    if (id % 3 === 1) return `P${id}：投P2。\n[決定:投P2]`;
    if (id % 3 === 2) return `P${id}：棄票。\n[決定:棄票]`;
    return `P${id}：資訊還不足，想再聽聽大家的說法。`;
  });
  const { ctx } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 600000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    const exp = { decided: 0, abstain: 0, uncertain: 0 };
    for (const p of s.players) {
      if (!p.alive || p.controlledBy !== 'ai') continue;
      if (p.id % 3 === 1) exp.decided++;
      else if (p.id % 3 === 2) exp.abstain++;
      else exp.uncertain++;
    }
    assert.deepEqual(sch.flagStats(), exp);
    // 隔天進場 → 同步歸零（後續非同步生產尚未跑，不影響斷言）
    sch.onPhaseEntered({ ...s, day: s.day + 1 });
    assert.deepEqual(sch.flagStats(), { decided: 0, abstain: 0, uncertain: 0 });
  } finally {
    sch.stop();
  }
});

test('flagStats：安全閥強制 abstain 計入棄票', async () => {
  const s = discussionState(6);
  const { ctx } = makeCtx(s, uncertainMock());
  const sch = new SpeechScheduler(ctx, { cdMs: 600000, maxUncertainRounds: 1 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    const aliveAi = s.players.filter((p) => p.alive && p.controlledBy === 'ai').length;
    assert.deepEqual(sch.flagStats(), { decided: 0, abstain: aliveAi, uncertain: 0 });
  } finally {
    sch.stop();
  }
});

// ---------- Phase 2：全真人跳過 → 立即管線 ----------

function mixedDiscussionState(): GameState {
  const s = createGameState(9);
  transition(s, { type: 'HUMAN_JOIN', playerId: 3, name: 'H1' });
  transition(s, { type: 'HUMAN_JOIN', playerId: 7, name: 'H2' });
  for (let id = 1; id <= 9; id++) {
    if (!s.players.some((p) => p.id === id)) transition(s, { type: 'AI_JOIN', playerId: id });
  }
  transition(s, { type: 'START_GAME' });
  convergeWolfDiscussion(s);
  const keep = [3, 7];
  const alive = s.players.filter((p) => p.alive).map((p) => p.id);
  for (const pid of getNightActors(s)) {
    const me = s.players.find((p) => p.id === pid)!;
    let pool = alive.filter((id) => id !== pid && !keep.includes(id));
    if (me.role === Role.WEREWOLF) {
      pool = pool.filter((id) => s.players.find((p) => p.id === id)!.team !== 'werewolf');
    }
    if (pool.length === 0) pool = alive.filter((id) => id !== pid);
    transition(s, me.controlledBy === 'human'
      ? { type: 'HUMAN_NIGHT_ACTION', playerId: pid, targetId: pool[0] }
      : { type: 'AI_NIGHT_DONE', playerId: pid, targetId: pool[0] });
  }
  transition(s, { type: 'RESOLVE_NIGHT' });
  assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
  return s;
}

test('混合局：進場即全員草稿開工（不等任何門檻；quiet 已拔除）', async () => {
  const s = mixedDiscussionState();
  const humans = s.players.filter((p) => p.alive && p.controlledBy === 'human').map((p) => p.id);
  assert.ok(humans.length >= 1);
  const llm = defaultMock();
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 600000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    assert.ok(llm.calls.some((c) => c.kind === 'pre_speech'), '進場即開工，不等 quiet／跳過');
    assert.ok(sch.stashForTest(), '生產完成暫存');
    void events;
  } finally {
    sch.stop();
  }
});

test('狼模式：進場即狼草稿開工；CD 到播 AI_WOLF_SPEECH_DONE + decided 後 AI_WOLF_READY', async () => {
  const s = createGameState(9);
  for (let i = 0; i < 9; i++) transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
  transition(s, { type: 'START_GAME' });
  assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
  const llm = defaultMock();
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    const pres = llm.calls.filter((c) => c.kind === 'pre_speech');
    assert.ok(pres.length > 0, '狼模式應生產預發言');
    for (const c of pres) {
      assert.ok(c.prompt.includes('今晚') || c.prompt.includes('襲擊'), '狼預發言應為狼 prompt');
    }
    assert.ok(sch.stashForTest(), '生產完成應暫存');
    assert.equal(events.length, 0, 'CD 內不廣播');
    const bvBefore = s.boardVersion;
    mock.timers.tick(60000);
    await flush();
    assert.ok(events.length >= 1);
    assert.equal(events[0].type, 'AI_WOLF_SPEECH_DONE');
    if (events[0].type === 'AI_WOLF_SPEECH_DONE') {
      assert.equal(events[0].boardVersion, bvBefore);
      assert.ok(!events[0].text.includes('[決定'), 'flag 永不進白板');
    }
    assert.ok(events.some((e) => e.type === 'AI_WOLF_READY'), 'decided 發言後應 enqueue AI_WOLF_READY');
  } finally {
    sch.stop();
  }
});

test('狼模式候選：僅存活 AI 狼（不含 seer/guard/真人）', async () => {
  const s = createGameState(9);
  for (let i = 0; i < 9; i++) transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
  transition(s, { type: 'START_GAME' });
  assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
  const llm = defaultMock();
  const { ctx } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    const pres = llm.calls.filter((c) => c.kind === 'pre_speech').map((c) => {
      const m = c.prompt.match(/你是 P(\d+)/);
      return m ? parseInt(m[1], 10) : -1;
    });
    const expectWolves = s.players.filter((p) => p.alive && p.controlledBy === 'ai' && p.role === Role.WEREWOLF).map((p) => p.id);
    assert.ok(expectWolves.length >= 1);
    assert.deepEqual([...pres].sort((a, b) => a - b), [...expectWolves].sort((a, b) => a - b));
    const seer = s.players.find((p) => p.role === Role.SEER)!;
    assert.ok(!pres.includes(seer.id), 'seer 不應列入狼候選');
  } finally {
    sch.stop();
  }
});

test('狼模式：決策目標是同盟/自己 → 視為棄票（不計 decided、不擋會議）', async () => {
  const s = createGameState(9);
  for (let i = 0; i < 9; i++) transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
  transition(s, { type: 'START_GAME' });
  assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
  const wolves = s.players.filter((p) => p.alive && p.role === Role.WEREWOLF);
  const allyId = wolves[0].id;
  const llm = new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) return judgeBySlotDesc(prompt);
    if (prompt.includes('【你的預發言草稿】')) return 'P0：「展開。」';
    const m = prompt.match(/你是 P(\d+)/);
    const id = m ? m[1] : '1';
    return `P${id}：「建議襲擊P${allyId}。」\n[決定:殺P${allyId}]`;
  });
  const { ctx } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    assert.equal(sch.flagStats().decided, 0, '同盟目標不應計為 decided');
    assert.equal(sch.flagStats().abstain, wolves.length, '同盟目標應視為棄票');
  } finally {
    sch.stop();
  }
});

test('狼模式：expand 決策優先 — pre_speech 資訊不足但 expand 殺P → 計 decided 且播出後 AI_WOLF_READY', async () => {
  const s = createGameState(9);
  for (let i = 0; i < 9; i++) transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
  transition(s, { type: 'START_GAME' });
  assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
  const target = s.players.find((p) => p.alive && p.role !== Role.WEREWOLF)!.id;
  const llm = new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) return judgeBySlotDesc(prompt);
    if (prompt.includes('【你的預發言草稿】')) return `P0：「我決定襲擊P${target}。」\n[決定:殺P${target}]`;
    const m = prompt.match(/你是 P(\d+)/);
    const id = m ? m[1] : '1';
    return `P${id}：「資訊還不足，我無法決定，想再聽聽大家的說法。」`;
  });
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    assert.equal(sch.flagStats().decided, 1, 'expand 已決定 → 應計為 decided');
    mock.timers.tick(60000);
    await flush();
    assert.ok(events.some((e) => e.type === 'AI_WOLF_READY'), 'expand 已決定 → 播出後應 enqueue AI_WOLF_READY');
  } finally {
    sch.stop();
  }
});

test('狼模式：expand 旗標與草稿決策矛盾 → 沿用草稿決策（旗標失誤不採信）', async () => {
  const s = createGameState(9);
  for (let i = 0; i <9; i++) transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
  transition(s, { type: 'START_GAME' });
  assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
  const wolves = s.players.filter((p) => p.alive && p.role === Role.WEREWOLF);
  const ally = wolves[1];                                  // 旗標誤填的同盟（無效目標）
  const draftTarget = s.players.find((p) => p.alive && p.role !== Role.WEREWOLF)!.id;  // 草稿決策目標
  const llm = new MockLLM((prompt) => {
    if (prompt.includes('【裁判任務】')) return judgeBySlotDesc(prompt);
    // expand：正文沿用草稿目標，旗標卻誤填同盟（模擬 v5 觀察到的旗標失誤）
    if (prompt.includes('【你的預發言草稿】')) return `P0：「我覺得今晚殺P${draftTarget}比較順便。」\n[決定:殺P${ally.id}]`;
    const m = prompt.match(/你是 P(\d+)/);
    const id = m ? m[1] : '1';
    return `P${id}：「直覺上P${draftTarget}，沒什麼特別依據。」\n[決定:殺P${draftTarget}]`;
  });
  const { ctx, events } = makeCtx(s, llm);
  const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
  try {
    sch.onPhaseEntered(s);
    await flushN(3);
    // 防護生效：expand 誤填旗標（同盟）不採信 → 沿用草稿 decided；若採信旗標會被 validateWolfTarget 轉棄票
    assert.equal(sch.flagStats().abstain, 0, '矛盾回退草稿 → 不應產生棄票');
    assert.equal(sch.flagStats().decided, wolves.length, '兩狼草稿決策皆應保留為 decided');
    mock.timers.tick(60000);
    await flush();
    // 勝出者由 judge 決定（slot 降序），ready 事件應存在且屬於某匹存活狼
    const wolfIds = new Set(wolves.map((w) => w.id));
    assert.ok(events.some((e) => e.type === 'AI_WOLF_READY' && wolfIds.has(e.playerId)), '草稿 decided → 播出後應 ready');
  } finally {
    sch.stop();
  }
});

void Role;
