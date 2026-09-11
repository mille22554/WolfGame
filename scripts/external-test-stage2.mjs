#!/usr/bin/env node
/**
 * external-test-stage2.mjs — 外部測試 stage 2：完整三狼會議（無界）
 *
 * 15 人全 AI 局，以真實 LLM 跑完第一晚狼會議，直到遊戲邏輯自然收斂
 * （全存活狼 ready → phase 離開 NIGHT_DISCUSSION_OPEN）。
 *
 * 鐵則（見 docs/external-test-stages.md）：
 * - 無回合上限、無逾時截斷：harness 只觀察記錄，不干預會議進程
 * - 遊戲內建機制（SPEECH_RETRY_MS 重試、安全閥 MAX_UNCERTAIN_ROUNDS）屬實際邏輯，
 *   不可繞過，觸發時如實記錄
 * - 收斂判定以 scheduler 守護後的實際決策為準：expand 旗標與草稿決策矛盾時，
 *   scheduler 沿用草稿（見 ai-scheduler.ts 矛盾防護），harness 同理推導有效決策
 *
 * 用法：MODEL_PATH=<gguf> REPORT=<report.md> node scripts/external-test-stage2.mjs
 * 環境變數：MODEL_PATH（必填，無預設；避免舊機器硬編碼路徑）
 *           REPORT（報告輸出檔，預設寫入系統暫存）
 */
import { writeFileSync } from 'node:fs';
import { GameEngine } from '../dist/engine.js';
import { SpeechScheduler, parseDecisionFlag } from '../dist/ai-scheduler.js';
import { WorkerDispatcher } from '../dist/worker-dispatcher.js';
import { createGameState } from '../dist/game-state.js';
import { Role } from '../dist/types.js';
import { getRoleCounts } from '../dist/assignment.js';

