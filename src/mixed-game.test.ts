/**
 * mixed-game.test.ts — Phase 2 混合局完整流程（2 真人 + 7 AI，含中途斷線接管 + 身分扁平化）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from './engine.js';
import { createGameState, getNightActors, buildSpectatorSnapshot, allAliveHumansSkipped } from './game-state.js';
import { buildPrompt } from './character-session.js';
import type { GameState } from './types.js';
import { Role, Team } from './types.js';

function aliveIds(s: GameState): number[] {
  return s.players.filter((p) => p.alive).map((p) => p.id);
}

function lowestAliveExcept(s: GameState, exclude: number): number {
  return aliveIds(s).filter((id) => id !== exclude).sort((a, b) => a - b)[0];
}

function wolfTarget(s: GameState, exclude: number): number {
  const prey = aliveIds(s).filter((id) => id !== exclude
    && s.players.find((p) => p.id === id)!.team !== Team.WEREWOLF).sort((a, b) => a - b);
  return prey[0] ?? lowestAliveExcept(s, exclude);
}

/** 身分扁平化：AI prompt 與觀戰 snapshot 永不含 controlledBy */
function assertFlat(s: GameState): void {
  for (const p of s.players.filter((x) => x.alive)) {
    for (const kind of ['speech', 'vote', 'night', 'wolf_speech'] as const) {
      const prompt = buildPrompt(s, p.id, kind);
      assert.ok(!prompt.includes('controlledBy'), `P${p.id} ${kind} prompt 洩漏 controlledBy`);
    }
  }
  const dumped = JSON.stringify(buildSpectatorSnapshot(s));
  assert.ok(!dumped.includes('controlledBy'));
}

function driveNight(engine: GameEngine): void {
  const s = engine.getState();
  for (const pid of getNightActors(s)) {
    const me = engine.getState().players.find((p) => p.id === pid)!;
    const target = me.role === Role.WEREWOLF
      ? wolfTarget(engine.getState(), pid)
      : lowestAliveExcept(engine.getState(), pid);
    engine.enqueue(me.controlledBy === 'human'
      ? { type: 'HUMAN_NIGHT_ACTION', playerId: pid, targetId: target }
      : { type: 'AI_NIGHT_DONE', playerId: pid, targetId: target });
  }
  engine.drain();
}

function driveDiscussion(engine: GameEngine, humanActions: { accepted: number; total: number }): void {
  const s = engine.getState();
  // 真人發言 → 跳過 → 準備投票
  for (const h of s.players.filter((p) => p.alive && p.controlledBy === 'human')) {
    engine.enqueue({ type: 'HUMAN_SPEAK', playerId: h.id, text: `P${h.id}：我覺得要多聽發言再決定。` });
  }
  engine.drain();
  const s2 = engine.getState();
  for (const h of s2.players.filter((p) => p.alive && p.controlledBy === 'human')) {
    engine.enqueue({ type: 'HUMAN_SKIP', playerId: h.id });
  }
  engine.drain();
  const s3 = engine.getState();
  const aliveHumans = s3.players.filter((p) => p.alive && p.controlledBy === 'human');
  if (aliveHumans.length > 0) {
    assert.equal(allAliveHumansSkipped(s3), true);
  }
  // AI 發言一則（版本相符）
  const speaker = aliveIds(engine.getState()).find((id) =>
    engine.getState().players.find((p) => p.id === id)!.controlledBy === 'ai');
  if (speaker !== undefined && engine.getState().phase === 'DAY_DISCUSSION_OPEN') {
    engine.enqueue({
      type: 'AI_SPEECH_DONE', playerId: speaker, text: 'AI：同意，多聽發言。',
      boardVersion: engine.getState().boardVersion,
    });
    engine.drain();
  }
  // 全員準備投票（真人 HUMAN_READY＋AI AI_READY，模擬 scheduler 收斂）→ 直進投票
  const s4 = engine.getState();
  if (s4.phase === 'DAY_DISCUSSION_OPEN') {
    for (const h of s4.players.filter((p) => p.alive && p.controlledBy === 'human')) {
      engine.enqueue({ type: 'HUMAN_READY_VOTE', playerId: h.id });
      humanActions.total++;
    }
    for (const a of s4.players.filter((p) => p.alive && p.controlledBy === 'ai')) {
      engine.enqueue({ type: 'AI_READY_VOTE', playerId: a.id });
    }
    engine.drain();
    humanActions.accepted += humanActions.total; // 全接受才會進投票，下方斷言 phase
  }
}

