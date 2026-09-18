#!/usr/bin/env node
/**
 * external-test-stage2.mjs — Stage 2 外部測試：15 人全 AI 局（分階段可選）
 *
 * 用法：
 *   node scripts/external-test-stage2.mjs [--stop-at PHASE] [--report PATH]
 *
 * PHASE 選項：
 *   NIGHT_RESULT  — 只跑夜晚（mason→wolf→seer/guard→結算），到 DAY_DISCUSSION 開始時停止
 *   DAY_RESULT    — 跑完整天（night + day discussion + voting），到 DAY_RESULT 停止（預設）
 *   GAME_OVER     — 跑完整局（多天）直到 GAME_OVER
 *
 * 在 server 上跑：SGLANG_API_KEY=xxx node scripts/external-test-stage2.mjs --stop-at NIGHT_RESULT
 * - import dist/lobby-server/ 編譯產物（GameEngine + AiController）
 * - 建 15 人全 AI 局
 * - 各階段不限時（night/day 皆等待收斂，無 timeout 截斷）
 * - 產出 markdown 報告（--report 或 REPORT env 或依階段預設：night/day/full）
 * - exit code：0 = 目標階段完成、1 = 未收斂（安全上限 / timeout）
 */
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { GameEngine } from '../dist/lobby-server/game.js';
import { AiController } from '../dist/lobby-server/ai-controller.js';

// --- CLI 參數解析 ---
const args = process.argv.slice(2);
function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return defaultValue;
}
const STOP_AT = getArg('--stop-at', 'DAY_RESULT'); // NIGHT_RESULT | DAY_RESULT | GAME_OVER
// 未指定 --report 時依階段用不同預設路徑（避免 night/day 報告互相覆蓋）
const DEFAULT_REPORT_BY_PHASE = {
  NIGHT_RESULT: 'ai-trace-stage2-night.md',
  DAY_RESULT: 'ai-trace-stage2-day.md',
  GAME_OVER: 'ai-trace-stage2-full.md',
};
const REPORT_PATH = getArg('--report', process.env.REPORT || DEFAULT_REPORT_BY_PHASE[STOP_AT] || 'ai-trace-stage2-output.md');
const SAVE_STATE_PATH = getArg('--save-state', null); // 存檔路徑（跑完目標階段後存檔）
const RESUME_PATH = getArg('--resume', null); // 存檔路徑（從存檔恢復，跳過 night）

// 各階段 timeout
const TIMEOUTS = {
  NIGHT: 0,         // 夜晚：不限時（等所有夜間行動完成）
  DAY: 0,           // 白天：不限時（等所有玩家 toggle ready + 投票）
};

// 判斷「目標階段完成」的條件
function isTargetReached(phase) {
  if (STOP_AT === 'NIGHT_RESULT') return phase === 'DAY_DISCUSSION' || phase === 'DAY_VOTING' || phase === 'DAY_RESULT' || phase === 'GAME_OVER';
  if (STOP_AT === 'DAY_RESULT') return phase === 'DAY_RESULT' || phase === 'GAME_OVER';
  if (STOP_AT === 'GAME_OVER') return phase === 'GAME_OVER';
  return false;
}

// 目前所在大階段（決定用哪個 timeout）
function currentMajorPhase(phase) {
  if (phase === 'NIGHT') return 'NIGHT';
  return 'DAY'; // DAY_DISCUSSION / DAY_VOTING / DAY_RESULT 都算 day
}

// 15 個 AI 人格（characterId → 中文名；與 character/<id>/agents.md 的中文名一致）
const CHARACTERS = [
  ['aoi', '葵'], ['chihiro', '千尋'], ['futa', '二葉'], ['kenta', '健太'], ['koharu', '小晴'],
  ['misaki', '美咲'], ['ren', '蓮'], ['rin', '鈴'], ['ryoko', '良子'], ['sayuki', '佐雪'],
  ['shinichi', '真一'], ['shota', '翔太'], ['tatuya', '太助'], ['yuko', '裕子'], ['yuma', '優馬'],
];

const POLL_INTERVAL_MS = 500;
const DISCUSSION_LOG = '/tmp/day-discussion.log'; // 實時討論記錄（tail -f 可看）

// --- 1) 組 15 個 AiPlayerDef ---
const defs = CHARACTERS.map(([characterId, nickname], i) => ({ clientId: `ai-${i}`, nickname, characterId }));

// --- 2) AI 控制器 + 遊戲引擎（engine callback 接進 AI 控制器） ---
const ai = new AiController(defs, { messageCap: 100 });
const events = []; // 所有 S→C 訊息（報告用）

// 清空討論 log
writeFileSync(DISCUSSION_LOG, '', 'utf-8');

const game = new GameEngine('STAGE2', defs.map((d) => ({ clientId: d.clientId, nickname: d.nickname })), {
  sendTo: (cid, m) => ai.handlePrivate(cid, m),
  broadcast: (m, targets) => {
    ai.handleBroadcast(m, targets);
    events.push({ ts: Date.now(), type: m.type, ...m });
    // 實時寫入討論 log（DAY_MESSAGE / WOLF_MESSAGE / DAY_READY_STATUS）
    if (m.type === 'MESSAGE' || m.type === 'WOLF_MESSAGE' || m.type === 'DAY_READY_STATUS') {
      const line = m.type === 'DAY_READY_STATUS'
        ? `[READY] ${m.ready.map((r) => r.nickname).join(', ')} (${m.ready.length}/${m.total})`
        : `[${new Date().toISOString().slice(11, 19)}] ${m.from}: ${m.text}`;
      appendFileSync(DISCUSSION_LOG, line + '\n', 'utf-8');
    }
  },
  onNightStepActive: (step, players) => ai.onNightStepActive(step, players),
  onWolfSubphaseChange: (sub, round) => ai.onWolfSubphaseChange(sub, round),
}, 100);
ai.setGame(game);