const MODEL_PATH = process.env.MODEL_PATH;
if (!MODEL_PATH) {
  console.error('請設定 MODEL_PATH（本地 GGUF 模型檔路徑）');
  process.exit(1);
}
const PLAYER_COUNT = 15;
const REPORT = process.env.REPORT ?? 'C:/Users/user/AppData/Local/Temp/opencode/stage2-report.md';
// 生產重試間隔（與 scheduler 預設一致；僅用於報告中的長間隔啟發式標註，不做任何截斷）
const RETRY_MS = Number(process.env.SPEECH_RETRY_MS ?? 60000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inferKind(config) {
  if (config?.temperature === 0.7) return 'pre_speech';
  if (config?.temperature === 0.3) return 'judge';
  return 'expand';
}

function fmtDecision(decision) {
  if (decision.status !== 'decided') return '資訊不足';
  if (decision.target === 'abstain') return '棄票';
  return `殺P${decision.target}`;
}

const calls = [];   // { kind, playerId, raw, decision, boardVersion, ts }（不存 prompt：stage 2 只驗收行為）

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

engine = new GameEngine({ mode: 'gm', llm, scheduler, writeMemory: true }, createGameState(PLAYER_COUNT));

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
  console.log(`phase：${st.phase}（stage 2：完整狼會議，無上限，收斂即停）\n`);

  // 無界執行：直到 phase 離開 NIGHT_DISCUSSION_OPEN（全員 ready → NIGHT_COLLECTING）。
  // 不設回合上限、不設逾時截斷；每輪播出（boardVersion +1）記錄 wolfReady 快照。
  const start = Date.now();
  const startBv = st.boardVersion;   // 數字快照（st 是活體引用，不能直接當基準）
  let lastBv = startBv;
  const roundSnapshots = [];   // { boardVersion, wolfReady: [...], ts }
  for (;;) {
    await sleep(100);
    engine.drain();
    const cur = engine.getState();
    // 先檢查版本（末輪播出與收斂可能在同一次 drain 完成，phase-break 會跳過版本記錄）
    if (cur.boardVersion > lastBv) {
      lastBv = cur.boardVersion;
      roundSnapshots.push({ boardVersion: lastBv, wolfReady: [...cur.wolfReady], ts: Date.now() });
      console.log(`回合 ${lastBv - startBv} 播出：boardVersion=${lastBv}，wolfReady=[${cur.wolfReady.join(', ')}]`);
      // 中間持久化：崩潰不丟失已產生的草稿/決策（最終報告覆寫 REPORT 本體，此 sidecar 僅救援用；不含 prompt）
      try {
        writeFileSync(REPORT + '.calls.json', JSON.stringify({
          wolves: wolves.map((w) => w.id),
          rounds: lastBv - startBv,
          wolfReady: [...cur.wolfReady],
          whiteboard: cur.wolfDiscussionLog,
          calls,
        }, null, 1));
      } catch { /* 中間寫入失敗不影響主流程 */ }
    }
    if (cur.phase !== 'NIGHT_DISCUSSION_OPEN') break;   // 收斂（或離開）
  }
  final = engine.getState();
  const rounds = lastBv - startBv;
  const elapsedMin = ((Date.now() - start) / 60000).toFixed(1);
  console.log(`\n執行結束：phase=${final.phase}，共 ${rounds} 回合，耗時 ${elapsedMin} 分，LLM 呼叫 ${calls.length} 次`);

  // ── 產出報告 ──
  const L = [];
  const push = (s = '') => L.push(s);
  push(`# Stage 2 外部測試報告：完整三狼會議`);
  push();
  push(`- 模型：${MODEL_PATH}`);
  push(`- 局：${PLAYER_COUNT} 人全 AI`);
  push(`- 角色分配：${JSON.stringify(getRoleCounts(final.players))}`);
  push(`- 狼人：${wolves.map((w) => `P${w.id}`).join(', ')}`);
  push(`- 執行：自然收斂（${final.phase}），共 ${rounds} 回合，耗時 ${elapsedMin} 分，LLM 呼叫 ${calls.length} 次`);
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
    const snap = roundSnapshots.find((r) => r.boardVersion === bv);
    push(`## 回合 ${roundIdx}（boardVersion=${bv}${snap ? `；播出後 wolfReady=[${snap.wolfReady.join(', ')}]` : ''}）`);
    for (const c of group) {
      push();
      push(`### ${c.kind} P${c.playerId ?? '-'} → 決策：${fmtDecision(c.decision)}`);
      push('```');
      push(c.raw);
      push('```');
    }
    push();
  }

  push(`## 已播出白板（wolfDiscussionLog 全量）`);
  for (const d of final.wolfDiscussionLog) push(`- P${d.playerId}：${d.text}`);
  push();

  // ── 收斂軌跡：每狼每輪有效決策（expand 與草稿矛盾時沿用草稿＝scheduler 守護行為） ──
  push(`## 收斂軌跡（每狼每輪有效決策）`);
  const contradictions = [];   // { round, playerId, draftTarget, expandTarget }
  const roundsSorted = [...byVersion.keys()].sort((a, b) => a - b);
  // 每狼最終有效決策（最後一輪有 decided 的值；矛盾時以草稿為準）
  const finalEffective = new Map();   // playerId -> { target, round, via }
  for (const bv of roundsSorted) {
    const group = byVersion.get(bv);
    const drafts = new Map();   // playerId -> decision
    for (const c of group) {
      if (c.kind === 'pre_speech' && c.playerId != null) drafts.set(c.playerId, c.decision);
    }
    for (const c of group) {
      if (c.kind !== 'expand' || c.playerId == null) continue;
      const draft = drafts.get(c.playerId);
      const draftDecided = draft && draft.status === 'decided' && draft.target !== 'abstain';
      const expandDecided = c.decision.status === 'decided' && c.decision.target !== 'abstain';
      if (draftDecided && expandDecided && c.decision.target !== draft.target) {
        // 與 scheduler 矛盾防護一致：沿用草稿
        contradictions.push({
          round: roundsSorted.indexOf(bv) + 1,
          playerId: c.playerId,
          draftTarget: draft.target,
          expandTarget: c.decision.target,
        });
        finalEffective.set(c.playerId, { target: draft.target, round: roundsSorted.indexOf(bv) + 1, via: '草稿（expand 矛盾被守護攔截）' });
      } else if (expandDecided) {
        finalEffective.set(c.playerId, { target: c.decision.target, round: roundsSorted.indexOf(bv) + 1, via: 'expand' });
      } else if (draftDecided) {
        finalEffective.set(c.playerId, { target: draft.target, round: roundsSorted.indexOf(bv) + 1, via: '草稿' });
      }
    }
  }
  for (const w of wolves) {
    const fe = finalEffective.get(w.id);
    push(`- P${w.id}：${fe ? `最終殺P${fe.target}（第 ${fe.round} 回合，經${fe.via}）` : '全程未決定'}`);
  }
  const finalTargets = new Set([...finalEffective.values()].map((v) => v.target));
  if (finalEffective.size === wolves.length && finalTargets.size === 1) {
    push(`- 收斂結果：三狼一致 → 殺P${[...finalTargets][0]}`);
  } else {
    push(`- 收斂結果：目標不一致（${[...finalTargets].map((t) => `殺P${t}`).join('、')}）→ 夜晚結算走多數決`);
  }
  push();

  push(`## 觀察發現`);
  if (contradictions.length > 0) {
    for (const k of contradictions) {
      push(`- ⚠ expand 與草稿決策矛盾：第 ${k.round} 回合 P${k.playerId} 草稿殺P${k.draftTarget}、expand 殺P${k.expandTarget}（scheduler 已沿用草稿，白板與決策一致）。`);
    }
  } else {
    push(`- 無 expand/草稿決策矛盾（全程旗標與草稿一致）。`);
  }
  // 安全閥逼近度：每狼連續資訊不足草稿數（scheduler 內部計數不可見，此處以可觀測草稿估算）
  const uncertainStreaks = new Map();
  for (const bv of roundsSorted) {
    const group = byVersion.get(bv);
    for (const c of group) {
      if (c.kind !== 'pre_speech' || c.playerId == null) continue;
      if (c.decision.status === 'uncertain') {
        uncertainStreaks.set(c.playerId, (uncertainStreaks.get(c.playerId) ?? 0) + 1);
      } else {
        uncertainStreaks.set(c.playerId, 0);
      }
    }
  }
  const maxStreak = Math.max(0, ...uncertainStreaks.values());
  push(`- 資訊不足最大連續次數：${maxStreak}（安全閥 MAX_UNCERTAIN_ROUNDS=50${maxStreak >= 50 ? ' → 已觸發強制棄票' : '，未觸發'}）。`);
  // 長間隔啟發式：呼叫間隔超過重試間隔 2 倍，疑似生產失敗重試
  const sortedCalls = [...calls].sort((a, b) => a.ts - b.ts);
  let longGaps = 0;
  for (let i = 1; i < sortedCalls.length; i++) {
    if (sortedCalls[i].ts - sortedCalls[i - 1].ts > RETRY_MS * 2) longGaps++;
  }
  push(longGaps > 0
    ? `- ⚠ 呼叫間隔超過 ${RETRY_MS * 2 / 1000} 秒共 ${longGaps} 次，疑似生產失敗重試（SPEECH_RETRY_MS=${RETRY_MS}）。`
    : `- 無長間隔（生產無失敗重試）。`);
  const flagRemnant = final.wolfDiscussionLog.filter((d) =>
    /\[決定[:：]/.test(d.text) || /(^|\n)\s*決定\s*[:：]\s*(投P\s*\d+|殺P\s*\d+|棄票|資訊不足)\s*($|\n)/.test(d.text));
  if (flagRemnant.length > 0) {
    push(`- ⚠ 決策旗標洩漏進白板：${flagRemnant.length} 筆播出含旗標殘留（stripDecisionFlags 未清乾淨）。`);
  }
  // 簡體字檢查：驗白板（最終播出，scheduler 正規化後）為準；
  // raw 殘留僅供參考（正規化前原文，預期仍有零星混入，已被清洗）。
  const simpRe = /[杀发对个说话认让过这进远运时实现务汉买读听观觉]/;
  const boardSimp = final.wolfDiscussionLog.filter((d) => simpRe.test(d.text));
  if (boardSimp.length > 0) {
    push(`- ⚠ 白板簡體字混入：${boardSimp.length} 筆播出含簡體（正規化未覆蓋，須補映射表）。`);
  } else {
    push(`- 白板無簡體字混入（scheduler 正規化生效）。`);
  }
  let rawSimp = 0;
  for (const c of calls) {
    if (simpRe.test(c.raw)) rawSimp++;
  }
  if (rawSimp > 0) {
    push(`- （模型原文含簡體 ${rawSimp} 筆，已於 intake 正規化，不影響播出。）`);
  }
  const doublePrefix = final.wolfDiscussionLog.filter((d) => d.text.startsWith(`P${d.playerId}：`)).length;
  if (doublePrefix > 0) {
    push(`- 顯示冗餘：AI 回覆已含「Px：「...」」前綴，prompt 組裝又加「Px：」，白板出現「P6：P6：「...」」（${doublePrefix} 筆）。`);
  }
  const effDecided = [...finalEffective.entries()].map(([pid, v]) => ({ playerId: pid, target: v.target }));
  const allyKills = effDecided.filter((c) => wolves.some((w) => w.id === c.target));
  if (allyKills.length > 0) {
    push(`- ⚠ 狼提議殺同盟：${allyKills.map((c) => `P${c.playerId}→殺P${c.target}`).join('、')}（目標是狼同盟，scheduler 視為棄票、夜晚結算亦會過濾）。`);
  }
  const drafts = calls.filter((c) => c.kind === 'pre_speech').map((c) => c.raw.trim());
  const unique = new Set(drafts).size;
  if (drafts.length > 1 && unique === 1) {
    push(`- 內容重複：所有草稿完全相同（${drafts.length} 筆），新穎性懲罰無法區分相似草稿。`);
  }

  const report = L.join('\n');
  writeFileSync(REPORT, report, 'utf8');
  console.log(`\n報告已寫入：${REPORT}`);
} finally {
  scheduler.stop();
  engine.close();
  await llm.shutdown();
}
