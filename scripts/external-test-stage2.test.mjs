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
 *   T10 boardSection：三種白板（狼/共有者/白天）標題與每則訊息格式一致
 *   T11 discussionLogLine：MASON_MESSAGE 與另兩塊白板同格式入 log；其他事件 null
 *   T12 dayDiscussionSection：DAY_STANCE 可被渲染、WOLF_STANCE 不再誤渲染為白天回應
 *   T13 --stop-after-first-message：無值 flag 解析、預設關閉；baseline 只算公頻 MESSAGE 且需 baseline+1
 *   T14 bounded stop：resume 只發一則 public MESSAGE、無 day response LLM 呼叫；published committed ＋ speaker ready
 *   T15 stop 一次性消費（第二次 resume 續跑 responses）；沒有 publish 就結束時不卡死
 *   T16 first-message stop 的報告／存檔不會撞上未完成的 publish，resume reject 不變 unhandled rejection
 *   T17 first-message stop 在 status／report／exit code 都是成功目標（既有 stop-at 語意不變）
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
  STOP_AFTER_FIRST_MESSAGE_FLAG,
  FIRST_MESSAGE_STOP_LABEL,
  validateStopAt,
  isMainModule,
  settleInFlightWork,
  atomicWriteJson,
  buildEnvelope,
  buildReport,
  loadEnvelope,
  validateEnvelope,
  stage2ResumeImport,
  stage2ResumeRun,
  resumeStage2State,
  parseStopAfterFirstMessage,
  publicDayMessageCount,
  firstMessageStopReached,
  awaitResumeCommit,
  stage2StatusLine,
  stage2ExitCode,
  boardSection,
  discussionLogLine,
  dayDiscussionSection,
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

// --- T10：共用白板 renderer——三種白板格式一致 ---

test('T10：boardSection——狼/共有者/白天三塊白板標題與訊息行格式完全一致', () => {
  const ts = Date.parse('2026-01-01T00:00:00Z');
  const events = [
    { ts, type: 'WOLF_MESSAGE', from: 'A', text: '狼文字' },
    { ts, type: 'MASON_MESSAGE', from: 'B', text: '共有者文字' },
    { ts, type: 'MESSAGE', from: 'C', text: '白天文字' },
  ];
  const cases = [
    { type: 'WOLF_MESSAGE', name: '狼', from: 'A', text: '狼文字' },
    { type: 'MASON_MESSAGE', name: '共有者', from: 'B', text: '共有者文字' },
    { type: 'MESSAGE', name: '白天', from: 'C', text: '白天文字' },
  ];
  // 三塊白板同構：標題 / 空行 / `- [ts] 來源：「text」` / 空行（來源與 text 都顯示）
  for (const c of cases) {
    assert.deepEqual(boardSection(events, c.type, c.name), [
      `## ${c.name}白板（${c.type}）`,
      '',
      `- [${new Date(ts).toISOString()}] ${c.from}：「${c.text}」`,
      '',
    ], `boardSection(${c.type}) 格式與共構不符`);
  }
  // 空白板：三塊都顯示同一「（無）」佔位
  for (const c of cases) {
    assert.deepEqual(boardSection([], c.type, c.name), [`## ${c.name}白板（${c.type}）`, '', '（無）', '']);
  }
});

// --- T11：DISCUSSION_LOG 行——MASON_MESSAGE 與另兩塊白板一致 ---

test('T11：discussionLogLine——三種白板（含 MASON_MESSAGE）同格式入 log；其他事件回 null', () => {
  // 三種白板事件同形狀（from + text），log 行同格式「[hh:mm:ss] 來源: text」
  for (const type of ['MESSAGE', 'WOLF_MESSAGE', 'MASON_MESSAGE']) {
    const line = discussionLogLine({ type, from: 'B', text: '你好' });
    assert.ok(line !== null, `${type} 應被記錄進討論 log`);
    assert.match(line, /^\[\d{2}:\d{2}:\d{2}\] B: 你好$/);
  }
  // READY 維持既有摘要格式
  assert.match(discussionLogLine({ type: 'DAY_READY_STATUS', ready: [{ nickname: 'B' }], total: 2 }), /^\[READY\] B \(1\/2\)$/);
  // 非白板事件不記錄
  assert.equal(discussionLogLine({ type: 'PHASE_CHANGED', phase: 'DAY_VOTING' }), null);
  assert.equal(discussionLogLine({ type: 'VOTE_RESULT', from: 'B', text: 'x' }), null);
});

// --- T12：白天回應——DAY_STANCE 可被渲染、WOLF_STANCE 不再誤渲染 ---

