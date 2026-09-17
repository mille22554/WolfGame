#!/usr/bin/env node
/**
 * external-test-stage2.mjs — Stage 2 外部測試：15 人全 AI 局的第一晚狼會議（連續對話制）
 *
 * 在 server 上跑：SGLANG_API_KEY=xxx node scripts/external-test-stage2.mjs
 * - import dist/lobby-server/ 編譯產物（GameEngine + AiController）
 * - 建 15 人全 AI 局，跑第一夜狼會議（全狼獨立出草稿→judge 盲選發布→其他狼回應→收斂 loop）
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

  // 用 WOLF_SPEECH_SELECTED 事件分組輪次（index-based：依 log 順序分組，避免 timestamp 邊界重疊）
  const selectedEvents = events.filter((e) => e.type === 'WOLF_SPEECH_SELECTED');
  // 找出每個 JUDGE 在 log 中的 index
  const judgeIndices = [];
  for (let j = 0; j < log.length; j++) {
    if (log[j].kind === 'JUDGE') judgeIndices.push(j);
  }

  for (let i = 0; i < selectedEvents.length; i++) {
    const ev = selectedEvents[i];
    L.push(`### 輪次 ${i + 1}`);
    L.push('');
    L.push(`- **Judge 選出：** ${ev.from} → 發布「${ev.text}」`);
    L.push(`- **${ev.from}：** ✅ ready`);
    L.push('');
    // 該輪次的回應：log 中 JUDGE[i] 之後、JUDGE[i+1] 之前的 WOLF_STANCE（排除發言者；每狼只取最後一筆=最終結果）
    const speakerClientId = players.find((p) => p.nickname === ev.from)?.clientId ?? '';
    const startIdx = (i < judgeIndices.length ? judgeIndices[i] : log.length) + 1;
    const endIdx = (i + 1 < judgeIndices.length ? judgeIndices[i + 1] : log.length);
    const lastByWolf = new Map();
    for (let j = startIdx; j < endIdx; j++) {
      if (log[j].kind === 'WOLF_STANCE' && log[j].clientId !== '' && log[j].clientId !== speakerClientId) {
        lastByWolf.set(log[j].clientId, log[j]); // 後面的覆蓋前面的 → 保留最後一筆
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
  L.push(...wolfMeetingFlowSection(log, events, players));
  L.push('');
  L.push('## 狼白板（WOLF_MESSAGE）');
  L.push('');
  const wolfMsgs = events.filter((e) => e.type === 'WOLF_MESSAGE');
  if (wolfMsgs.length === 0) L.push('（無）');
  for (const m of wolfMsgs) L.push(`- [${fmtTs(m.ts)}] ${m.from}：「${m.text}」`);
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
  }
  L.push('');
  return L.join('\n');
}
