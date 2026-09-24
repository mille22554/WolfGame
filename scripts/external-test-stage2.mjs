#!/usr/bin/env node
/**
 * external-test-stage2.mjs — Stage 2 外部測試：15 人全 AI 局（分階段可選、可恢復）
 *
 * 用法：
 *   node scripts/external-test-stage2.mjs [--stop-at PHASE] [--report PATH]
 *   node scripts/external-test-stage2.mjs --stop-at NIGHT_RESULT --save-state /path/state.json
 *   node scripts/external-test-stage2.mjs --stop-at DAY_RESULT --resume /path/state.json
 *
 * PHASE 選項：
 *   NIGHT_RESULT  — 只跑夜晚（mason→wolf→seer/guard→結算），到 DAY_DISCUSSION 開始時停止
 *   DAY_RESULT    — 跑完整天（night + day discussion + voting），到 DAY_RESULT 停止（預設）
 *   GAME_OVER     — 跑完整局（多天）直到 GAME_OVER
 *
 * 存檔／恢復（單一 envelope，schemaVersion=2）：
 *   { schemaVersion, savedAt, stopAt, game, ai, events, aiLog }
 * - game / ai / events / aiLog 在同一 tick 抓取並原子寫入（temp file + rename）；失敗不覆蓋舊檔
 * - resume 順序（明確，不自動重播）：
 *     1. ai.setPhaseStartEnabled(false) — barrier：restoreState 的 PHASE_CHANGED 不自動啟動白天 loop
 *     2. game.restoreState(env.game)
 *     3. ai.restoreLog(env.aiLog)        — 縫回前段 LLM log
 *     4. ai.importDayCheckpoint(env.ai)
 *     5. ai.resumeDayDiscussion()        — 從存檔 stage 續跑；all-ready 時 loop 才呼叫 reconcileDayReady
 * - 只支援 DAY_DISCUSSION restore；舊三檔格式（state + .events.json + .log.json）明確拒絕
 *
 * SIGINT/SIGTERM：停止新工作，等待目前 in-flight continuation/LLM 安全結束後再存一致 snapshot（避免半寫）。
 *
 * 在 server 上跑：SGLANG_API_KEY=xxx node scripts/external-test-stage2.mjs --stop-at NIGHT_RESULT
 * - import dist/lobby-server/ 編譯產物（GameEngine + AiController）
 * - 建 15 人全 AI 局
 * - 各階段不限時（night/day 皆等待收斂，無 timeout 截斷）
 * - 產出 markdown 報告（--report 或 REPORT env 或依階段預設：night/day/full）
 * - exit code：0 = 目標階段完成且（若指定 --save-state）存檔成功、1 = 未收斂（安全上限 / timeout / 中斷）或存檔失敗
 */
import { writeFileSync, readFileSync, appendFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { GameEngine } from '../dist/lobby-server/game.js';
import { AiController, AI_DAY_CHECKPOINT_SCHEMA_VERSION } from '../dist/lobby-server/ai-controller.js';

// --- 常數：存檔格式與觀察 ---
export const STAGE2_STATE_SCHEMA_VERSION = 2; // 2 = 單一 envelope（含 ai checkpoint）；無 schemaVersion = 舊三檔格式（明確拒絕）
/** SIGINT settle 上限：必須小於外部 runner 的 30s kill-after（`timeout --signal=INT --kill-after=30s`），
 *  上限一過就該寫一致 snapshot 並 exit；25s 留約 5s 給「寫檔＋destroy＋exit」收尾，避免 30s 時被 runner 直接 KILL。
 *  上限到期時 LLM 仍在飛也沒關係（目前 tick 的 snapshot 仍一致，下次 resume 依 pending 補做）。 */
export const SIGINT_SETTLE_TIMEOUT_MS = 25_000;
const POLL_INTERVAL_MS = 500;
const PROGRESS_INTERVAL_MS = 600_000;
const DISCUSSION_LOG = join(tmpdir(), 'day-discussion.log'); // 實時討論記錄（tail -f 可看；server 上 tmpdir 即 /tmp）

// 各階段 timeout（0 = 不限時）
const TIMEOUTS = {
  NIGHT: 0,
  DAY: 0,
};

// 15 個 AI 人格（characterId → 中文名；與 character/<id>/agents.md 的中文名一致）
const CHARACTERS = [
  ['aoi', '葵'], ['chihiro', '千尋'], ['futa', '二葉'], ['kenta', '健太'], ['koharu', '小晴'],
  ['misaki', '美咲'], ['ren', '蓮'], ['rin', '鈴'], ['ryoko', '良子'], ['sayuki', '佐雪'],
  ['shinichi', '真一'], ['shota', '翔太'], ['tatuya', '太助'], ['yuko', '裕子'], ['yuma', '優馬'],
];

// 未指定 --report 時依階段用不同預設路徑（避免 night/day 報告互相覆蓋）
const DEFAULT_REPORT_BY_PHASE = {
  NIGHT_RESULT: 'ai-trace-stage2-night.md',
  DAY_RESULT: 'ai-trace-stage2-day.md',
  GAME_OVER: 'ai-trace-stage2-full.md',
};

// --stop-at 白名單（啟動時驗證；未知值明確報錯並 exit 1，不啟動遊戲）
export const STOP_AT_PHASES = ['NIGHT_RESULT', 'DAY_RESULT', 'GAME_OVER'];

/** 驗證 --stop-at 值；回傳錯誤說明（未知值）或 null（有效）。 */
export function validateStopAt(value) {
  return STOP_AT_PHASES.includes(value)
    ? null
    : `未知的 --stop-at 值「${String(value)}」（可用：${STOP_AT_PHASES.join(' / ')}）`;
}

function getArg(flag, defaultValue) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : defaultValue;
}