test('T12：dayDiscussionSection——DAY_STANCE 渲染為「其他 AI 回應」；WOLF_STANCE 不誤渲染', () => {
  const base = Date.parse('2026-01-01T00:00:00Z');
  const players = [
    { clientId: 'ai-a', nickname: 'A' },
    { clientId: 'ai-b', nickname: 'B' },
    { clientId: 'ai-c', nickname: 'C' },
  ];
  const events = [
    { ts: base, type: 'PHASE_CHANGED', phase: 'DAY_DISCUSSION', day: 1 },
    { ts: base + 1000, type: 'MESSAGE', from: 'A', text: 'A 先發言' },
  ];
  const log = [
    // 正確的白天回應 kind：ai-b（DAY_STANCE）
    { ts: base + 1500, kind: 'DAY_STANCE', clientId: 'ai-b', round: 1, attempt: 0, response: {}, parsed: { action: 'ready' } },
    // 舊 bug 的 kind：ai-c 的 WOLF_STANCE——若過濾未修正，它也會被渲染進白天回應
    { ts: base + 1600, kind: 'WOLF_STANCE', clientId: 'ai-c', round: 1, attempt: 0, response: {}, parsed: { action: 'ready' } },
  ];
  const section = dayDiscussionSection(log, events, players).join('\n');
  assert.ok(section.includes('### 輪次 1'), '流程摘要使用輪次標題');
  assert.ok(section.includes('Judge 選出：** A → 發布「A 先發言」'), '白天流程應顯示 Judge 選出與發布內容');
  assert.ok(section.includes('**A：** ✅ ready'), '發言者 ready 狀態應保留');
  assert.ok(!section.includes('2026-01-01T00:00:00.000Z'), '白天流程不應使用 timestamp 發言格式');
  assert.ok(section.includes('B：✅ ready'), 'DAY_STANCE 應被渲染為白天回應');
  assert.ok(!section.includes('C：✅ ready'), 'WOLF_STANCE 不應被誤渲染為白天回應');
});

// --- T13：--stop-after-first-message flag 解析與 baseline 計算 ---

test('T13：--stop-after-first-message 是無值 flag 且預設關閉；baseline 只算公頻 MESSAGE 並需 baseline+1', async () => {
  // 解析：只看 token 是否存在，不消費後面值；未給 flag 一律 false（既有命令行為不變）
  assert.equal(parseStopAfterFirstMessage([]), false);
  assert.equal(parseStopAfterFirstMessage(['--stop-at', 'DAY_RESULT']), false);
  assert.equal(parseStopAfterFirstMessage(['--resume', '/tmp/state.json']), false);
  assert.equal(parseStopAfterFirstMessage(['--resume', '/tmp/state.json', '--stop-after-first-message']), true);
  assert.equal(parseStopAfterFirstMessage([STOP_AFTER_FIRST_MESSAGE_FLAG, '--report', 'out.md']), true);
  // 無值 flag：後面接的任何 token 都不被當成它的值
  assert.equal(parseStopAfterFirstMessage([STOP_AFTER_FIRST_MESSAGE_FLAG, 'false']), true);

  const harness = makeHarness();
  try {
    assert.equal(publicDayMessageCount(harness.game), 0, '未發言時公頻訊息數為 0');
    harness.game.sendDayMessage('ai-a', '第一則');
    // WOLF_MESSAGE / MASON_MESSAGE 屬私頻：不進 dayMessages，不得被算進 baseline
    harness.broadcasts.push({ type: 'WOLF_MESSAGE', from: 'A', text: '狼文字' });
    harness.broadcasts.push({ type: 'MASON_MESSAGE', from: 'A', text: '共有者文字' });
    const baseline = publicDayMessageCount(harness.game);
    assert.equal(baseline, 1, '私頻訊息不計入公頻 baseline');
    assert.equal(firstMessageStopReached(harness.game, baseline), false, '還沒到 baseline+1 不得停止');
    harness.game.sendDayMessage('ai-b', '第二則');
    assert.equal(firstMessageStopReached(harness.game, baseline), true, '到 baseline+1 即為 bounded stop 達成');
  } finally {
    destroyHarness(harness);
  }
});

// --- T14：bounded stop 只跑一則 public MESSAGE（controller 層） ---

