#!/usr/bin/env node
/**
 * external-test-stage2.mjs — Stage 2 外部測試：15 人全 AI 局的第一晚狼會議（連續對話制）
 *
 * 在 server 上跑：SGLANG_API_KEY=xxx node scripts/external-test-stage2.mjs
 * - import dist/lobby-server/ 編譯產物（GameEngine + AiController）
 * - 建 15 人全 AI 局，跑第一夜狼會議（0 首句→0.5 judge→1 表態→分歧接著聊→…→收斂）
 * - 觀察到收斂（wolfTargetId 設定）或 100 則安全上限（wolfMeetingAborted）或 15 分鐘 timeout
 * - 產出 markdown 報告（REPORT env 指定路徑；預設 ai-trace-stage2-output.md）
 * - exit code：0 = 收斂、1 = 未收斂（安全上限 / timeout）
 */
import { writeFileSync } from 'node:fs';
import { GameEngine } from '../dist/lobby-server/game.js';
import { AiController } from '../dist/lobby-server/ai-controller.js';

// 15 個 AI 人格（characterId → 中文名；與 character/<id>/agents.md 的中文名一致）
const CHARACTERS = [
  ['aoi', '葵'], ['chihiro', '千尋'], ['futa', '二葉'], ['kenta', '健太'], ['koharu', '小晴'],
  ['misaki', '美咲'], ['ren', '蓮'], ['rin', '鈴'], ['ryoko', '良子'], ['sayuki', '佐雪'],
  ['shinichi', '真一'], ['shota', '翔太'], ['tatuya', '太助'], ['yuko', '裕子'], ['yuma', '優馬'],
];

const SAFETY_TIMEOUT_MS = 15 * 60 * 1000; // 安全 timeout：逾時記錄「未收斂」並照常出報告
const POLL_INTERVAL_MS = 500;

// --- 1) 組 15 個 AiPlayerDef ---
const defs = CHARACTERS.map(([characterId, nickname], i) => ({ clientId: `ai-${i}`, nickname, characterId }));

// --- 2) AI 控制器 + 遊戲引擎（engine callback 接進 AI 控制器） ---
const ai = new AiController(defs);
const events = []; // 所有 S→C 訊息（報告用：WOLF_SPEECH_SELECTED / WOLF_READY / WOLF_MESSAGE ...）

const game = new GameEngine('STAGE2', defs.map((d) => ({ clientId: d.clientId, nickname: d.nickname })), {
  sendTo: (cid, m) => ai.handlePrivate(cid, m),
  broadcast: (m, targets) => {
    ai.handleBroadcast(m, targets);
    events.push({ ts: Date.now(), type: m.type, ...m });
  },
  onNightStepActive: (step, players) => ai.onNightStepActive(step, players),
  onWolfSubphaseChange: (sub, round) => ai.onWolfSubphaseChange(sub, round),
});
ai.setGame(game);

// --- 3) 開始遊戲 ---
game.start();
console.log('[stage2] 遊戲已開始，等待狼會議收斂（安全 timeout 15 分鐘、100 則白板上限）...');