// 判斷「目標階段完成」的條件
function isTargetReached(phase, stopAt) {
  if (stopAt === 'NIGHT_RESULT') return phase === 'DAY_DISCUSSION' || phase === 'DAY_VOTING' || phase === 'DAY_RESULT' || phase === 'GAME_OVER';
  if (stopAt === 'DAY_RESULT') return phase === 'DAY_RESULT' || phase === 'GAME_OVER';
  if (stopAt === 'GAME_OVER') return phase === 'GAME_OVER';
  return false;
}

// 目前所在大階段（決定用哪個 timeout）
function currentMajorPhase(phase) {
  if (phase === 'NIGHT') return 'NIGHT';
  return 'DAY'; // DAY_DISCUSSION / DAY_VOTING / DAY_RESULT 都算 day
}

// --- 存檔：單一 envelope ＋ 原子寫入 ---

/** 原子寫入：先寫同目錄 temp 檔再 rename 到目標；失敗時清理 temp，絕不覆蓋舊檔。 */
export function atomicWriteJson(finalPath, payload) {
  mkdirSync(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    renameSync(tmpPath, finalPath); // 同一 filesystem 的 rename 是原子替換
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* temp 未建立成功，無需清理 */ }
    throw err; // 舊檔維持原樣
  }
}

/**
 * 組建單一 envelope：同一 tick 抓取 game/ai/events/aiLog，四段互不矛盾。
 * phase 已不在 DAY_DISCUSSION 時 ai 為 null（存檔不可 resume，會印出警告）。
 */
export function buildEnvelope({ game, ai, events, stopAt }) {
  const aiCheckpoint = ai.exportDayCheckpoint();
  if (aiCheckpoint === null) {
    console.warn('[stage2] ⚠️ 目前 phase 已不在 DAY_DISCUSSION；此存檔的 ai 段為 null，無法 --resume');
  }
  return {
    schemaVersion: STAGE2_STATE_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    stopAt,
    game: game.saveState(),
    ai: aiCheckpoint,
    events: [...events],
    aiLog: ai.getLog(),
  };
}

/** 存單一 envelope（原子寫入）；失敗時丟出例外、舊檔保留。 */
export function saveStage2State(path, parts) {
  atomicWriteJson(path, buildEnvelope(parts));
  console.log(`[stage2] 狀態存檔已寫入 ${path}（單一 envelope，可 --resume ${path} 接續）`);
}

/** 驗證 envelope 結構；回傳錯誤說明（無效）或 null（有效）。舊三檔格式與非 DAY_DISCUSSION 皆明確拒絕。 */
export function validateEnvelope(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return '存檔格式不明（頂層需為 JSON object）';
  if (env.schemaVersion !== STAGE2_STATE_SCHEMA_VERSION) {
    return `不支援的存檔格式（schemaVersion=${String(env.schemaVersion)}）：舊三檔格式（state + .events.json + .log.json）已停用，只能 resume 單一 envelope v${STAGE2_STATE_SCHEMA_VERSION}`;
  }
  if (!env.game || typeof env.game !== 'object') return 'envelope 缺少 game 段或格式無效';
  if (env.game.phase !== 'DAY_DISCUSSION') return `只支援 DAY_DISCUSSION restore；存檔 game phase 為 ${String(env.game.phase)}`;
  if (!Array.isArray(env.game.players) || env.game.players.length === 0) return 'game 段缺少 players 陣列或為空';
  if (!env.ai || typeof env.ai !== 'object') return 'envelope 缺少 ai 段或無效（存檔時 phase 已不在 DAY_DISCUSSION 即無法 resume）';
  if (env.ai.schemaVersion !== AI_DAY_CHECKPOINT_SCHEMA_VERSION) return `ai checkpoint 無效（schemaVersion=${String(env.ai.schemaVersion)}，預期 ${AI_DAY_CHECKPOINT_SCHEMA_VERSION}）`;
  if (env.ai.phase !== 'DAY_DISCUSSION') return `ai checkpoint phase=${String(env.ai.phase)}；只支援 DAY_DISCUSSION`;
  if (typeof env.game.day !== 'number' || env.game.day !== env.ai.day) return 'game 與 ai 段的 day 不一致';
  if (!Array.isArray(env.events)) return 'envelope 缺少 events 段或無效';
  if (!Array.isArray(env.aiLog)) return 'envelope 缺少 aiLog 段或無效';
  return null;
}

/** 讀取並驗證存檔；舊格式 / 無效 / 非 DAY_DISCUSSION 皆明確丟出原因。 */
export function loadEnvelope(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`無法讀取存檔 ${path}：${err.message}`);
  }
  let env;
  try {
    env = JSON.parse(raw);
  } catch {
    throw new Error(`存檔 ${path} 不是有效 JSON`);
  }
  const problem = validateEnvelope(env);
  if (problem) throw new Error(problem);
  return env;
}

// --- 恢復：barrier → game restore → ai import → ai resume ---

/**
 * 步驟 1：barrier → game.restoreState → ai.restoreLog → ai.importDayCheckpoint。
 * barrier 避免 restoreState 送的 PHASE_CHANGED(DAY_DISCUSSION) 自動啟動白天 loop
 * （否則會重做已完成階段）。import 對無效輸入是 safe no-op；這裡再驗證 import
 * 真的有生效（runId 不再是 unstarted），否則明確丟出錯誤。
 */
