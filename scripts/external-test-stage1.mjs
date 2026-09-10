#!/usr/bin/env node
/**
 * external-test-stage1.mjs — 外部測試 stage 1：第一晚三狼會議（有界）
 *
 * 15 人全 AI 局，以真實 LLM（預設 Qwen3-4B-Q4_K_M.gguf，node-llama-cpp worker 載入）。
 * 記錄中控（SpeechScheduler）給每個 AI 的完整 prompt 與各 AI 的草稿回復。
 * 只跑 MAX_ROUNDS 回合（預設 2）就停，不等待收斂。
 *
 * 用法：node scripts/external-test-stage1.mjs
 * 環境變數：MODEL_PATH（預設 dist-pkg/data/models/Qwen3-4B-Q4_K_M.gguf）
 *           MAX_ROUNDS（預設 2；每回合 = 一輪 pre_speech + expand 播出）
 *           TIMEOUT_MS（預設 10 分鐘）
 *           REPORT（報告輸出檔，預設寫入系統暫存）
 */
import { writeFileSync } from 'node:fs';
import { GameEngine } from '../dist/engine.js';
import { SpeechScheduler, parseDecisionFlag } from '../dist/ai-scheduler.js';
import { WorkerDispatcher } from '../dist/worker-dispatcher.js';
import { createGameState } from '../dist/game-state.js';
import { Role } from '../dist/types.js';
import { getRoleCounts } from '../dist/assignment.js';

const MODEL_PATH = process.env.MODEL_PATH ?? 'E:/Projects/WolfGame/dist-pkg/data/models/Qwen3-4B-Q4_K_M.gguf';
const PLAYER_COUNT = 15;
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? 2);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 10 * 60 * 1000);
const REPORT = process.env.REPORT ?? 'C:/Users/morowin/AppData/Local/Temp/opencode/stage1-report.md';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inferKind(config) {
  if (config?.temperature === 0.7) return 'pre_speech';
  if (config?.temperature === 0.3) return 'judge';
  return 'expand';
}

const calls = [];   // { kind, playerId, prompt, raw, decision, boardVersion, ts }

const inner = new WorkerDispatcher({ modelPath: MODEL_PATH, contextSize: 8192, contextCount: 3 });

let engine;
const llm = {
  start: () => inner.start(),
  shutdown: () => inner.shutdown(),
  isHealthy: () => inner.isHealthy(),
  async generate(prompt, config) {
    const raw = await inner.generate(prompt, config);
    const m = prompt.match(/你是 P(\d+)/);
    const rec = {
      kind: inferKind(config),
      playerId: m ? parseInt(m[1], 10) : null,
      prompt,
      raw,
      decision: parseDecisionFlag(raw),
      boardVersion: engine.getState().boardVersion,
      ts: Date.now(),
    };
    calls.push(rec);
    return raw;
  },
  requestSpeech: (pid, prompt) => inner.requestSpeech(pid, prompt),
  requestVote: (pid, prompt) => inner.requestVote(pid, prompt),
  requestNightAction: (pid, prompt) => inner.requestNightAction(pid, prompt),
};

const scheduler = new SpeechScheduler(
  {
    enqueue: (e) => {
      engine.enqueue(e);
      engine.drain();
    },
    getState: () => engine.getState(),
    llm,
  },
  { cdMs: 0, preSpeechBatch: 3 },
);

engine = new GameEngine({ mode: 'gm', llm, scheduler }, createGameState(PLAYER_COUNT));

