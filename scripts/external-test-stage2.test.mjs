/**
 * external-test-stage2.test.mjs — external-test-stage2.mjs 的 envelope 存檔/恢復本機測試
 *
 * 直接跑（免編譯，依賴 dist/ 既有 build）：
 *   node --test scripts/external-test-stage2.test.mjs
 *
 * 覆蓋：
 *   T1 單一 envelope round-trip：import 後 deepEqual（runId 正規化）；resume 只補 pending、不重播 publish/ready
 *   T2 原子寫入：成功無 .tmp 殘留；失敗（mkdir 被擋）丟錯且不動舊檔
 *   T3 重入不重做已完成階段：strategy 完成＋drafts 中斷 → resume 只補其餘（strategy 0 次）
 *   T4 barrier＋all-ready：import 不啟動 loop（llmCalls=0）；resume 全員 ready 才 reconcile → DAY_VOTING
 *   T5 舊三檔格式（頂層無 schemaVersion）與非 DAY_DISCUSSION 存檔明確拒絕
 *   T6 --stop-at 白名單驗證：合法值 null、未知值明確錯誤
 *   T7 SIGINT settle 上限小於 runner 的 30s kill-after（不可拉回 70s）
 *   T8 SIGINT settle 的 resume promise 明確 catch：reject 不產生 unhandled rejection
 *   T9 isMainModule：精確路徑 true；大小寫差異 Windows true／Linux false
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameEngine } from '../dist/lobby-server/game.js';
import { AiController } from '../dist/lobby-server/ai-controller.js';
import {
  STAGE2_STATE_SCHEMA_VERSION,
  SIGINT_SETTLE_TIMEOUT_MS,
  STOP_AT_PHASES,
  validateStopAt,
  isMainModule,
  settleInFlightWork,
  atomicWriteJson,
  buildEnvelope,
  loadEnvelope,
  stage2ResumeImport,
  stage2ResumeRun,
  resumeStage2State,
} from './external-test-stage2.mjs';

// --- 測試桌：3 AI + 1 human（human 永不 ready → engine 可停在 DAY_DISCUSSION） ---

const DEFS = [
  { clientId: 'ai-a', nickname: 'A', characterId: 'aoi' },
  { clientId: 'ai-b', nickname: 'B', characterId: 'chihiro' },
  { clientId: 'ai-c', nickname: 'C', characterId: 'futa' },
];
const CLIENT_IDS = ['ai-a', 'ai-b', 'ai-c', 'human'];
const NICKNAMES = { 'ai-a': 'A', 'ai-b': 'B', 'ai-c': 'C', human: 'H' };

function makeAdapter(overrides = {}) {
  return {
    strategy: async (clientId) => `strategy-${clientId}`,
    draft: async (clientId) => ({ speech: `draft-${clientId}`, stance: '資訊不足' }),
    judge: async () => 0,
    expand: async (_clientId, draft) => `expanded:${draft}`,
    respond: async () => ({ action: 'wait' }),
    ...overrides,
  };
}

function makeCountingAdapter(counts) {
  return {
    strategy: async (clientId) => { counts.strategy.push(clientId); return `strategy-${clientId}`; },
    draft: async (clientId) => { counts.draft.push(clientId); return { speech: `draft-${clientId}`, stance: '資訊不足' }; },
    judge: async () => { counts.judge.push(1); return 0; },
    expand: async (_clientId, draft) => { counts.expand.push(1); return `expanded:${draft}`; },
    respond: async (clientId) => { counts.respond.push(clientId); return { action: 'ready' }; },
  };
}

/**
 * 最小 DAY_DISCUSSION harness。broadcast filter 只把 MESSAGE 與
 * PHASE_CHANGED(DAY_DISCUSSION) 交給 AI——PHASE_CHANGED(DAY_VOTING) 不能到 AI，
 * 否則 runDayVoting 會走真實 LLM（dayTestLlm 只覆蓋白天討論 5 個 stage）。
 */