export function stage2ResumeImport(game, ai, env) {
  const problem = validateEnvelope(env);
  if (problem) throw new Error(problem);
  ai.setPhaseStartEnabled(false);
  game.restoreState(env.game); // 它送出的 PHASE_CHANGED / DAY_READY_STATUS 廣播會被 barrier 吸收
  ai.restoreLog(env.aiLog); // 縫回前段 LLM log（跨段報告用）
  ai.importDayCheckpoint(env.ai);
  const exported = ai.exportDayCheckpoint();
  if (!exported || exported.runId.endsWith('-unstarted')) {
    throw new Error('ai checkpoint 匯入未生效（roster/day/phase 或結構不符）；請確認存檔與本次 session 一致');
  }
  return exported;
}

/**
 * 步驟 2：重新啟用白天自動啟動（供後續新的一天），再明確呼叫 resumeDayDiscussion。
 * loop 從 import 的 stage 續跑：已完成階段不重做；只有 all AI ready 時才進 reconcile
 * 階段並呼叫 game.reconcileDayReady()（推進到 DAY_VOTING）。
 * 本函式不直接呼叫 reconcileDayReady，也不重播 publish/ready。
 */
export function stage2ResumeRun(game, ai) {
  ai.setPhaseStartEnabled(true);
  return ai.resumeDayDiscussion();
}

/** 完整 resume 流程（步驟 1 → 步驟 2，依序）。 */
export async function resumeStage2State(game, ai, env) {
  stage2ResumeImport(game, ai, env);
  return stage2ResumeRun(game, ai);
}

// --- 觀察與 shutdown ---