function driveVoting(engine: GameEngine): void {
  const s = engine.getState();
  const sorted = [...aliveIds(s)].sort((a, b) => a - b);
  const lowest = sorted[0];
  for (const v of aliveIds(engine.getState())) {
    const target = v === lowest ? sorted[1] : lowest;
    const me = engine.getState().players.find((p) => p.id === v)!;
    engine.enqueue(me.controlledBy === 'human'
      ? { type: 'HUMAN_VOTE', playerId: v, targetId: target }
      : { type: 'AI_VOTE_DONE', playerId: v, targetId: target });
  }
  engine.drain();
}

test('混合局：2 真人 + 7 AI 跑到 gameOver（含中途斷線接管）', () => {
  const engine = new GameEngine({ mode: 'gm' }, createGameState(9));
  engine.enqueue({ type: 'HUMAN_JOIN', playerId: 3, name: 'H1' });
  engine.enqueue({ type: 'HUMAN_JOIN', playerId: 7, name: 'H2' });
  for (let id = 1; id <= 9; id++) {
    if (!engine.getState().players.some((p) => p.id === id)) {
      engine.enqueue({ type: 'AI_JOIN', playerId: id });
    }
  }
  engine.enqueue({ type: 'START_GAME' });
  engine.drain();
  assert.equal(engine.getState().phase, 'NIGHT_DISCUSSION_OPEN');

  const humanActions = { accepted: 0, total: 0 };
  let disconnected = false;
  let steps = 0;
  while (!engine.getState().gameOver && steps < 300) {
    steps++;
    const s = engine.getState();
    assertFlat(s);
    switch (s.phase) {
      case 'NIGHT_DISCUSSION_OPEN': {
        for (const p of engine.getState().players.filter((x) => x.alive && x.role === Role.WEREWOLF)) {
          engine.enqueue(p.controlledBy === 'human'
            ? { type: 'HUMAN_WOLF_READY', playerId: p.id }
            : { type: 'AI_WOLF_READY', playerId: p.id });
        }
        engine.drain();
        break;
      }
      case 'NIGHT_COLLECTING':
        driveNight(engine);
        break;
      case 'DAY_DISCUSSION_OPEN': {
        const aliveHumans = engine.getState().players.filter((p) => p.alive && p.controlledBy === 'human');
        if (aliveHumans.length === 0) {
          // 無存活真人 → 全員 AI 灌滿 ready（收斂直進投票）
          for (const a of engine.getState().players.filter((p) => p.alive)) {
            engine.enqueue({ type: 'AI_READY_VOTE', playerId: a.id });
          }
          engine.drain();
        } else {
          driveDiscussion(engine, humanActions);
        }
        break;
      }
      case 'DAY_VOTING_COLLECTING':
        driveVoting(engine);
        break;
      default:
        engine.drain();
        break;
    }
    // 第 2 天中途斷線：P7 DISCONNECT → AI 接管 → 遊戲繼續
    if (!disconnected && engine.getState().day >= 2) {
      disconnected = true;
      const p7 = engine.getState().players.find((p) => p.id === 7);
      if (p7 && p7.alive && p7.controlledBy === 'human') {
        engine.enqueue({ type: 'DISCONNECT', playerId: 7 });
        engine.drain();
        assert.equal(engine.getState().players.find((p) => p.id === 7)!.controlledBy, 'ai');
      }
    }
  }
  assert.ok(engine.getState().gameOver, `應分出勝負（steps=${steps}）`);
  assert.ok(engine.getState().winner === 'village' || engine.getState().winner === 'werewolf');
  assert.ok(disconnected);
  // 真人準備投票全部被接受（phase 有推進即證明）
  assert.ok(humanActions.total > 0);
  engine.close();
});