function makeHarness(adapter = makeAdapter()) {
  let game;
  let ai;
  const broadcasts = [];
  const callbacks = {
    sendTo: () => undefined,
    broadcast: (message) => {
      const record = message;
      broadcasts.push(record);
      if (record.type === 'MESSAGE' || (record.type === 'PHASE_CHANGED' && record.phase === 'DAY_DISCUSSION')) {
        ai.handleBroadcast(message);
      }
    },
  };
  ai = new AiController(DEFS, { dayTestLlm: adapter });
  ai.setPhaseStartEnabled(false);
  game = new GameEngine('STAGE2_TEST', CLIENT_IDS.map((clientId) => ({ clientId, nickname: NICKNAMES[clientId] })), callbacks);
  // 直接注入最小 DAY_DISCUSSION state（避免等真實 phase timer）
  const state = game.state;
  state.players = CLIENT_IDS.map((clientId) => ({
    clientId,
    nickname: NICKNAMES[clientId],
    role: 'villager',
    team: 'village',
    alive: true,
    isMasonPartner: false,
    wolfPartnerIds: [],
    seerChecks: [],
    guardProtects: [],
  }));
  state.phase = 'DAY_DISCUSSION';
  state.day = 1;
  state.dayReady = new Map(CLIENT_IDS.map((clientId) => [clientId, false]));
  state.dayMessages = [];
  ai.setGame(game);
  ai.handleBroadcast({ type: 'PHASE_CHANGED', phase: 'DAY_DISCUSSION', day: 1 });
  return { game, ai, broadcasts };
}

// --- 共用 helpers ---

/** 手組單一 envelope（AI 段可用 fabricated checkpoint，不用 live export） */
function makeEnv({ game, ai, events = [], stopAt = 'DAY_RESULT', aiLog = [] }) {
  return {
    schemaVersion: STAGE2_STATE_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    stopAt,
    game: game.saveState(),
    ai,
    events: [...events],
    aiLog,
  };
}

function countType(broadcasts, type) {
  return broadcasts.filter((message) => message.type === type).length;
}

async function eventually(check, message) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function destroyHarness(harness) {
  harness.ai.destroy();
  harness.game.destroy();
}

/** 組出「討論進行中」的 AI checkpoint：ai-a 已 publish（committed）、ai-b ready、ai-c pending */
function fabricateResponsesSnapshot(source, message) {
  const snapshot = source.ai.exportDayCheckpoint();
  assert.ok(snapshot);
  snapshot.stage = 'responses';
  snapshot.strategyDone = ['ai-a', 'ai-b', 'ai-c'];
  snapshot.draftSlots = [{ clientId: 'ai-a', speech: 'a-draft', stance: '準備好了' }];
  snapshot.selectedClientId = 'ai-a';
  snapshot.expandedText = 'already-published';
  snapshot.published = {
    turnId: 'turn-1', clientId: 'ai-a', status: 'committed',
    messageId: message.id, messageSeq: message.seq, readyValue: true,
  };
  snapshot.responses = [
    { clientId: 'ai-b', turnId: 'turn-1', status: 'ready' },
    { clientId: 'ai-c', turnId: 'turn-1', status: 'pending' },
  ];
  return snapshot;
}

// --- T1：envelope round-trip ＋ resume 不重播 ---