test('T14：requestStopAfterNextDayPublish——publish commit 後立即結束，只有一則 public MESSAGE、無 day response LLM 呼叫', async () => {
  const counts = { strategy: [], draft: [], judge: [], expand: [], respond: [] };
  const harness = makeHarness(makeCountingAdapter(counts));
  try {
    const baseline = publicDayMessageCount(harness.game);
    harness.ai.setPhaseStartEnabled(true);
    harness.ai.requestStopAfterNextDayPublish(); // resume 前開啟 bounded stop
    await harness.ai.resumeDayDiscussion();

    // 只跑到第一則公頻發言：不進 responses、不開下一輪 draft
    assert.equal(countType(harness.broadcasts, 'MESSAGE'), 1);
    assert.equal(publicDayMessageCount(harness.game), baseline + 1);
    assert.equal(firstMessageStopReached(harness.game, baseline), true);
    assert.deepEqual(counts.respond, [], 'stop 之後不得再呼叫 day response LLM');
    assert.deepEqual(counts.judge, [1], '只 judge 一次（只 publish 一輪）');

    // published checkpoint 已 committed ＋ identity 已記錄
    const checkpoint = harness.ai.exportDayCheckpoint();
    assert.ok(checkpoint, '不得呼叫 destroy；stop 後 checkpoint 必須仍可 export');
    assert.equal(checkpoint.published.status, 'committed');
    assert.equal(checkpoint.stage, 'responses', 'stop 後 checkpoint 停在 publish 後的 responses（可再 resume 續跑）');
    const publishedMessage = harness.game.getDayState().dayMessages[0];
    assert.equal(checkpoint.published.messageId, publishedMessage.id);
    assert.equal(checkpoint.published.messageSeq, publishedMessage.seq);
    assert.equal(checkpoint.published.clientId, checkpoint.selectedClientId);

    // 發言者 ready 已 commit
    assert.equal(checkpoint.published.readyValue, true);
    assert.equal(harness.game.getDayState().dayReady.get(checkpoint.published.clientId), true);
    // 其他 AI 未 ready（沒跑 responses），engine 留在 DAY_DISCUSSION
    assert.equal(harness.game.getNightState().phase, 'DAY_DISCUSSION');
    assert.deepEqual(
      checkpoint.responses.map((entry) => entry.status),
      ['pending', 'pending'],
      'response slots 保留為 pending，尚未執行',
    );
  } finally {
    destroyHarness(harness);
  }
});

// --- T15：一次性消費；沒有 publish 就不卡死 ---

test('T15：bounded stop 只對下一次 publish 生效（消費後清除）；沒有 publish 就結束時正常 return 不卡死', async () => {
  // (a) 沒有 publish 的 run：all-AI-ready 直接 reconcile——正常結束，不發言、不呼叫 LLM
  const stuckCounts = { strategy: [], draft: [], judge: [], expand: [], respond: [] };
  const stuck = makeHarness(makeCountingAdapter(stuckCounts));
  try {
    // 只有 AI ready（human 永不 ready）：engine 留在 DAY_DISCUSSION，AI loop 走 reconcile→complete
    stuck.game.state.dayReady = new Map(CLIENT_IDS.map((clientId) => [clientId, clientId !== 'human']));
    stuck.ai.requestStopAfterNextDayPublish();
    await stuck.ai.resumeDayDiscussion(); // 必須 resolve（不可卡死）
    assert.equal(countType(stuck.broadcasts, 'MESSAGE'), 0);
    assert.deepEqual(stuckCounts.strategy, []);
    assert.deepEqual(stuckCounts.draft, []);
    assert.deepEqual(stuckCounts.respond, []);
    const afterReconcile = stuck.ai.exportDayCheckpoint();
    assert.ok(afterReconcile);
    assert.equal(afterReconcile.stage, 'complete', '沒有 publish 時旗標不影響原本的 reconcile→complete 流程');
    assert.equal(stuck.game.getNightState().phase, 'DAY_DISCUSSION'); // human 未 ready
  } finally {
    destroyHarness(stuck);
  }

  // (b) 已消費的 stop 不可殘留：再 resume 一次會續跑 responses，而不是再次在第一則發言後停住
  const counts = { strategy: [], draft: [], judge: [], expand: [], respond: [] };
  const harness = makeHarness(makeCountingAdapter(counts));
  try {
    harness.ai.setPhaseStartEnabled(true);
    harness.ai.requestStopAfterNextDayPublish();
    await harness.ai.resumeDayDiscussion();
    assert.equal(countType(harness.broadcasts, 'MESSAGE'), 1);
    assert.deepEqual(counts.respond, []);

    await harness.ai.resumeDayDiscussion(); // 第二次 resume：沒有再請求 stop
    assert.deepEqual(counts.respond.sort(), ['ai-b', 'ai-c'], '消費後的 resume 應續跑 day responses');
    assert.equal(countType(harness.broadcasts, 'MESSAGE'), 1, 'responses 沒有新草稿時不得再發布');
    const after = harness.ai.exportDayCheckpoint();
    assert.ok(after);
    assert.equal(after.stage, 'complete');
  } finally {
    destroyHarness(harness);
  }
});

// --- T16：first-message stop 的報告／存檔 race 與 unhandled rejection ---