/** 輸出當前進度（每 10 分鐘一次） */
function logProgress(game, s, phaseStarted) {
  const elapsed = Math.round((Date.now() - phaseStarted) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  if (s.phase === 'DAY_DISCUSSION') {
    const alive = game.getAlivePlayers();
    const readyCount = alive.filter((p) => game.state.dayReady.get(p.clientId) === true).length;
    console.log(`[progress] ${mins}m${secs}s | ${s.phase} | ready: ${readyCount}/${alive.length}`);
  } else if (s.phase === 'DAY_VOTING') {
    const alive = game.getAlivePlayers();
    const voted = alive.filter((p) => game.state.votes.some((v) => v.voterClientId === p.clientId)).length;
    console.log(`[progress] ${mins}m${secs}s | ${s.phase} | votes: ${voted}/${alive.length}`);
  } else if (s.phase === 'NIGHT') {
    console.log(`[progress] ${mins}m${secs}s | ${s.phase} | step: ${s.nightStep} | wolfRound: ${s.wolfMeetingRound} | wolfMsgs: ${s.wolfMessageCount}`);
  } else {
    console.log(`[progress] ${mins}m${secs}s | ${s.phase}`);
  }
}

/**
 * SIGINT/SIGTERM：若有 in-flight 的 DAY_DISCUSSION continuation，等待它安全結束再存 snapshot。
 * resumeDayDiscussion 是 single-flight：有進行中 run 時回傳同一個 promise。
 * 上限到期後仍在跑也沒關係——目前 tick 導出的 snapshot 仍是一致的（在飛的 LLM 結果只是
 * 未包含在本次存檔；下次 resume 會依 pending 狀態補做）。
 * resume promise 一律明確 catch（race 落敗或 run 自身 reject 時記錄錯誤，不丟 unhandled rejection）。
 */
export async function settleInFlightWork(game, ai) {
  if (game.getNightState().phase !== 'DAY_DISCUSSION') return;
  const probe = ai.exportDayCheckpoint();
  if (!probe || probe.runId.endsWith('-unstarted')) return; // 沒有進行中的 continuation，直接走安全點
  const resume = ai.resumeDayDiscussion();
  // 明確 catch：timeout 贏走 race 時，落敗的 resume promise 不得變成 unhandled rejection
  const settled = resume.catch((err) => {
    console.error(`[stage2] ⚠️ 在飛的 discussion run 失敗：${err?.message ?? err}（snapshot 仍依目前 tick 一致寫入，下次 resume 補做）`);
  });
  const timeout = new Promise((done) => {
    const timer = setTimeout(done, SIGINT_SETTLE_TIMEOUT_MS);
    timer.unref(); // 不要讓這個上限 timer 撐住 event loop
  });
  await Promise.race([settled, timeout]);
}

/** 註冊 SIGINT/SIGTERM：第一次訊號即停止新工作（回傳可觀測的 hooks 狀態）。 */
function createShutdownHooks() {
  const hooks = { requested: false, signal: null };
  const onSignal = (sig) => {
    if (hooks.requested) return;
    hooks.requested = true;
    hooks.signal = sig;
    console.log(`[stage2] 收到 ${sig}：停止新工作；等待進行中的 continuation/LLM 安全結束後再存一致 snapshot`);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  return hooks;
}

/** 分階段 timeout 輪詢觀察；目標達成／狼會議 abort／階段超時／外部訊號 → break。 */
async function runObservationLoop(game, stopAt, isStopped) {
  let converged = false;
  let aborted = false;
  let phaseTimeout = TIMEOUTS.NIGHT;
  let phaseStarted = Date.now();
  let lastMajorPhase = 'NIGHT';
  let lastProgressLog = Date.now();
  while (true) {
    if (isStopped()) break; // SIGINT/SIGTERM：停止新工作
    const s = game.getNightState();
    const major = currentMajorPhase(s.phase);
    if (Date.now() - lastProgressLog >= PROGRESS_INTERVAL_MS) {
      lastProgressLog = Date.now();
      logProgress(game, s, phaseStarted);
    }
    if (major !== lastMajorPhase) {
      lastMajorPhase = major;
      phaseStarted = Date.now();
      phaseTimeout = TIMEOUTS[major] ?? TIMEOUTS.DAY;
      console.log(`[stage2] 進入 ${s.phase}（timeout ${phaseTimeout > 0 ? phaseTimeout / 1000 + 's' : '不限時'}）`);
    }
    if (isTargetReached(s.phase, stopAt)) {
      converged = true;
      break;
    }
    if (s.wolfMeetingAborted) {
      aborted = true;
      break;
    }
    if (phaseTimeout > 0 && Date.now() - phaseStarted > phaseTimeout) {
      console.error(`[stage2] ⚠️ ${s.phase} 階段超時（${phaseTimeout / 1000}s）`);
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { converged, aborted };
}

/**
 * 實時討論 log 的一行內容：三種白板（MESSAGE / WOLF_MESSAGE / MASON_MESSAGE）
 * 同格式「時間 來源: text」；DAY_READY_STATUS 是 READY 摘要；其他事件回 null（不記錄）。
 */
export function discussionLogLine(m) {
  if (m.type === 'DAY_READY_STATUS') {
    return `[READY] ${m.ready.map((r) => r.nickname).join(', ')} (${m.ready.length}/${m.total})`;
  }
  if (m.type === 'MESSAGE' || m.type === 'WOLF_MESSAGE' || m.type === 'MASON_MESSAGE') {
    return `[${new Date().toISOString().slice(11, 19)}] ${m.from}: ${m.text}`;
  }
  return null;
}

/** 組 15 個 AiPlayerDef 的 AiController ＋ GameEngine（engine callback 接進 AI 控制器）。 */
function buildGameAndAi() {
  const defs = CHARACTERS.map(([characterId, nickname], i) => ({ clientId: `ai-${i}`, nickname, characterId }));
  const ai = new AiController(defs, { messageCap: 100 });
  const events = []; // 所有 S→C 訊息（報告用）
  writeFileSync(DISCUSSION_LOG, '', 'utf-8');
  const game = new GameEngine('STAGE2', defs.map((d) => ({ clientId: d.clientId, nickname: d.nickname })), {
    sendTo: (cid, m) => ai.handlePrivate(cid, m),
    broadcast: (m, targets) => {
      ai.handleBroadcast(m, targets);
      events.push({ ts: Date.now(), type: m.type, ...m });
      // 實時寫入討論 log（三種白板 MESSAGE / WOLF_MESSAGE / MASON_MESSAGE ＋ READY；格式由 discussionLogLine 統一）
      const line = discussionLogLine(m);
      if (line !== null) appendFileSync(DISCUSSION_LOG, line + '\n', 'utf-8');
    },
    onNightStepActive: (step, players) => ai.onNightStepActive(step, players),
    onWolfSubphaseChange: (sub, round) => ai.onWolfSubphaseChange(sub, round),
  }, 100);
  ai.setGame(game);
  return { game, ai, defs, events };
}

/** 從存檔恢復：驗證 envelope → barrier → restore → import → 明確 resume。 */
function startResumedGame(game, ai, events, resumePath) {
  const env = loadEnvelope(resumePath); // 舊格式 / 非 DAY_DISCUSSION / 損毀 → 明確 throw
  events.push(...env.events); // 載入前段 events（報告用）
  stage2ResumeImport(game, ai, env);
  // 明確 resume（single-flight）；fire-and-forget 的 promise 要明確 catch，reject 時記錄而非 unhandled rejection
  stage2ResumeRun(game, ai).catch((err) => {
    console.error(`[stage2] ⚠️ resume 執行失敗：${err?.message ?? err}（遊戲照跑，最終以收斂狀態定 exit code）`);
  });
  console.log(`[stage2] 從存檔恢復（${resumePath}），day=${env.game.day}，stage=${env.ai.stage}，events=${events.length}，進入 DAY_DISCUSSION`);
}

async function main() {
  const stopAt = getArg('--stop-at', 'DAY_RESULT');
  const stopAtProblem = validateStopAt(stopAt);
  if (stopAtProblem) {
    console.error(`[stage2] 啟動參數錯誤：${stopAtProblem}`);
    process.exit(1);
  }
  const reportPath = getArg('--report', process.env.REPORT || DEFAULT_REPORT_BY_PHASE[stopAt] || 'ai-trace-stage2-output.md');
  const saveStatePath = getArg('--save-state', null);
  const resumePath = getArg('--resume', null);
  const { game, ai, defs, events } = buildGameAndAi();

  if (resumePath) {
    startResumedGame(game, ai, events, resumePath);
  } else {
    game.start();
    console.log(`[stage2] 遊戲已開始，目標：--stop-at ${stopAt}`);
  }

  const shutdown = createShutdownHooks();
  const { converged, aborted } = await runObservationLoop(game, stopAt, () => shutdown.requested);
  if (shutdown.requested) {
    await settleInFlightWork(game, ai); // 停止新工作，等 in-flight LLM 安全結束
  } else {
    await new Promise((r) => setTimeout(r, 3000)); // 給引擎一點時間把剩餘 broadcast 送完
  }

  const stopPhase = game.getNightState().phase;
  const report = buildReport(game, ai, events, defs, converged, aborted, stopAt, stopPhase);
  writeFileSync(reportPath, report, 'utf-8');
  const status = converged
    ? `${stopAt} 達成`
    : shutdown.requested ? `中斷（${shutdown.signal}）`
    : aborted ? '未收斂（100 則白板上限）'
    : '未收斂（階段 timeout）';
  console.log(`[stage2] ${status}；報告已寫入 ${reportPath}`);

  let saveFailed = false;
  if (saveStatePath) {
    try {
      saveStage2State(saveStatePath, { game, ai, events, stopAt });
    } catch (err) {
      saveFailed = true;
      console.error(`[stage2] ⚠️ 存檔失敗：${err.message}（舊檔未覆寫；--save-state 失敗視為本輪失敗）`);
    }
  }
  ai.destroy();
  game.destroy();
  process.exit(converged && !saveFailed ? 0 : 1); // 存檔失敗 = 1：即使收斂也不回報成功（resume 資料缺了）
}

/** 判斷 path 是否指向本檔；Windows 路徑大小寫 insensitive（同一檔），Linux 維持嚴格比較。 */
export function isMainModule(path) {
  if (path === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = resolve(path);
  return process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self;
}

// 只有直接執行本檔時才跑 main（被測試 import 時不啟動遊戲、不註冊訊號）
const isMain = (() => {
  try {
    return isMainModule(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((err) => {
    console.error(`[stage2] 致命錯誤：${err?.message ?? err}`);
    process.exit(1);
  });
}

// ============================================
// 報告產生
// ============================================

function nicknameOf(players, clientId) {
  return players.find((p) => p.clientId === clientId)?.nickname ?? clientId;
}

function fmtTs(ts) {
  return new Date(ts).toISOString();
}

function fmtJson(x) {
  return x === null || x === undefined ? 'null' : JSON.stringify(x);
}

/**
 * 共用白板 renderer：狼／共有者／白天三種白板都用同一格式輸出，避免白天特殊化。
 * 結構固定為四行：`## <name>白板（<type>）`、空行、每則訊息 `- [ts] 來源：「text」`（空則「（無）」）、空行。
 */
export function boardSection(events, type, boardName) {
  const L = [];
  L.push(`## ${boardName}白板（${type}）`);
  L.push('');
  const msgs = events.filter((e) => e.type === type);
  if (msgs.length === 0) L.push('（無）');
  for (const m of msgs) L.push(`- [${fmtTs(m.ts)}] ${m.from}：「${m.text}」`);
  L.push('');
  return L;
}

/**
 * 狼會議流程（loop 制）：
 * - 初始草稿（WOLF_SPEECH log）
 * - 每輪：JUDGE（judge 選言）→ WOLF_STANCE（其他狼回應：vote/speak/wait）
 * - 投票（WOLF_KILL）
 * - 用 WOLF_SPEECH_SELECTED 事件分組輪次
 */
function wolfMeetingFlowSection(log, events, players) {
  const L = [];
  L.push('## 狼會議流程');
  L.push('');

  // 初始草稿（所有 WOLF_SPEECH 中，在第一個 JUDGE 之前的）
  const firstJudgeIdx = log.findIndex((e) => e.kind === 'JUDGE');
  const initialDrafts = firstJudgeIdx === -1
    ? log.filter((e) => e.kind === 'WOLF_SPEECH')
    : log.filter((e) => e.kind === 'WOLF_SPEECH' && log.indexOf(e) < firstJudgeIdx);
  if (initialDrafts.length > 0) {
    L.push('### 初始草稿（全狼獨立出稿，互不可見）');
    L.push('');
    for (const d of initialDrafts) {
      const stance = d.parsed?.stance ?? '(無)';
      L.push(`- ${nicknameOf(players, d.clientId)}：「${d.parsed?.speech ?? '(無)'}」（stance: ${stance}）`);
    }
    L.push('');
  }

  // 用 WOLF_SPEECH_SELECTED 事件分組輪次（timestamp-based：用事件時間範圍匹配 log entries）
  const selectedEvents = events.filter((e) => e.type === 'WOLF_SPEECH_SELECTED');

  for (let i = 0; i < selectedEvents.length; i++) {
    const ev = selectedEvents[i];
    L.push(`### 輪次 ${i + 1}`);
    L.push('');
    L.push(`- **Judge 選出：** ${ev.from} → 發布「${ev.text}」`);
    L.push(`- **${ev.from}：** ✅ ready`);
    L.push('');
    // 該輪次的回應：ts 在 [本事件, 下一事件) 範圍內的 WOLF_STANCE（排除發言者；每狼只取最後一筆=最終結果）
    const speakerClientId = players.find((p) => p.nickname === ev.from)?.clientId ?? '';
    const tStart = ev.ts;
    const tEnd = (i + 1 < selectedEvents.length ? selectedEvents[i + 1].ts : Infinity);
    const lastByWolf = new Map();
    for (const entry of log) {
      if (entry.kind === 'WOLF_STANCE' && entry.clientId !== '' && entry.clientId !== speakerClientId && entry.ts >= tStart && entry.ts <= tEnd) {
        lastByWolf.set(entry.clientId, entry); // 後面的覆蓋前面的 → 保留最後一筆
      }
    }
    const responses = [...lastByWolf.values()];
    if (responses.length > 0) {
      L.push('- **其他狼回應：**');
      for (const r of responses) {
        const who = nicknameOf(players, r.clientId);
        if (r.parsed?.action === 'vote') {
          L.push(`  - ${who}：✅ 準備投票（投${r.parsed.target}）`);
        } else if (r.parsed?.action === 'speak') {
          L.push(`  - ${who}：🗣️ 出新草稿「${r.parsed.speech}」（stance: ${r.parsed.stance}）`);
        } else if (r.parsed?.action === 'wait') {
          L.push(`  - ${who}：⏳ 資訊不足，先不講`);
        } else {
          L.push(`  - ${who}：⚠️ 回應失敗（跳過）`);
        }
      }
      L.push('');
    }
  }

  // 投票
  const kills = log.filter((e) => e.kind === 'WOLF_KILL');
  if (kills.length > 0) {
    L.push('### 投票（收斂後）');
    L.push('');
    for (const k of kills) {
      L.push(`- ${nicknameOf(players, k.clientId)} → ${k.parsed?.target ?? '(無)'}`);
    }
    L.push('');
  }

  // 夜間行動（非狼）
  const nightActions = log.filter((e) => e.kind === 'SEER_CHECK' || e.kind === 'GUARD_PROTECT' || e.kind === 'MASON_TOGGLE');
  if (nightActions.length > 0) {
    L.push('### 夜間行動（非狼）');
    L.push('');
    for (const a of nightActions) {
      const who = nicknameOf(players, a.clientId);
      if (a.kind === 'MASON_TOGGLE') L.push(`- ${who}（共有者）：toggle 結束`);
      else L.push(`- ${who}：${a.kind === 'SEER_CHECK' ? '查驗' : '守護'} → ${a.parsed?.target ?? '(無)'}`);
    }
    L.push('');
  }

  // Abort
  const abort = log.find((e) => e.kind === 'WOLF_ABORT');
  if (abort) {
    L.push(`⚠️ **狼會議停止：** 白板累計 ${abort.parsed?.count ?? '?'} 則未收斂（100 則上限）`);
    L.push('');
  }
  return L;
}

/**
 * 共有者會議流程（loop 制，與狼會議同構）：
 * - 每輪：MASON_SPEECH_SELECTED（judge 發布）→ MASON_STANCE（另一人回應）
 * - 用 MASON_SPEECH_SELECTED 事件分組輪次（timestamp-based）
 */
function masonMeetingFlowSection(log, events, players) {
  const L = [];
  L.push('## 共有者會議流程');
  L.push('');
  const selectedEvents = events.filter((e) => e.type === 'MASON_SPEECH_SELECTED');
  if (selectedEvents.length === 0) {
    L.push('（無共有者會議——可能共有者不足 2 人或未觸發）');
    L.push('');
    return L;
  }
  for (let i = 0; i < selectedEvents.length; i++) {
    const ev = selectedEvents[i];
    L.push(`### 輪次 ${i + 1}`);
    L.push('');
    L.push(`- **Judge 選出：** ${ev.from} → 發布「${ev.text}」`);
    L.push(`- **${ev.from}：** ✅ ready`);
    L.push('');
    const speakerClientId = players.find((p) => p.nickname === ev.from)?.clientId ?? '';
    const tStart = ev.ts;
    const tEnd = (i + 1 < selectedEvents.length ? selectedEvents[i + 1].ts : Infinity);
    const lastByMason = new Map();
    for (const entry of log) {
      if (entry.kind === 'MASON_STANCE' && entry.clientId !== '' && entry.clientId !== speakerClientId && entry.ts >= tStart && entry.ts <= tEnd) {
        lastByMason.set(entry.clientId, entry);
      }
    }
    const responses = [...lastByMason.values()];
    if (responses.length > 0) {
      L.push('- **其他共有者回應：**');
      for (const r of responses) {
        const who = nicknameOf(players, r.clientId);
        if (r.parsed?.action === 'vote') {
          L.push(`  - ${who}：✅ 準備好了`);
        } else if (r.parsed?.action === 'speak') {
          L.push(`  - ${who}：🗣️ 出新草稿「${r.parsed.speech}」（stance: ${r.parsed.stance}）`);
        } else if (r.parsed?.action === 'wait') {
          L.push(`  - ${who}：⏳ 資訊不足，先不講`);
        } else {
          L.push(`  - ${who}：⚠️ 回應失敗（跳過）`);
        }
      }
      L.push('');
    }
  }
  return L;
}

/** 某 engine round 的投票（WOLF_KILL log） */
function voteRoundSection(round, log, players) {
  const L = [];
  L.push(`### 第 ${round} 回合投票`);
  L.push('');
  const kills = log.filter((e) => e.kind === 'WOLF_KILL' && e.round === round);
  if (kills.length === 0) {
    L.push('（沒有狼提交投票——可能有 AI 的 LLM 呼叫最終失敗而跳過）');
  }
  for (const e of kills) {
    const target = e.parsed?.target ?? '(無)';
    L.push(`- ${nicknameOf(players, e.clientId)}（${e.characterId}）→ 投「${target}」（第 ${e.attempt} 次嘗試，response=${e.response === null ? 'null' : 'ok'}）`);
  }
  return L;
}

/** 平票事件（WOLF_VOTE_SPLIT；事件不含 round，依時間序列出） */
function splitSection(events, players) {
  const L = [];
  L.push('### 平票事件（WOLF_VOTE_SPLIT）');
  L.push('');
  const splits = events.filter((e) => e.type === 'WOLF_VOTE_SPLIT');
  if (splits.length === 0) {
    L.push('（無平票）');
    return L;
  }
  for (const s of splits) {
    const detail = Object.entries(s.votes ?? {}).map(([k, v]) => `${nicknameOf(players, k)}×${v}`).join('、');
    L.push(`- [${fmtTs(s.ts)}] ${detail}（回討論、ready 重置、round+1）`);
  }
  return L;
}

/**
 * 白天討論流程（用 DAY_DISCUSSION PHASE_CHANGED 時間戳分界；
 * 用 MESSAGE 事件分組輪次；每輪顯示發言者 + 所有 AI 的 respond 決策）
 */
export function dayDiscussionSection(log, events, players) {
  const L = [];
  L.push('## 白天討論流程（DAY_DISCUSSION）');
  L.push('');

  // 找 DAY_DISCUSSION 開始時間戳
  const dayStartEvent = events.find((e) => e.type === 'PHASE_CHANGED' && e.phase === 'DAY_DISCUSSION');
  if (!dayStartEvent) {
    L.push('（無 DAY_DISCUSSION 事件——未進入白天討論）');
    L.push('');
    return L;
  }
  const dayStartTs = dayStartEvent.ts;

  // 只取 day 之後的 log entries
  const dayLog = log.filter((e) => e.ts >= dayStartTs);
  if (dayLog.length === 0) {
    L.push('（無 AI log entries——AI 控制器未觸發白天邏輯）');
    L.push('');
    return L;
  }

  // 用 MESSAGE 事件分組輪次
  const dayMessages = events.filter((e) => e.type === 'MESSAGE' && e.ts >= dayStartTs);
  const readyEvents = events.filter((e) => e.type === 'DAY_READY_STATUS' && e.ts >= dayStartTs);

  if (dayMessages.length === 0) {
    L.push('（無 MESSAGE 事件——沒有 AI 發言）');
    L.push('');
    return L;
  }

  for (let i = 0; i < dayMessages.length; i++) {
    const msg = dayMessages[i];
    const tEnd = (i + 1 < dayMessages.length ? dayMessages[i + 1].ts : Infinity);

    L.push(`### 輪次 ${i + 1}`);
    L.push('');
    L.push(`- **Judge 選出：** ${msg.from} → 發布「${msg.text}」`);
    L.push(`- **${msg.from}：** ✅ ready`);
    L.push('');

    // 該輪的 respond 決策（DAY_STANCE entries 在 [msg.ts, tEnd) 範圍內，排除發言者；白天回應的 log kind 是 DAY_STANCE 不是 WOLF_STANCE）
    const speakerClientId = players.find((p) => p.nickname === msg.from)?.clientId ?? '';
    const responses = dayLog.filter((e) =>
      e.kind === 'DAY_STANCE' &&
      e.clientId !== '' &&
      e.clientId !== speakerClientId &&
      e.ts >= msg.ts &&
      e.ts < tEnd
    );

    if (responses.length > 0) {
      L.push('- **其他 AI 回應：**');
      for (const r of responses) {
        const who = nicknameOf(players, r.clientId);
        if (r.parsed?.action === 'ready') {
          L.push(`  - ${who}：✅ ready`);
        } else if (r.parsed?.action === 'speak') {
          L.push(`  - ${who}：🗣️ 出新草稿「${r.parsed.speech}」（stance: ${r.parsed.stance}）`);
        } else if (r.parsed?.action === 'wait') {
          L.push(`  - ${who}：⏳ wait`);
        } else {
          L.push(`  - ${who}：⚠️ 回應失敗（parsed=${r.parsed === null ? 'null' : JSON.stringify(r.parsed)}）`);
        }
      }
      L.push('');
    }

    // 該輪後的 ready 狀態變化
    const readyAfter = readyEvents.filter((e) => e.ts >= msg.ts && e.ts < tEnd);
    if (readyAfter.length > 0) {
      const last = readyAfter[readyAfter.length - 1];
      L.push(`- Ready 狀態：[${last.ready.map((r) => r.nickname).join(', ')}] ${last.ready.length}/${last.total}`);
      L.push('');
    }
  }

  // 最終 ready 狀態
  const lastReady = readyEvents[readyEvents.length - 1];
  if (lastReady) {
    L.push(`**最終：** ${lastReady.ready.length}/${lastReady.total} ready（${lastReady.ready.map((r) => r.nickname).join('、')}）`);
  }
  L.push('');
  return L;
}

function buildReport(game, ai, events, defs, converged, aborted, stopAt, stopPhase) {
  const players = game.getPlayers();
  const state = game.getNightState();
  const log = ai.getLog();
  const defByClient = new Map(defs.map((d) => [d.clientId, d]));
  const wolves = players.filter((p) => p.role === 'werewolf');
  const L = [];
  L.push(`# Stage 2 外部測試報告：15 人全 AI 局（--stop-at ${stopAt}）`);
  L.push('');
  L.push(`- 產生時間：${new Date().toISOString()}`);
  L.push(`- 目標階段：${stopAt}`);
  L.push(`- 結果：${converged ? '✅ 達成' : aborted ? '❌ 未收斂（100 則白板上限）' : '❌ 未收斂（階段 timeout）'}`);
  L.push(`- 最終 phase：${converged ? stopAt : (stopPhase ?? state.phase)}`);
  L.push(`- 狼會議 engine round：${state.wolfMeetingRound}（平票才 +1）`);
  L.push(`- 白板訊息總數：${state.wolfMessageCount}`);
  L.push(`- 最終刀人目標：${state.wolfTargetId ? `${nicknameOf(players, state.wolfTargetId)}（${state.wolfTargetId}）` : '（無）'}`);
  L.push(`- 狼隊名單：${wolves.map((w) => w.nickname).join('、')}`);
  L.push('');
  L.push('## 局資訊（15 人角色分配）');
  L.push('');
  L.push('| clientId | nickname | characterId | role | alive |');
  L.push('|---|---|---|---|---|');
  for (const p of players) {
    L.push(`| ${p.clientId} | ${p.nickname} | ${defByClient.get(p.clientId)?.characterId ?? '?'} | ${p.role} | ${p.alive} |`);
  }
  L.push('');
  L.push(...masonMeetingFlowSection(log, events, players));
  L.push('');
  L.push(...wolfMeetingFlowSection(log, events, players));
  L.push('');
  L.push(...dayDiscussionSection(log, events, players));
  L.push('');
  // 三種白板共用同一 renderer（格式一致）；白天白板是獨立章節，不只藏在討論流程裡
  L.push(...boardSection(events, 'WOLF_MESSAGE', '狼'));
  L.push(...boardSection(events, 'MASON_MESSAGE', '共有者'));
  L.push(...boardSection(events, 'MESSAGE', '白天'));
  L.push('## 夜間結算（NIGHT_RESULT）');
  L.push('');
  const nightResults = events.filter((e) => e.type === 'NIGHT_RESULT');
  const eliminations = events.filter((e) => e.type === 'PLAYER_ELIMINATED');
  if (nightResults.length === 0 && eliminations.length === 0) {
    L.push('（尚未收到——夜流程未完成或 timeout）');
  } else {
    for (const nr of nightResults) {
      L.push(`- [${fmtTs(nr.ts)}] peaceful=${nr.peacful ?? nr.peaceful ?? '?'}`);
      const deaths = nr.deaths ?? [];
      if (deaths.length === 0) L.push('  - 平安夜（無人死亡）');
      for (const d of deaths) L.push(`  - ☠️ ${d.nickname}（${d.clientId}）`);
    }
    for (const el of eliminations) {
      L.push(`- [${fmtTs(el.ts)}] ${el.nickname}（${el.clientId}）被淘汰，原因：${el.cause}`);
    }
  }
  L.push('');
  L.push('## 投票與平票軌跡');
  L.push('');
  const voteRounds = [];
  for (const e of log) if (e.kind === 'WOLF_KILL' && !voteRounds.includes(e.round)) voteRounds.push(e.round);
  for (const round of voteRounds) L.push(...voteRoundSection(round, log, players));
  L.push('');
  L.push(...splitSection(events, players));
  L.push('');
  L.push('### Ready toggle 順序（WOLF_READY / MASON_READY）');
  L.push('');
  const readyEvents = events.filter((e) => e.type === 'WOLF_READY' || e.type === 'MASON_READY');
  if (readyEvents.length === 0) L.push('（無）');
  for (const e of readyEvents) {
    L.push(`- [${fmtTs(e.ts)}] ${e.type} ${nicknameOf(players, e.clientId)} → ${e.ready ? 'ON' : 'OFF'}`);
  }
  L.push('');
  L.push('## 收斂');
  L.push('');
  if (converged) {
    L.push(`- 收斂（engine round=${state.wolfMeetingRound}，白板 ${state.wolfMessageCount} 則）`);
    L.push(`- 最終刀人目標：${nicknameOf(players, state.wolfTargetId)}（${state.wolfTargetId}）`);
    L.push('- 收斂原因：全狼 toggle ready → 投票明確多數（wolfVotes 計票後 leaders 唯一）');
  } else if (aborted) {
    L.push(`- 未收斂：白板累計 ${state.wolfMessageCount} 則觸發 100 則安全上限（立即停止、不自動收斂、不強制決選）`);
  } else {
    L.push('- 未收斂：安全 timeout 內 wolfTargetId 未設定（可能 LLM 持續失敗或持續平票）');
  }
  L.push('');
  L.push('## LLM 失敗／重試');
  L.push('');
  // MASON_TOGGLE / WOLF_ABORT / JUDGE 不是 LLM 呼叫（judge 是隨機選），不列入失敗清單
  // attempt=0 是成功標記（ai-controller 在成功後額外 log 一筆 { response:null, parsed:{...} }），不算失敗
  const failures = log.filter((e) => !['MASON_TOGGLE', 'WOLF_ABORT', 'JUDGE'].includes(e.kind) && e.attempt > 0 && (e.response === null || e.parsed === null || e.attempt > 1));
  if (failures.length === 0) {
    L.push('（無）');
  } else {
    for (const e of failures) {
      L.push(`- [${fmtTs(e.ts)}] ${e.kind} ${e.clientId || '(共用)'}（${e.characterId || '-'}）round=${e.round} attempt=${e.attempt} response=${e.response === null ? 'null' : 'ok'} parsed=${e.parsed === null ? 'null' : 'ok'}`);
    }
  }
  L.push('');
  L.push('## 事件時間軸');
  L.push('');
  for (const e of events) {
    if (e.type === 'PHASE_CHANGED') L.push(`- [${fmtTs(e.ts)}] PHASE_CHANGED phase=${e.phase} day=${e.day}`);
    else if (e.type === 'NIGHT_RESULT') L.push(`- [${fmtTs(e.ts)}] NIGHT_RESULT peaceful=${e.peacefulNight} deaths=${JSON.stringify(e.deaths)}`);
    else if (e.type === 'WOLF_SPEECH_SELECTED') L.push(`- [${fmtTs(e.ts)}] WOLF_SPEECH_SELECTED round=${e.round} from=${e.from} text=「${e.text}」`);
    else if (e.type === 'WOLF_MEETING_ABORTED') L.push(`- [${fmtTs(e.ts)}] WOLF_MEETING_ABORTED count=${e.count} reason=${e.reason}`);
    else if (e.type === 'MASON_SPEECH_SELECTED') L.push(`- [${fmtTs(e.ts)}] MASON_SPEECH_SELECTED round=${e.round} from=${e.from} text=「${e.text}」`);
    else if (e.type === 'WOLF_MESSAGE' || e.type === 'MASON_MESSAGE' || e.type === 'WOLF_READY' || e.type === 'MASON_READY' || e.type === 'WOLF_VOTE_SPLIT') {
      L.push(`- [${fmtTs(e.ts)}] ${e.type} ${JSON.stringify(e)}`);
    }
    else if (e.type === 'MESSAGE') {
      L.push(`- [${fmtTs(e.ts)}] MESSAGE ${e.from}：「${e.text}」`);
    }
    else if (e.type === 'DAY_READY_STATUS') {
      L.push(`- [${fmtTs(e.ts)}] DAY_READY_STATUS ready=[${e.ready.map((r) => r.nickname).join(', ')}] total=${e.total}`);
    }
    else if (e.type === 'VOTE_RESULT') {
      L.push(`- [${fmtTs(e.ts)}] VOTE_RESULT votes=${JSON.stringify(e.votes)} eliminated=${e.eliminatedClientId ?? 'null'} tie=${e.tie}`);
    }
    else if (e.type === 'PLAYER_ELIMINATED') {
      L.push(`- [${fmtTs(e.ts)}] PLAYER_ELIMINATED ${e.nickname}（${e.cause}）`);
    }
  }
  L.push('');
  return L.join('\n');
}