// --- 3) 開始遊戲（或從存檔恢復） ---
if (RESUME_PATH) {
  const snapshot = JSON.parse(readFileSync(RESUME_PATH, 'utf-8'));
  game.restoreState(snapshot);
  console.log(`[stage2] 從存檔恢復（${RESUME_PATH}），day=${snapshot.day}，直接進入 DAY_DISCUSSION`);
} else {
  game.start();
  console.log(`[stage2] 遊戲已開始，目標：--stop-at ${STOP_AT}`);
}

// --- 4) 觀察：分階段 timeout 輪詢 ---
let converged = false;
let aborted = false;
let phaseTimeout = TIMEOUTS.NIGHT;
let phaseStarted = Date.now();
let lastMajorPhase = 'NIGHT';
let lastProgressLog = Date.now();
const PROGRESS_INTERVAL_MS = 600_000; // 每 10 分鐘輸出一次進度

/** 輸出當前進度（每 10 分鐘一次） */
function logProgress(s) {
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

while (true) {
  const s = game.getNightState();
  const major = currentMajorPhase(s.phase);

  // 每 10 分鐘輸出進度
  if (Date.now() - lastProgressLog >= PROGRESS_INTERVAL_MS) {
    lastProgressLog = Date.now();
    logProgress(s);
  }

  // 階段切換 → 重置該階段的 timeout
  if (major !== lastMajorPhase) {
    lastMajorPhase = major;
    phaseStarted = Date.now();
    phaseTimeout = TIMEOUTS[major] ?? TIMEOUTS.DAY;
    console.log(`[stage2] 進入 ${s.phase}（timeout ${phaseTimeout > 0 ? phaseTimeout / 1000 + 's' : '不限時'}）`);
  }

  // 目標達成
  if (isTargetReached(s.phase)) {
    converged = true;
    break;
  }
  // 狼會議 abort
  if (s.wolfMeetingAborted) {
    aborted = true;
    break;
  }
  // 當前階段 timeout（0 = 不限時：直接等到 phase 推進或 process 被 kill）
  if (phaseTimeout > 0 && Date.now() - phaseStarted > phaseTimeout) {
    console.error(`[stage2] ⚠️ ${s.phase} 階段超時（${phaseTimeout / 1000}s）`);
    break;
  }

  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}
// 給引擎一點時間把剩餘 broadcast 送完
await new Promise((r) => setTimeout(r, 3000));

// --- 5) 報告 ---
const report = buildReport(game, ai, events, defs, converged, aborted, STOP_AT);
writeFileSync(REPORT_PATH, report, 'utf-8');
const status = converged ? `${STOP_AT} 達成` : aborted ? '未收斂（100 則白板上限）' : '未收斂（階段 timeout）';
console.log(`[stage2] ${status}；報告已寫入 ${REPORT_PATH}`);

// --- 5.5) 存檔（若指定 --save-state） ---
if (SAVE_STATE_PATH && converged) {
  const snapshot = game.saveState();
  writeFileSync(SAVE_STATE_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
  console.log(`[stage2] 狀態存檔已寫入 ${SAVE_STATE_PATH}（可用 --resume ${SAVE_STATE_PATH} 接白天）`);
}

// --- 6) 結束 ---
ai.destroy();
game.destroy();
process.exit(converged ? 0 : 1);

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
function dayDiscussionSection(log, events, players) {
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

    L.push(`### 第 ${i + 1} 輪：${msg.from} 發言`);
    L.push('');
    L.push(`- [${fmtTs(msg.ts)}] 「${msg.text}」`);
    L.push('');

    // 該輪的 respond 決策（WOLF_STANCE entries 在 [msg.ts, tEnd) 範圍內，排除發言者）
    const speakerClientId = players.find((p) => p.nickname === msg.from)?.clientId ?? '';
    const responses = dayLog.filter((e) =>
      e.kind === 'WOLF_STANCE' &&
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
    L.push(`**最終：** ${lastReady.ready.length}/${lastReady.total} ready（${lastReady.ready.map((r) => r.nickname).join(', ')}）`);
  }
  L.push('');
  return L;
}

function buildReport(game, ai, events, defs, converged, aborted, stopAt) {
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
  L.push(`- 最終 phase：${state.phase}`);
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
  L.push('## 狼白板（WOLF_MESSAGE）');
  L.push('');
  const wolfMsgs = events.filter((e) => e.type === 'WOLF_MESSAGE');
  if (wolfMsgs.length === 0) L.push('（無）');
  for (const m of wolfMsgs) L.push(`- [${fmtTs(m.ts)}] ${m.from}：「${m.text}」`);
  L.push('');
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
  const failures = log.filter((e) => !['MASON_TOGGLE', 'WOLF_ABORT', 'JUDGE'].includes(e.kind) && (e.response === null || e.parsed === null || e.attempt > 1));
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