test('T1：單一 envelope round-trip；resume 只補 pending response、不重播 publish/ready', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'stage2-t1-'));
  const source = makeHarness();
  const respondCalls = [];
  const target = makeHarness({
    strategy: async () => { throw new Error('strategy must not rerun'); },
    draft: async () => { throw new Error('draft must not rerun'); },
    judge: async () => { throw new Error('judge must not rerun'); },
    expand: async () => { throw new Error('expand must not rerun'); },
    respond: async (clientId) => { respondCalls.push(clientId); return { action: 'ready' }; },
  });
  try {
    // source：ai-a 已發言且 ai-a/ai-b 已 ready；ai-c pending
    source.game.sendDayMessage('ai-a', 'already-published');
    source.game.setDayReady('ai-a', true);
    source.game.setDayReady('ai-b', true);
    const message = source.game.getDayState().dayMessages[0];
    assert.ok(message);
    const snapshot = fabricateResponsesSnapshot(source, message);

    // 原子存檔 → JSON 讀回（round-trip）＋結構驗證
    const statePath = join(tmpDir, 'state.json');
    atomicWriteJson(statePath, makeEnv({ game: source.game, ai: snapshot, events: source.broadcasts, aiLog: source.ai.getLog() }));
    const loaded = loadEnvelope(statePath);
    assert.deepEqual(loaded.ai.published, snapshot.published);

    // resume 步驟 1：barrier → restore → restoreLog → import（不啟動 loop）
    stage2ResumeImport(target.game, target.ai, loaded);
    const imported = target.ai.exportDayCheckpoint();
    assert.ok(imported);
    assert.deepEqual({ ...imported, runId: loaded.ai.runId }, loaded.ai);

    // resume 步驟 2：只補 pending 的 ai-c；publish 不重送、completed ready 不重做
    await stage2ResumeRun(target.game, target.ai);
    assert.deepEqual(respondCalls, ['ai-c']);
    assert.equal(countType(target.broadcasts, 'MESSAGE'), 0);
    assert.equal(countType(target.broadcasts, 'DAY_READY_STATUS'), 2); // restore 1 + ai-c ready 1
    assert.equal(target.game.getDayState().dayMessages.length, 1);

    // human 未 ready → engine 留 DAY_DISCUSSION（可再 export 驗證完整收斂）
    assert.equal(target.game.getNightState().phase, 'DAY_DISCUSSION');
    const after = target.ai.exportDayCheckpoint();
    assert.ok(after);
    assert.equal(after.stage, 'complete');
    assert.equal(after.published.messageId, message.id);
  } finally {
    destroyHarness(source);
    destroyHarness(target);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// --- T2：原子寫入 ---

test('T2：原子寫入——成功無 .tmp 殘留；失敗丟錯且舊檔不動', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'stage2-t2-'));
  try {
    // 成功路徑：temp + rename，內容完整、無 .tmp 殘留
    const okPath = join(tmpDir, 'nested', 'state.json');
    atomicWriteJson(okPath, { schemaVersion: STAGE2_STATE_SCHEMA_VERSION, ok: true });
    assert.deepEqual(JSON.parse(readFileSync(okPath, 'utf-8')), { schemaVersion: STAGE2_STATE_SCHEMA_VERSION, ok: true });
    assert.ok(!readdirSync(join(tmpDir, 'nested')).some((name) => name.includes('.tmp.')));

    // 失敗路徑：舊檔先存好；再用「同名牌檔擋掉目標父目錄」強製 mkdir 失敗
    const prevPath = join(tmpDir, 'prev', 'state.json');
    atomicWriteJson(prevPath, { schemaVersion: STAGE2_STATE_SCHEMA_VERSION, savedAt: 'original' });
    writeFileSync(join(tmpDir, 'blocked'), 'file, not directory');
    assert.throws(() => atomicWriteJson(join(tmpDir, 'blocked', 'state.json'), { schemaVersion: STAGE2_STATE_SCHEMA_VERSION, savedAt: 'new' }));
    // 舊檔內容不動，且沒有 .tmp 殘留
    assert.deepEqual(JSON.parse(readFileSync(prevPath, 'utf-8')), { schemaVersion: STAGE2_STATE_SCHEMA_VERSION, savedAt: 'original' });
    assert.ok(!readdirSync(tmpDir).some((name) => name.includes('.tmp.')));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// --- T3：重入不重做已完成階段 ---

test('T3：重入不重做已完成階段——strategy 完成＋drafts 中斷，resume 只補其餘', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'stage2-t3-'));
  let releaseDraft;
  const draftGate = new Promise((resolve) => { releaseDraft = resolve; });
  const sourceDraftCalls = [];
  const source = makeHarness({
    strategy: async (clientId) => `strategy-${clientId}`,
    draft: async (clientId) => {
      sourceDraftCalls.push(clientId);
      await draftGate; // 永不解決：模擬 drafts 階段途中 process 被中斷
      return { speech: `draft-${clientId}`, stance: '資訊不足' };
    },
    judge: async () => 0,
    expand: async (_clientId, draft) => `expanded:${draft}`,
    respond: async () => ({ action: 'ready' }),
  });
  const counts = { strategy: [], draft: [], judge: [], expand: [], respond: [] };
  const target = makeHarness(makeCountingAdapter(counts));
  try {
    source.ai.setPhaseStartEnabled(true);
    void source.ai.resumeDayDiscussion(); // 不等它：strategy 完成、drafts 掛起時即「中斷」
    await eventually(() => source.ai.exportDayCheckpoint()?.stage === 'drafts', 'source 未進入 drafts 階段');
    assert.equal(sourceDraftCalls.length, 3);
    const snapshot = source.ai.exportDayCheckpoint();
    assert.ok(snapshot);
    assert.equal(snapshot.stage, 'drafts');
    assert.deepEqual([...snapshot.strategyDone].sort(), ['ai-a', 'ai-b', 'ai-c']);
    assert.ok(snapshot.draftSlots.length === 3 && snapshot.draftSlots.every((slot) => slot.speech === undefined));

    const statePath = join(tmpDir, 'state.json');
    atomicWriteJson(statePath, makeEnv({ game: source.game, ai: snapshot, events: [], aiLog: source.ai.getLog() }));
    const loaded = loadEnvelope(statePath);

    // target：完整 resume（import → resume）
    await resumeStage2State(target.game, target.ai, loaded);
    assert.deepEqual(counts.strategy, []); // 已完成 strategy 不重做
    assert.deepEqual(counts.draft.sort(), ['ai-a', 'ai-b', 'ai-c']);
    assert.equal(counts.judge.length, 1);
    assert.equal(counts.expand.length, 1);
    assert.equal(counts.respond.length, 2);
    assert.ok(!counts.respond.includes('ai-a')); // 發言者自己不回應
    assert.equal(target.game.getNightState().phase, 'DAY_DISCUSSION'); // human 未 ready
  } finally {
    destroyHarness(source);
    destroyHarness(target);
    releaseDraft(); // source 已 destroy：舊 run 結果由 epoch guard 丟棄
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// --- T4：barrier ＋ all-ready ---

test('T4：barrier 吸收 restore 廣播；all-ready 時 resume 直接 reconcile 進 DAY_VOTING、不呼叫 LLM', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'stage2-t4-'));
  const counts = { strategy: [], draft: [], judge: [], expand: [], respond: [] };
  const llmCalls = () => counts.strategy.length + counts.draft.length + counts.judge.length + counts.expand.length + counts.respond.length;
  const source = makeHarness(makeCountingAdapter(counts));
  const target = makeHarness(makeCountingAdapter(counts));
  try {
    // 4 人全 ready：直接指派 state（setDayReady 會立即自動 transition 到 DAY_VOTING）
    source.game.state.dayReady = new Map(CLIENT_IDS.map((clientId) => [clientId, true]));
    const statePath = join(tmpDir, 'state.json');
    atomicWriteJson(statePath, buildEnvelope({ game: source.game, ai: source.ai, events: source.broadcasts, stopAt: 'DAY_RESULT' }));
    const loaded = loadEnvelope(statePath);
    assert.ok(loaded.ai.runId.endsWith('-unstarted'));

    stage2ResumeImport(target.game, target.ai, loaded);
    assert.equal(llmCalls(), 0); // import 不啟動白天 loop
    assert.equal(target.game.getNightState().phase, 'DAY_DISCUSSION');

    await stage2ResumeRun(target.game, target.ai);
    assert.equal(target.game.getNightState().phase, 'DAY_VOTING'); // 全員 ready → reconcile 推進
    assert.equal(llmCalls(), 0);
    assert.equal(countType(target.broadcasts, 'MESSAGE'), 0);
    assert.equal(countType(target.broadcasts, 'DAY_READY_STATUS'), 1); // 只有 restore 那一次
  } finally {
    destroyHarness(source);
    destroyHarness(target);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// --- T5：舊格式／非 DAY_DISCUSSION 明確拒絕 ---

test('T5：舊三檔格式（頂層無 schemaVersion）與非 DAY_DISCUSSION 存檔明確拒絕', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'stage2-t5-'));
  try {
    // 舊三檔格式：頂層就是 game state（沒有 envelope 包裹）
    const legacyPath = join(tmpDir, 'legacy-state.json');
    writeFileSync(legacyPath, JSON.stringify({
      day: 1, phase: 'DAY_DISCUSSION',
      players: [{ clientId: 'ai-a', nickname: 'A', role: 'villager', team: 'village', alive: true }],
      dayReady: { 'ai-a': false }, dayMessages: [],
    }), 'utf-8');
    assert.throws(() => loadEnvelope(legacyPath), /不支援的存檔格式/);

    // envelope v2 但 game phase 不是 DAY_DISCUSSION
    const nightPath = join(tmpDir, 'night-envelope.json');
    writeFileSync(nightPath, JSON.stringify({
      schemaVersion: STAGE2_STATE_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      stopAt: 'NIGHT_RESULT',
      game: { day: 1, phase: 'NIGHT', players: [], dayReady: {}, dayMessages: [] },
      ai: null, events: [], aiLog: [],
    }), 'utf-8');
    assert.throws(() => loadEnvelope(nightPath), /只支援 DAY_DISCUSSION restore/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// --- T6：--stop-at 白名單 ---

test('T6：validateStopAt 白名單——合法值 null、未知值明確錯誤（含可用值清單）', () => {
  for (const phase of STOP_AT_PHASES) assert.equal(validateStopAt(phase), null);
  assert.match(validateStopAt('NIGHT_FINAL'), /未知的 --stop-at/);
  assert.match(validateStopAt(''), /可用：NIGHT_RESULT \/ DAY_RESULT \/ GAME_OVER/);
});

// --- T7：SIGINT settle 上限 vs runner kill-after ---

test('T7：SIGINT settle 上限小於 runner 的 30s kill-after', () => {
  // runner 用 `timeout --signal=INT --kill-after=30s`：settle 超過 30s 會被直接 KILL，snapshot 永遠寫不出
  assert.ok(SIGINT_SETTLE_TIMEOUT_MS > 0);
  assert.ok(SIGINT_SETTLE_TIMEOUT_MS < 30_000, `SIGINT_SETTLE_TIMEOUT_MS=${SIGINT_SETTLE_TIMEOUT_MS} 會先被 runner 的 --kill-after=30s KILL`);
});

// --- T8：settle 的 resume promise 明確 catch ---

test('T8：SIGINT settle 的 resume promise 明確 catch——reject 不產生 unhandled rejection', async () => {
  const harness = makeHarness();
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    // stub：checkpoint 非 unstarted（視為有在飛 run）＋ resume 直接 reject
    const rejectingAi = {
      exportDayCheckpoint: () => ({ runId: 'day1-run' }),
      resumeDayDiscussion: () => Promise.reject(new Error('llm boom')),
    };
    await settleInFlightWork(harness.game, rejectingAi);
    await new Promise((resolve) => setTimeout(resolve, 50)); // 給 event loop 機會沖出任何 unhandledRejection
    assert.equal(unhandled.length, 0, `仍有 ${unhandled.length} 個 unhandled rejection：${unhandled[0]?.message ?? unhandled[0]}`);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    destroyHarness(harness);
  }
});

// --- T9：isMain 路徑比較（Windows insensitive） ---

test('T9：isMainModule——精確路徑 true；大小寫差異 Windows true、Linux false', () => {
  const selfPath = fileURLToPath(new URL('./external-test-stage2.mjs', import.meta.url));
  assert.equal(isMainModule(selfPath), true);
  assert.equal(isMainModule(undefined), false);
  // 取路徑中第一個小寫字轉成大寫，製造大小寫不一致的同一條路徑
  const lowerIdx = selfPath.search(/[a-z]/);
  assert.notEqual(lowerIdx, -1);
  const mismatched = selfPath.slice(0, lowerIdx) + selfPath[lowerIdx].toUpperCase() + selfPath.slice(lowerIdx + 1);
  const expected = process.platform === 'win32' ? true : false;
  assert.equal(isMainModule(mismatched), expected, `${process.platform} 大小寫不一致路徑應為 ${expected}`);
});