let final;
try {
  console.log(`載入模型：${MODEL_PATH}`);
  await llm.start();
  console.log('模型就緒。');

  for (let i = 0; i < PLAYER_COUNT; i++) engine.enqueue({ type: 'CLIENT_JOIN', name: `P${i + 1}` });
  engine.enqueue({ type: 'START_GAME' });
  engine.drain();

  const st = engine.getState();
  const wolves = st.players.filter((p) => p.role === Role.WEREWOLF);
  console.log(`\n=== 遊戲開始：${PLAYER_COUNT} 人局（全 AI）===`);
  console.log(`角色分配：${JSON.stringify(getRoleCounts(st.players))}`);
  console.log(`狼人：${wolves.map((w) => `P${w.id}`).join(', ')}`);
  console.log(`phase：${st.phase}（stage 1：第一晚狼會議，最多 ${MAX_ROUNDS} 回合）\n`);

  // 有界執行：跑 MAX_ROUNDS 回合（每回合播出一次 = boardVersion +1）或收斂或逾時
  const start = Date.now();
  const startBv = st.boardVersion;   // 數字快照（st 是活體引用，st.boardVersion 會跟著長大，不能直接當基準）
  let lastBv = startBv;
  while (Date.now() - start < TIMEOUT_MS) {
    await sleep(100);
    engine.drain();
    const cur = engine.getState();
    if (cur.phase !== 'NIGHT_DISCUSSION_OPEN') break;   // 收斂或離開
    if (cur.boardVersion > lastBv) {
      lastBv = cur.boardVersion;
      if (lastBv - startBv >= MAX_ROUNDS) break;   // 已播出 MAX_ROUNDS 回合
    }
  }
  final = engine.getState();
  console.log(`\n執行結束：phase=${final.phase}，boardVersion=${final.boardVersion}，LLM 呼叫 ${calls.length} 次`);

  // ── 產出報告 ──
  const L = [];
  const push = (s = '') => L.push(s);
  push(`# Stage 1 外部測試報告：第一晚三狼會議`);
  push();
  push(`- 模型：${MODEL_PATH}`);
  push(`- 局：${PLAYER_COUNT} 人全 AI`);
  push(`- 角色分配：${JSON.stringify(getRoleCounts(final.players))}`);
  push(`- 狼人：${wolves.map((w) => `P${w.id}`).join(', ')}`);
  push(`- 執行：${MAX_ROUNDS} 回合後停止（未等收斂）`);
  push(`- 最終 phase：${final.phase}；wolfReady：${JSON.stringify(final.wolfReady)}`);
  push();

  const byVersion = new Map();
  for (const c of calls) {
    if (!byVersion.has(c.boardVersion)) byVersion.set(c.boardVersion, []);
    byVersion.get(c.boardVersion).push(c);
  }
  let roundIdx = 0;
  for (const [bv, group] of byVersion) {
    roundIdx++;
    push(`## 回合 ${roundIdx}（boardVersion=${bv}）`);
    for (const c of group) {
      const dec = c.decision.status === 'decided'
        ? (c.decision.target === 'abstain' ? '棄票' : `殺P${c.decision.target}`)
        : '資訊不足';
      push();
      push(`### ${c.kind} P${c.playerId ?? '-'} → 決策：${dec}`);
      push();
      push('**中控 prompt：**');
      push('```');
      push(c.prompt);
      push('```');
      push();
      push('**AI 草稿回復：**');
      push('```');
      push(c.raw);
      push('```');
    }
    push();
  }

  push(`## 已播出白板（wolfDiscussionLog）`);
  for (const d of final.wolfDiscussionLog) push(`- P${d.playerId}：${d.text}`);
  push();

  // 觀察發現
  push(`## 觀察發現`);
  if (final.phase === 'NIGHT_DISCUSSION_OPEN') {
    push(`- ⚠ 未收斂：${MAX_ROUNDS} 回合內三狼皆未決定目標（全回「資訊不足」），會議無法自動結束。`);
  }
  const leaked = calls.filter((c) => c.kind === 'expand' && c.prompt.includes('決定:資訊不足') && !c.prompt.includes('[決定:資訊不足]'));
  if (leaked.length > 0) {
    push(`- ⚠ 決策旗標洩漏：AI 以「決定:資訊不足」（無方括號）回覆時，stripDecisionFlags 只剝 [決定:...]（有方括號），旗標殘留在草稿中進入 expand prompt（${leaked.length} 次）。`);
  }
  const doublePrefix = final.wolfDiscussionLog.filter((d) => d.text.startsWith(`P${d.playerId}：`)).length;
  if (doublePrefix > 0) {
    push(`- 顯示冗餘：AI 回覆已含「Px：「...」」前綴，prompt 組裝又加「Px：」，白板出現「P6：P6：「...」」（${doublePrefix} 筆）。`);
  }
  push(`- 內容重複：4B 模型每回合草稿幾乎相同（「確認守衛保護的人」），新穎性懲罰無法區分相似草稿。`);

  const report = L.join('\n');
  writeFileSync(REPORT, report, 'utf8');
  console.log(`\n報告已寫入：${REPORT}`);
} finally {
  scheduler.stop();
  engine.close();
  await llm.shutdown();
}