// --- 4) 觀察：輪詢 getNightState() 直到收斂 / 100 則上限 / timeout ---
const deadline = Date.now() + SAFETY_TIMEOUT_MS;
let converged = false;
let aborted = false;
while (Date.now() < deadline) {
  const s = game.getNightState();
  if (s.wolfTargetId !== null) {
    converged = true;
    break;
  }
  if (s.wolfMeetingAborted) {
    aborted = true;
    break;
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}
// 給引擎一點時間把剩餘 broadcast 送完
await new Promise((r) => setTimeout(r, 2000));

// --- 5) 報告 ---
const report = buildReport(game, ai, events, defs, converged, aborted);
const outPath = process.env.REPORT || 'ai-trace-stage2-output.md';
writeFileSync(outPath, report, 'utf-8');
console.log(`[stage2] ${converged ? '狼會議收斂' : aborted ? '未收斂（100 則白板上限）' : '未收斂（timeout）'}；報告已寫入 ${outPath}`);

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
 * 狼會議流程（時間序）：走 log，依序渲染
 * WOLF_SPEECH（發言）/ JUDGE（judge 選言＋分數）/ WOLF_STANCE（表態：接受/反對）/
 * WOLF_KILL（投票）/ WOLF_ABORT（100 則上限停止）
 * JUDGE log 與 WOLF_SPEECH_SELECTED 事件配對（事件 ts 前最後一筆 JUDGE＝該次的最終嘗試）
 */
function wolfMeetingFlowSection(log, events, players) {
  const L = [];
  L.push('## 狼會議流程（時間序）');
  L.push('');
  const selectedEvents = events.filter((e) => e.type === 'WOLF_SPEECH_SELECTED');
  // 配對：第 N 次 judge 的最終嘗試（後一筆 log 不是 JUDGE 的那筆）↔ 第 N 個 WOLF_SPEECH_SELECTED 事件
  // （用順序配對，避免同毫秒 timestamp 或重試造成的錯配）
  const finalJudges = [];
  for (let i = 0; i < log.length; i++) {
    if (log[i].kind === 'JUDGE' && (i + 1 >= log.length || log[i + 1].kind !== 'JUDGE')) {
      finalJudges.push(log[i]);
    }
  }
  const matchedJudge = new Map(); // judge entry -> event
  finalJudges.forEach((j, i) => {
    const ev = selectedEvents[i];
    if (ev) matchedJudge.set(j, ev);
  });
  for (const e of log) {
    const who = e.clientId ? `${nicknameOf(players, e.clientId)}（${e.characterId}）` : '（共用）';
    if (e.kind === 'WOLF_SPEECH') {
      L.push(`- [${fmtTs(e.ts)}] 發言 ${who}（round ${e.round}）：「${e.parsed?.speech ?? '(無)'}」`);
    } else if (e.kind === 'JUDGE') {
      L.push(`- [${fmtTs(e.ts)}] judge（round ${e.round}，第 ${e.attempt} 次嘗試）：scores=${fmtJson(e.parsed?.scores ?? null)}`);
      const ev = matchedJudge.get(e);
      if (ev) L.push(`  → 選出：${ev.from}「${ev.text}」（第 ${ev.round} 次選言）`);
    } else if (e.kind === 'WOLF_STANCE') {
      const accept = e.parsed?.accept;
      const speech = e.parsed?.speech;
      const verdict = accept === true ? '接受（toggle ready ON）' : accept === false ? '反對（接著聊）' : '跳過（parse 失敗）';
      L.push(`- [${fmtTs(e.ts)}] 表態 ${who}（round ${e.round}）：${verdict}${accept === false && speech ? `「${speech}」` : ''}`);
    } else if (e.kind === 'WOLF_KILL') {
      L.push(`- [${fmtTs(e.ts)}] 投票 ${who}（round ${e.round}）：→ ${e.parsed?.target ?? '(無)'}（第 ${e.attempt} 次嘗試，response=${e.response === null ? 'null' : 'ok'}）`);
    } else if (e.kind === 'WOLF_ABORT') {
      L.push(`- [${fmtTs(e.ts)}] ⚠️ 狼會議停止：白板累計 ${e.parsed?.count ?? '?'} 則未收斂（100 則上限，不自動收斂）`);
    } else if (e.kind === 'MASON_TOGGLE') {
      L.push(`- [${fmtTs(e.ts)}] 共有者 ${who} toggle 回合結束（無 LLM）`);
    } else if (e.kind === 'SEER_CHECK' || e.kind === 'GUARD_PROTECT') {
      L.push(`- [${fmtTs(e.ts)}] ${e.kind} ${who}（round ${e.round}）：→ ${e.parsed?.target ?? '(無)'}（第 ${e.attempt} 次嘗試）`);
    }
  }
  if (log.length === 0) L.push('（無）');
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

function buildReport(game, ai, events, defs, converged, aborted) {
  const players = game.getPlayers();
  const state = game.getNightState();
  const log = ai.getLog();
  const defByClient = new Map(defs.map((d) => [d.clientId, d]));
  const wolves = players.filter((p) => p.role === 'werewolf');
  const L = [];
  L.push('# Stage 2 外部測試報告：15 人全 AI 局第一夜狼會議（連續對話制）');
  L.push('');
  L.push(`- 產生時間：${new Date().toISOString()}`);
  L.push(`- 收斂結果：${converged ? '收斂' : aborted ? '未收斂（100 則白板上限）' : '未收斂（安全 timeout）'}`);
  L.push(`- 狼會議總回合數（engine round）：${state.wolfMeetingRound}`);
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
  L.push(...wolfMeetingFlowSection(log, events, players));
  L.push('');
  L.push('## 狼白板（WOLF_MESSAGE）');
  L.push('');
  const wolfMsgs = events.filter((e) => e.type === 'WOLF_MESSAGE');
  if (wolfMsgs.length === 0) L.push('（無）');
  for (const m of wolfMsgs) L.push(`- [${fmtTs(m.ts)}] ${m.from}：「${m.text}」`);
  L.push('');
  L.push('## 完整 Prompt / Response（LLM 互動逐筆）');
  L.push('');
  for (const e of log) {
    if (e.kind === 'MASON_TOGGLE' || e.kind === 'WOLF_ABORT') continue;
    const who = e.clientId ? `${nicknameOf(players, e.clientId)}（${e.characterId}）` : '（共用）';
    L.push(`### ${e.kind} ${who}（round ${e.round}，attempt ${e.attempt}）`);
    L.push('');
    for (const p of e.prompts) {
      L.push(`**${p.role} prompt：**`);
      L.push('');
      L.push('```');
      L.push(p.content);
      L.push('```');
      L.push('');
    }
    L.push(`**Response：** ${e.response ?? '(null)'}`);
    L.push('');
    L.push(`**Parsed：** ${JSON.stringify(e.parsed ?? null)}`);
    L.push('');
  }
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
    L.push(`- 共 ${state.wolfMeetingRound} 個 engine round 收斂`);
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
  // MASON_TOGGLE / WOLF_ABORT 不是 LLM 呼叫，不列入失敗清單
  const failures = log.filter((e) => !['MASON_TOGGLE', 'WOLF_ABORT'].includes(e.kind) && (e.response === null || e.parsed === null || e.attempt > 1));
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
    else if (e.type === 'WOLF_MESSAGE' || e.type === 'WOLF_READY' || e.type === 'MASON_READY' || e.type === 'WOLF_VOTE_SPLIT') {
      L.push(`- [${fmtTs(e.ts)}] ${e.type} ${JSON.stringify(e)}`);
    }
  }
  L.push('');
  return L.join('\n');
}
