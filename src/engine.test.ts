/**
 * engine.test.ts — 佇列順序 / 存檔觸發 / 版本丟棄 / gate timer / ScriptedGM 完整局
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { GameEngine } from './engine.js';
import { createGameState, getNightActors } from './game-state.js';
import type { GameState } from './types.js';
import { Role, Team } from './types.js';

const SAVE_FILE = path.join(process.cwd(), 'game-state.json');
let backup: string | null = null;

before(() => {
  backup = fs.existsSync(SAVE_FILE) ? fs.readFileSync(SAVE_FILE, 'utf-8') : null;
  if (fs.existsSync(SAVE_FILE)) fs.unlinkSync(SAVE_FILE);
});

after(() => {
  if (backup !== null) fs.writeFileSync(SAVE_FILE, backup);
  else if (fs.existsSync(SAVE_FILE)) fs.unlinkSync(SAVE_FILE);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aliveIds(s: GameState): number[] {
  return s.players.filter((p) => p.alive).map((p) => p.id);
}

test('佇列順序：enqueue 多事件 → drain 依序處理', () => {
  const engine = new GameEngine({ mode: 'gm' }, createGameState(6));
  assert.equal(engine.pendingCount(), 0);
  for (let i = 0; i < 6; i++) engine.enqueue({ type: 'CLIENT_JOIN', name: `P${i + 1}` });
  assert.equal(engine.pendingCount(), 6);
  engine.drain();
  assert.equal(engine.pendingCount(), 0);
  const names = engine.getState().players.map((p) => p.name);
  assert.deepEqual(names, ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  assert.equal(engine.getState().phase, 'SETUP_READY');
  engine.close();
});

test('存檔觸發：phase 變更立即存；無變更只 debounce', () => {
  if (fs.existsSync(SAVE_FILE)) fs.unlinkSync(SAVE_FILE);
  const engine = new GameEngine({ mode: 'gm' }, createGameState(6));
  engine.enqueue({ type: 'CLIENT_JOIN', name: 'P1' });
  engine.enqueue({ type: 'CLIENT_JOIN', name: 'P2' });
  engine.drain();
  // 無 phase 變更 → 不立即寫檔（debounce 5s）
  assert.ok(!fs.existsSync(SAVE_FILE));
  engine.save(); // flushSave
  assert.ok(fs.existsSync(SAVE_FILE));
  const saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf-8')) as GameState;
  assert.equal(saved.players.length, 2);
  engine.close();
});

test('存檔觸發：phase 變更立即寫檔', () => {
  if (fs.existsSync(SAVE_FILE)) fs.unlinkSync(SAVE_FILE);
  const engine = new GameEngine({ mode: 'gm' }, createGameState(6));
  for (let i = 0; i < 6; i++) engine.enqueue({ type: 'CLIENT_JOIN', name: `P${i + 1}` });
  engine.drain();
  engine.enqueue({ type: 'START_GAME' });
  engine.drain();
  assert.ok(fs.existsSync(SAVE_FILE));
  const saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf-8')) as GameState;
  assert.equal(saved.phase, 'NIGHT_COLLECTING');
  engine.close();
});

test('版本丟棄：舊 boardVersion 的 AI_SPEECH_DONE 被丟棄', () => {
  const engine = new GameEngine({ mode: 'gm' }, createGameState(6));
  for (let i = 0; i < 6; i++) engine.enqueue({ type: 'CLIENT_JOIN', name: `P${i + 1}` });
  engine.enqueue({ type: 'START_GAME' });
  engine.enqueue({ type: 'ACTION_TIMEOUT', gateId: 'night-1' });
  engine.drain();
  assert.equal(engine.getState().phase, 'DAY_DISCUSSION_OPEN');
  const speaker = aliveIds(engine.getState())[0];
  const bv = engine.getState().boardVersion;
  engine.enqueue({ type: 'AI_SPEECH_DONE', playerId: speaker, text: '過期', boardVersion: bv - 1 });
  engine.drain();
  assert.equal(engine.getState().discussionLog.length, 0);
  engine.enqueue({ type: 'AI_SPEECH_DONE', playerId: speaker, text: '新鮮', boardVersion: bv });
  engine.drain();
  assert.equal(engine.getState().discussionLog.length, 1);
  engine.close();
});

test('gate timer：web 模式超時自動 ACTION_TIMEOUT', async () => {
  const engine = new GameEngine(
    { mode: 'web', nightTimeoutMs: 40, saveDebounceMs: 10 },
    createGameState(6),
  );
  for (let i = 0; i < 6; i++) engine.enqueue({ type: 'CLIENT_JOIN', name: `P${i + 1}` });
  engine.enqueue({ type: 'START_GAME' });
  engine.drain();
  assert.equal(engine.getState().phase, 'NIGHT_COLLECTING');
  assert.ok((engine.getState().pendingGate?.deadline ?? 0) > 0);
  await sleep(150);
  // timer 到期 → TIMEOUT → RESOLVING → 自動 RESOLVE → DISCUSSION_OPEN
  assert.equal(engine.getState().phase, 'DAY_DISCUSSION_OPEN');
  engine.close();
});

test('ScriptedGM：啟發式完整局跑通（確定性策略）', () => {
  const engine = new GameEngine({ mode: 'gm' }, createGameState(9));
  for (let i = 0; i < 9; i++) engine.enqueue({ type: 'CLIENT_JOIN', name: `P${i + 1}` });
  engine.enqueue({ type: 'START_GAME' });
  engine.drain();

  const lowestAliveExcept = (s: GameState, exclude: number): number => {
    const ids = aliveIds(s).filter((id) => id !== exclude).sort((a, b) => a - b);
    return ids[0];
  };

  let steps = 0;
  while (!engine.getState().gameOver && steps < 200) {
    steps++;
    const s = engine.getState();
    switch (s.phase) {
      case 'NIGHT_COLLECTING':
        for (const pid of getNightActors(s)) {
          engine.enqueue({ type: 'AI_NIGHT_DONE', playerId: pid, targetId: lowestAliveExcept(engine.getState(), pid) });
        }
        engine.drain();
        break;
      case 'DAY_DISCUSSION_OPEN': {
        for (const p of engine.getState().players.filter((x) => x.alive)) {
          engine.enqueue({
            type: 'AI_SPEECH_DONE',
            playerId: p.id,
            text: `P${p.id}：聽完發言再決定。`,
            boardVersion: engine.getState().boardVersion,
          });
        }
        // 收斂直進投票：全員 ready（灌滿）→ 投票 gate
        for (const p of engine.getState().players.filter((x) => x.alive)) {
          engine.enqueue(p.controlledBy === 'human'
            ? { type: 'HUMAN_READY_VOTE', playerId: p.id }
            : { type: 'AI_READY_VOTE', playerId: p.id });
        }
        engine.drain();
        break;
      }
      case 'DAY_VOTING_COLLECTING': {
        // 全投最低存活 id（非自己則投自己順位調整）→ 每天穩定出局一人
        const snap = engine.getState();
        const lowest = [...aliveIds(snap)].sort((a, b) => a - b)[0];
        for (const v of aliveIds(engine.getState())) {
          const target = v === lowest ? [...aliveIds(engine.getState())].sort((a, b) => a - b)[1] : lowest;
          engine.enqueue({ type: 'AI_VOTE_DONE', playerId: v, targetId: target });
        }
        engine.drain();
        break;
      }
      default:
        engine.drain();
        break;
    }
  }
  assert.ok(engine.getState().gameOver, `應分出勝負（steps=${steps}, phase=${engine.getState().phase}）`);
  assert.ok(engine.getState().winner === 'village' || engine.getState().winner === 'werewolf');
  engine.close();
});

test('Phase 2：boardVersion 變更 → scheduler.onBoardUpdated 被呼叫', () => {
  const notified: GameState[] = [];
  const fakeScheduler = {
    onBoardUpdated: (s: GameState) => { notified.push(s); },
    onPhaseEntered: () => undefined,
  };
  const engine = new GameEngine({ mode: 'gm', scheduler: fakeScheduler }, createGameState(6));
  for (let i = 0; i < 6; i++) engine.enqueue({ type: 'CLIENT_JOIN', name: `P${i + 1}` });
  engine.drain();
  const beforeJoin = notified.length;
  engine.enqueue({ type: 'START_GAME' });
  engine.enqueue({ type: 'ACTION_TIMEOUT', gateId: 'night-1' });
  engine.drain();
  assert.equal(engine.getState().phase, 'DAY_DISCUSSION_OPEN');
  // START_GAME / RESOLVE_NIGHT 皆 boardVersion++ → 皆通知
  assert.ok(notified.length > beforeJoin);
  const n0 = notified.length;
  // HUMAN_SPEAK 被接受 → boardVersion++ → 通知
  const speaker = aliveIds(engine.getState())[0];
  engine.enqueue({ type: 'HUMAN_SPEAK', playerId: speaker, text: '真人發言' });
  engine.drain();
  assert.equal(notified.length, n0 + 1);
  // 被拒事件（版本不符）→ 不通知
  engine.enqueue({
    type: 'AI_SPEECH_DONE', playerId: speaker, text: '過期', boardVersion: engine.getState().boardVersion - 1,
  });
  engine.drain();
  assert.equal(notified.length, n0 + 1);
  engine.close();
});

test('掛機接管鏈：10 次 AI 發言 → engine 切座位＋takenOver 標記＋registry 通知；RECONNECT 拿回', () => {
  const notified: { playerId: number; reason: string }[] = [];
  const registry = {
    getConnectedPlayerIds: (): number[] => [],
    send: (): void => undefined,
    notifyTakeover: (playerId: number, reason: string): void => {
      notified.push({ playerId, reason });
    },
  };
  const engine = new GameEngine({ mode: 'gm', registry }, createGameState(6));
  engine.enqueue({ type: 'HUMAN_JOIN', playerId: 1, name: 'H' });
  for (let id = 2; id <= 6; id++) engine.enqueue({ type: 'AI_JOIN', playerId: id });
  engine.enqueue({ type: 'START_GAME' });
  engine.drain();
  // 確定性守夜：保 P1 存活（狼刀 P1 以外最低非狼）
  {
    const s0 = engine.getState();
    for (const pid of getNightActors(s0)) {
      const me = s0.players.find((p) => p.id === pid)!;
      const pool = s0.players
        .filter((p) => p.alive && p.id !== pid && p.id !== 1
          && (me.role !== Role.WEREWOLF || p.team !== Team.WEREWOLF))
        .map((p) => p.id);
      const target = pool[0] ?? s0.players.filter((p) => p.alive && p.id !== pid)[0].id;
      engine.enqueue(me.controlledBy === 'human'
        ? { type: 'HUMAN_NIGHT_ACTION', playerId: pid, targetId: target }
        : { type: 'AI_NIGHT_DONE', playerId: pid, targetId: target });
    }
    engine.drain();
  }
  assert.equal(engine.getState().phase, 'DAY_DISCUSSION_OPEN');
  assert.ok(engine.getState().players.find((p) => p.id === 1)!.alive, 'P1 應存活');
  const speaker = engine.getState().players.find((p) => p.alive && p.controlledBy === 'ai')!.id;
  for (let i = 0; i < 10; i++) {
    engine.enqueue({
      type: 'AI_SPEECH_DONE', playerId: speaker, text: `AI 發言${i}`,
      boardVersion: engine.getState().boardVersion,
    });
    engine.drain();
  }
  const st = engine.getState();
  assert.equal(st.players.find((p) => p.id === 1)!.controlledBy, 'ai', 'engine 應切座位');
  assert.ok(st.takenOver.includes(1), '快照應帶接管標記');
  assert.equal(notified.length, 1);
  assert.equal(notified[0].playerId, 1);
  // 拿回：回到未定＋標記移除
  engine.enqueue({ type: 'RECONNECT', playerId: 1 });
  engine.drain();
  const back = engine.getState();
  assert.equal(back.players.find((p) => p.id === 1)!.controlledBy, 'human');
  assert.ok(!back.takenOver.includes(1));
  engine.close();
});

test('Phase 2：tryEvent 立即處理並回傳 TransitionResult', () => {
  const engine = new GameEngine({ mode: 'gm' }, createGameState(6));
  const r = engine.tryEvent({ type: 'HUMAN_JOIN', playerId: 1, name: 'H' });
  assert.equal(r.accepted, true);
  assert.ok(r.effects.some((e) => e.type === 'BROADCAST'));
  const bad = engine.tryEvent({ type: 'HUMAN_JOIN', playerId: 1, name: 'H2' });
  assert.equal(bad.accepted, false);
  assert.equal(bad.reason, 'seat taken');
  engine.close();
});