test('T16：first-message stop 的存檔不會撞上未完成的 publish；resume reject 不產生 unhandled rejection', async () => {
  const counts = { strategy: [], draft: [], judge: [], expand: [], respond: [] };
  const harness = makeHarness(makeCountingAdapter(counts));
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const baseline = publicDayMessageCount(harness.game);
    harness.ai.setPhaseStartEnabled(true);
    harness.ai.requestStopAfterNextDayPublish();
    // 與 main() 相同：resume promise 先明確 catch，之後 await 才寫報告／存檔
    const resumePromise = awaitResumeCommit(harness.ai.resumeDayDiscussion());

    // 模擬 observation loop：數到 baseline+1 就 break
    await eventually(() => firstMessageStopReached(harness.game, baseline), 'bounded stop 沒有在第一則公頻 MESSAGE 後達成');
    // 寫檔前必須等這次 resume 完成——publish commit 此時才完整
    await resumePromise;
    const envelope = buildEnvelope({ game: harness.game, ai: harness.ai, events: harness.broadcasts, stopAt: 'DAY_RESULT' });
    assert.equal(envelope.ai.published.status, 'committed', '存檔時 published 必須已 committed（不可是 pending）');
    assert.ok(envelope.ai.published.messageId, '存檔時 published identity 必須已寫入');
    assert.equal(envelope.game.dayMessages.length, baseline + 1, '存檔時只應有一則新公頻訊息');
    assert.deepEqual(counts.respond, []);
    // envelope 必須可再 --resume（走真正的 validateEnvelope 契約）
    assert.equal(validateEnvelope(envelope), null);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(unhandled.length, 0, `仍有 ${unhandled.length} 個 unhandled rejection：${unhandled[0]?.message ?? unhandled[0]}`);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    destroyHarness(harness);
  }

  // awaitResumeCommit 對 reject 的 resume 也必須吸收（不得變成 unhandled rejection）
  const rejecting = [];
  const onUnhandledReject = (reason) => { rejecting.push(reason); };
  process.on('unhandledRejection', onUnhandledReject);
  try {
    await awaitResumeCommit(Promise.reject(new Error('resume boom')));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(rejecting.length, 0, `reject 的 resume 仍產生 ${rejecting.length} 個 unhandled rejection`);
  } finally {
    process.removeListener('unhandledRejection', onUnhandledReject);
  }
});

// --- T17：status／report／exit code 把 first-message stop 當成功目標 ---

test('T17：first-message stop 在 status／report／exit code 都是成功目標；既有 stop-at 語意不變', async () => {
  // status
  assert.match(stage2StatusLine({ stopAt: 'DAY_RESULT', converged: false, firstMessageStop: true }), /first public message stop/);
  // exit code：first-message stop = 成功目標；存檔失敗仍為 1
  assert.equal(stage2ExitCode({ converged: false, firstMessageStop: true, saveFailed: false }), 0);
  assert.equal(stage2ExitCode({ converged: false, firstMessageStop: true, saveFailed: true }), 1);
  // 既有行為不變
  assert.equal(stage2StatusLine({ stopAt: 'DAY_RESULT', converged: true }), 'DAY_RESULT 達成');
  assert.match(stage2StatusLine({ converged: false, aborted: true }), /未收斂/);
  assert.match(stage2StatusLine({ converged: false, signal: 'SIGINT' }), /中斷/);
  assert.equal(stage2ExitCode({ converged: true, saveFailed: false }), 0);
  assert.equal(stage2ExitCode({ converged: true, saveFailed: true }), 1);
  assert.equal(stage2ExitCode({ converged: false, firstMessageStop: false, saveFailed: false }), 1);

  const harness = makeHarness();
  try {
    const stopped = buildReport(harness.game, harness.ai, harness.broadcasts, DEFS, false, false, 'DAY_RESULT', 'DAY_DISCUSSION', { firstMessageStop: true, baseline: 0 });
    assert.match(stopped, /- 結果：✅ 達成（first public message stop）/);
    assert.match(stopped, /- 停止控制：--stop-after-first-message/);
    assert.match(stopped, /## 收斂[\s\S]*first public message stop/);
    assert.ok(!stopped.includes('未收斂（階段 timeout）'), 'first-message stop 不可被標成未收斂');

    // 未使用 stop 時 report 不出現該標記（既有命令輸出不變）
    const plain = buildReport(harness.game, harness.ai, harness.broadcasts, DEFS, true, false, 'DAY_RESULT', 'DAY_RESULT');
    assert.ok(!plain.includes('first public message stop'));
    assert.match(plain, /- 結果：✅ 達成/);
  } finally {
    destroyHarness(harness);
  }
});
