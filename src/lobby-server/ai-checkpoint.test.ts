/**
 * ai-checkpoint.test.ts — AI DAY_DISCUSSION continuation focused tests
 *
 * 使用 controller 內建 test adapter；不連 SGLang，也不修改正式 server wiring。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Role, Team } from '../types.js';
import { GameEngine, type GameCallbacks } from './game.js';
import {
  AI_DAY_CHECKPOINT_SCHEMA_VERSION,
  AiController,
  type AiDayCheckpoint,
  type AiDayLlmTestAdapter,
} from './ai-controller.js';

interface Harness {
  game: GameEngine;
  ai: AiController;
  broadcasts: Record<string, any>[];
  clientIds: string[];
}

const DEFS = [
  { clientId: 'ai-a', nickname: 'A', characterId: 'aoi' },
  { clientId: 'ai-b', nickname: 'B', characterId: 'chihiro' },
  { clientId: 'ai-c', nickname: 'C', characterId: 'futa' },
];

function makeAdapter(overrides: Partial<AiDayLlmTestAdapter> = {}): AiDayLlmTestAdapter {
  return {
    strategy: async (clientId) => `strategy-${clientId}`,
    draft: async (clientId) => ({ speech: `draft-${clientId}`, stance: '資訊不足' }),
    judge: async () => 0,
    expand: async (_clientId, draft) => `expanded:${draft}`,
    respond: async () => ({ action: 'wait' as const }),
    ...overrides,
  };
}

function makeHarness(adapter: AiDayLlmTestAdapter = makeAdapter()): Harness {
  let game: GameEngine;
  let ai: AiController;
  const broadcasts: Record<string, any>[] = [];
  const clientIds = ['ai-a', 'ai-b', 'ai-c', 'human'];

  const callbacks: GameCallbacks = {
    sendTo: () => undefined,
    broadcast: (message) => {
      const record = message as Record<string, any>;
      broadcasts.push(record);
      // 只把測試需要的 phase/message 交給 AI；DAY_VOTING 不啟動另一個 SGLang loop。
      if (record.type === 'MESSAGE' || (record.type === 'PHASE_CHANGED' && record.phase === 'DAY_DISCUSSION')) {
        ai.handleBroadcast(message);
      }
    },
  };

  ai = new AiController(DEFS, { dayTestLlm: adapter });
  ai.setPhaseStartEnabled(false);
  game = new GameEngine('AI_CHECKPOINT', clientIds.map((clientId, index) => ({
    clientId,
    nickname: index < DEFS.length ? String.fromCharCode(65 + index) : 'H',
  })), callbacks);

  const state = (game as any).state;
  state.players = clientIds.map((clientId) => ({
    clientId,
    nickname: clientId === 'ai-a' ? 'A' : clientId === 'ai-b' ? 'B' : clientId === 'ai-c' ? 'C' : 'H',
    role: Role.VILLAGER,
    team: Team.VILLAGE,
    alive: true,
    isMasonPartner: false,
    wolfPartnerIds: [],
    seerChecks: [],
    guardProtects: [],
  }));
  state.phase = 'DAY_DISCUSSION';
  state.dayReady = new Map(clientIds.map((clientId) => [clientId, false]));
  state.dayMessages = [];

  ai.setGame(game);
  ai.handleBroadcast({ type: 'PHASE_CHANGED', phase: 'DAY_DISCUSSION', day: 1 });
  return { game, ai, broadcasts, clientIds };
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function baseSnapshot(harness: Harness): AiDayCheckpoint {
  const snapshot = harness.ai.exportDayCheckpoint();
  assert.ok(snapshot);
  return snapshot;
}

async function eventually(assertion: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (assertion()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function countType(broadcasts: Record<string, any>[], type: string): number {
  return broadcasts.filter((message) => message.type === type).length;
}

test('DAY_DISCUSSION checkpoint 經 JSON round-trip 保留 memory/knowledge/boards/draft/response，且 import 不自動啟動', () => {
  const source = makeHarness();
  let autoStartedCalls = 0;
  const target = makeHarness(makeAdapter({
    strategy: async () => { autoStartedCalls += 1; return 'unexpected'; },
    draft: async () => { autoStartedCalls += 1; return { speech: 'unexpected', stance: '資訊不足' }; },
  }));
  try {
    target.game.sendDayMessage('ai-a', 'same');
    target.game.sendDayMessage('ai-a', 'same');
    const message = target.game.getDayState().dayMessages[0];
    assert.ok(message);

    const snapshot = baseSnapshot(target);
    snapshot.stage = 'responses';
    snapshot.strategyDone = ['ai-a', 'ai-b', 'ai-c'];
    snapshot.draftSlots = [
      { clientId: 'ai-a', speech: 'a-draft', stance: '準備好了' },
      { clientId: 'ai-b', speech: 'b-draft', stance: '資訊不足' },
      { clientId: 'ai-c' },
    ];
    snapshot.selectedClientId = 'ai-a';
    snapshot.expandedText = 'expanded-a';
    snapshot.published = {
      turnId: 'turn-1',
      clientId: 'ai-a',
      status: 'committed',
      messageId: message.id,
      messageSeq: message.seq,
      readyValue: true,
    };
    snapshot.responses = [
      { clientId: 'ai-b', turnId: 'turn-1', status: 'ready' },
      { clientId: 'ai-c', turnId: 'turn-1', status: 'speak', draft: { speech: 'c-followup', stance: '資訊不足' } },
    ];
    snapshot.profileMemory = { 'ai-a': 'memory-a', 'ai-b': 'memory-b', 'ai-c': 'memory-c' };
    snapshot.knowledge = snapshot.knowledge.map((knowledge) => ({
      ...knowledge,
      role: 'villager',
      privateInfo: `private-${knowledge.clientId}`,
      recentMessages: [{ from: 'A', text: `seen-${knowledge.clientId}` }],
    }));
    snapshot.wolfBoard = [{ from: 'W1', text: 'wolf' }, { from: 'W2', text: 'wolf-2' }];
    snapshot.masonBoard = [{ from: 'M1', text: 'mason' }];

    const wire = jsonClone(snapshot);
    assert.equal(typeof wire.profileMemory, 'object');
    assert.equal(Array.isArray(wire.knowledge), true);
    assert.equal(wire.knowledge.some((item) => item instanceof Map), false);

    target.ai.importDayCheckpoint(wire);
    const restored = target.ai.exportDayCheckpoint();
    assert.ok(restored);
    assert.deepEqual({ ...restored, runId: snapshot.runId }, snapshot);
    assert.equal(target.ai.getKnowledge('ai-a')?.privateInfo, 'private-ai-a');
    assert.deepEqual(target.ai.getKnowledge('ai-c')?.recentMessages, [{ from: 'A', text: 'seen-ai-c' }]);

    // import 只 hydrate，不會自行啟動 loop。
    assert.equal(restored.stage, 'responses');
    assert.equal(autoStartedCalls, 0);
    assert.equal(target.game.getDayState().dayMessages.length, 2);
  } finally {
    source.ai.destroy();
    source.game.destroy();
    target.ai.destroy();
    target.game.destroy();
  }
});

test('partial strategy/draft resume 只補未完成 clientId，draft slot 順序不依完成時間', async () => {
  const target = makeHarness();
  const strategyCalls: string[] = [];
  const draftCalls: string[] = [];
  const adapter = makeAdapter({
    strategy: async (clientId) => {
      strategyCalls.push(clientId);
      return `strategy-${clientId}`;
    },
    draft: async (clientId) => {
      draftCalls.push(clientId);
      return { speech: `new-${clientId}`, stance: '資訊不足' };
    },
    respond: async () => ({ action: 'ready' as const }),
  });
  target.ai.destroy();
  target.game.destroy();
  const harness = makeHarness(adapter);
  const snapshot = baseSnapshot(harness);
  snapshot.stage = 'strategies';
  snapshot.strategyDone = ['ai-a', 'ai-b'];
  snapshot.draftSlots = [{ clientId: 'ai-a', speech: 'already-a', stance: '資訊不足' }];

  try {
    harness.ai.importDayCheckpoint(snapshot);
    await harness.ai.resumeDayDiscussion();

    assert.deepEqual(strategyCalls, ['ai-c']);
    assert.deepEqual(draftCalls.sort(), ['ai-b', 'ai-c']);
    const result = harness.ai.exportDayCheckpoint();
    assert.ok(result);
    assert.deepEqual(result.draftSlots.map((slot) => slot.clientId), ['ai-a', 'ai-b', 'ai-c']);
    assert.equal(result.draftSlots[0]?.speech, 'already-a');
    assert.equal(result.stage, 'complete');
  } finally {
    harness.ai.destroy();
    harness.game.destroy();
  }
});

test('completed judge/expand 不重做，published message 與已完成 ready/response 不 replay', async () => {
  const source = makeHarness();
  source.game.sendDayMessage('ai-a', 'already-published');
  source.game.setDayReady('ai-a', true);
  source.game.setDayReady('ai-b', true);
  const message = source.game.getDayState().dayMessages[0];
  assert.ok(message);

  const respondCalls: string[] = [];
  const target = makeHarness(makeAdapter({
    judge: async () => { throw new Error('judge must not rerun'); },
    expand: async () => { throw new Error('expand must not rerun'); },
    respond: async (clientId) => {
      respondCalls.push(clientId);
      return { action: 'ready' as const };
    },
  }));
  try {
    target.game.restoreState(source.game.saveState());
    const snapshot = baseSnapshot(source);
    snapshot.stage = 'responses';
    snapshot.strategyDone = ['ai-a', 'ai-b', 'ai-c'];
    snapshot.draftSlots = [{ clientId: 'ai-a', speech: 'a-draft', stance: '資訊不足' }];
    snapshot.selectedClientId = 'ai-a';
    snapshot.expandedText = 'already-published';
    snapshot.published = {
      turnId: 'turn-published',
      clientId: 'ai-a',
      status: 'committed',
      messageId: message.id,
      messageSeq: message.seq,
      readyValue: true,
    };
    snapshot.responses = [
      { clientId: 'ai-b', turnId: 'turn-published', status: 'ready' },
      { clientId: 'ai-c', turnId: 'turn-published', status: 'pending' },
    ];

    const readyBefore = countType(target.broadcasts, 'DAY_READY_STATUS');
    target.ai.importDayCheckpoint(snapshot);
    await target.ai.resumeDayDiscussion();

    assert.deepEqual(respondCalls, ['ai-c']);
    assert.equal(target.game.getDayState().dayMessages.length, 1);
    assert.equal(target.game.getDayState().dayMessages[0]?.id, message.id);
    assert.equal(countType(target.broadcasts, 'DAY_READY_STATUS'), readyBefore + 1);
    const result = target.ai.exportDayCheckpoint();
    assert.equal(result?.published?.messageId, message.id);
    assert.equal(result?.responses.find((response) => response.clientId === 'ai-b')?.status, 'ready');
  } finally {
    source.ai.destroy();
    source.game.destroy();
    target.ai.destroy();
    target.game.destroy();
  }
});

test('resume single-flight；import 新 snapshot 後舊 runId 的 deferred 結果不得寫回', async () => {
  let releaseStale!: () => void;
  const staleDraft = new Promise<void>((resolve) => { releaseStale = resolve; });
  let draftCalls = 0;
  const adapter = makeAdapter({
    draft: async (clientId) => {
      draftCalls += 1;
      if (draftCalls === 1) {
        await staleDraft;
        return { speech: 'STALE', stance: '資訊不足' };
      }
      return { speech: `FRESH-${clientId}`, stance: '資訊不足' };
    },
    respond: async () => ({ action: 'ready' as const }),
  });
  const harness = makeHarness(adapter);
  try {
    const firstRun = harness.ai.resumeDayDiscussion();
    const sameRun = harness.ai.resumeDayDiscussion();
    assert.strictEqual(sameRun, firstRun);

    await eventually(() => draftCalls >= 3, 'initial draft calls did not start');
    const replacement = baseSnapshot(harness);
    assert.equal(replacement.stage, 'drafts');

    harness.ai.importDayCheckpoint(replacement);
    const newRun = harness.ai.resumeDayDiscussion();
    await newRun;
    releaseStale();
    await firstRun;

    const result = harness.ai.exportDayCheckpoint();
    assert.ok(result);
    assert.equal(result.stage, 'complete');
    assert.deepEqual(result.draftSlots.map((slot) => slot.speech), ['FRESH-ai-a', 'FRESH-ai-b', 'FRESH-ai-c']);
    assert.equal(result.draftSlots.some((slot) => slot.speech === 'STALE'), false);
    assert.equal(harness.game.getDayState().dayMessages.length, 1);
  } finally {
    releaseStale();
    harness.ai.destroy();
    harness.game.destroy();
  }
});

test('duplicate day messages resume 完整重建且不依 from/text 去重', () => {
  const harness = makeHarness();
  try {
    harness.game.sendDayMessage('ai-a', 'duplicate');
    harness.game.sendDayMessage('ai-a', 'duplicate');
    const snapshot = baseSnapshot(harness);
    harness.ai.importDayCheckpoint(snapshot);

    const board = (harness.ai as any).dayBoard as { from: string; text: string }[];
    assert.deepEqual(board, [
      { from: 'A', text: 'duplicate' },
      { from: 'A', text: 'duplicate' },
    ]);
  } finally {
    harness.ai.destroy();
    harness.game.destroy();
  }
});

test('invalid schema/day/phase/roster 匯入採 safe no-op，不覆寫既有 continuation', () => {
  const harness = makeHarness();
  try {
    const before = baseSnapshot(harness);
    const invalid: AiDayCheckpoint[] = [];

    invalid.push({ ...jsonClone(before), schemaVersion: 999 as typeof AI_DAY_CHECKPOINT_SCHEMA_VERSION });
    invalid.push({ ...jsonClone(before), day: 2 });
    invalid.push({ ...jsonClone(before), phase: 'NIGHT' as any });
    invalid.push({ ...jsonClone(before), rosterClientIds: [...before.rosterClientIds.slice(1), 'ghost'] });

    for (const snapshot of invalid) {
      harness.ai.importDayCheckpoint(snapshot);
      const after = harness.ai.exportDayCheckpoint();
      assert.deepEqual(after, before);
    }
  } finally {
    harness.ai.destroy();
    harness.game.destroy();
  }
});

test('all-ready resume 走 reconcileDayReady，恢復後直接推進 DAY_VOTING 且不呼叫 LLM', async () => {
  let llmCalls = 0;
  const adapter = makeAdapter({
    strategy: async () => { llmCalls += 1; return 'unexpected'; },
    draft: async () => { llmCalls += 1; return { speech: 'unexpected', stance: '資訊不足' }; },
    judge: async () => { llmCalls += 1; return 0; },
    expand: async () => { llmCalls += 1; return 'unexpected'; },
    respond: async () => { llmCalls += 1; return { action: 'ready' as const }; },
  });
  const harness = makeHarness(adapter);
  try {
    const snapshot = baseSnapshot(harness);
    // 模擬 Phase 1 restore：所有存活玩家 ready=true，但 engine 尚停 DAY_DISCUSSION。
    (harness.game as any).state.dayReady = new Map(harness.clientIds.map((clientId) => [clientId, true]));
    harness.ai.importDayCheckpoint(snapshot);
    await harness.ai.resumeDayDiscussion();

    assert.equal(harness.game.getNightState().phase, 'DAY_VOTING');
    assert.equal(llmCalls, 0);
    assert.equal(countType(harness.broadcasts, 'PHASE_CHANGED'), 1);
  } finally {
    harness.ai.destroy();
    harness.game.destroy();
  }
});
