/**
 * human-reconnect.test.ts — Phase 2 斷線/重連（接管翻轉 / 拿回 / canAct 續作）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGameState, transition, getNightActors, buildPlayerSnapshot,
} from './game-state.js';
import type { GameState } from './types.js';
import { Role, Team } from './types.js';

function aliveIds(s: GameState): number[] {
  return s.players.filter((p) => p.alive).map((p) => p.id);
}

/** 狼密談收斂：全存活狼 ready → NIGHT_COLLECTING（新流程：START_GAME/ADVANCE_DAY 先進 NIGHT_DISCUSSION_OPEN） */
function convergeWolfDiscussion(s: GameState): void {
  for (const p of s.players) {
    if (p.alive && p.role === Role.WEREWOLF) {
      const r = transition(s, p.controlledBy === 'human'
        ? { type: 'HUMAN_WOLF_READY', playerId: p.id }
        : { type: 'AI_WOLF_READY', playerId: p.id });
      assert.equal(r.accepted, true);
    }
  }
  assert.equal(s.phase, 'NIGHT_COLLECTING');
}

/** 6 人局真人座位 1，開局到 NIGHT_COLLECTING */
function started6(): GameState {
  const s = createGameState(6);
  transition(s, { type: 'HUMAN_JOIN', playerId: 1, name: 'H' });
  for (let id = 2; id <= 6; id++) transition(s, { type: 'AI_JOIN', playerId: id });
  transition(s, { type: 'START_GAME' });
  convergeWolfDiscussion(s);
  assert.equal(s.phase, 'NIGHT_COLLECTING');
  return s;
}

function toDiscussion(s: GameState, keep: number[] = [1]): void {
  if (s.phase === 'NIGHT_DISCUSSION_OPEN') convergeWolfDiscussion(s);
  for (const pid of getNightActors(s)) {
    const me = s.players.find((p) => p.id === pid)!;
    let pool = aliveIds(s).filter((id) => id !== pid && !keep.includes(id));
    if (me.role === Role.WEREWOLF) {
      pool = pool.filter((id) => s.players.find((p) => p.id === id)!.team !== Team.WEREWOLF);
    }
    if (pool.length === 0) pool = aliveIds(s).filter((id) => id !== pid);
    const ev = me.controlledBy === 'human'
      ? { type: 'HUMAN_NIGHT_ACTION', playerId: pid, targetId: pool[0] } as const
      : { type: 'AI_NIGHT_DONE', playerId: pid, targetId: pool[0] } as const;
    transition(s, ev);
  }
  transition(s, { type: 'RESOLVE_NIGHT' });
  assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
}

/** 討論中全員 ready 直進投票（收斂 helper） */
function readyAllToVoting(s: GameState): void {
  for (const p of s.players.filter((x) => x.alive)) {
    transition(s, p.controlledBy === 'human'
      ? { type: 'HUMAN_READY_VOTE', playerId: p.id }
      : { type: 'AI_READY_VOTE', playerId: p.id });
  }
  assert.equal(s.phase, 'DAY_VOTING_COLLECTING');
}

test('DISCONNECT → controlledBy ai + 移出 voteReady/skippedHumans', () => {
  const s = started6();
  toDiscussion(s);
  transition(s, { type: 'HUMAN_SKIP', playerId: 1 });
  transition(s, { type: 'HUMAN_READY_VOTE', playerId: 1 });
  assert.ok(s.voteReady.includes(1));
  const r = transition(s, { type: 'DISCONNECT', playerId: 1 });
  assert.equal(r.accepted, true);
  assert.equal(s.players.find((p) => p.id === 1)!.controlledBy, 'ai');
  assert.ok(!s.voteReady.includes(1));
  assert.ok(!s.skippedHumans.includes(1));
});

test('RECONNECT（存活）→ controlledBy human', () => {
  const s = started6();
  toDiscussion(s);
  transition(s, { type: 'DISCONNECT', playerId: 1 });
  assert.equal(s.players.find((p) => p.id === 1)!.controlledBy, 'ai');
  const r = transition(s, { type: 'RECONNECT', playerId: 1 });
  assert.equal(r.accepted, true);
  assert.equal(s.players.find((p) => p.id === 1)!.controlledBy, 'human');
});

test('RECONNECT（死亡）→ 拒絕；RECONNECT（SETUP）→ 拒絕', () => {
  const s = started6();
  // 殺掉 P1（投票路徑太長，直接標記死亡驗證拒絕邏輯）
  s.players.find((p) => p.id === 1)!.alive = false;
  const r = transition(s, { type: 'RECONNECT', playerId: 1 });
  assert.equal(r.accepted, false);
  // 不存在的玩家
  assert.equal(transition(s, { type: 'RECONNECT', playerId: 99 }).accepted, false);
  // SETUP 階段
  const lobby = createGameState(6);
  transition(lobby, { type: 'HUMAN_JOIN', playerId: 1 });
  assert.equal(transition(lobby, { type: 'RECONNECT', playerId: 1 }).accepted, false);
});

test('重連後 gate 內可繼續行動（canAct 正確）', () => {
  const s = started6();
  const actors = getNightActors(s);
  if (!actors.includes(1)) {
    // 真人不在夜晚 gate → 測投票 gate：先到投票
    toDiscussion(s);
    readyAllToVoting(s);   // 全員 ready 直進投票
    transition(s, { type: 'DISCONNECT', playerId: 1 });
    transition(s, { type: 'RECONNECT', playerId: 1 });
    const snap = buildPlayerSnapshot(s, 1);
    assert.equal(snap.you.canAct, true);   // gate 內未 done → 可繼續投票
    return;
  }
  // 真人在夜晚 gate 內：斷線 → 重連 → canAct 仍 true
  transition(s, { type: 'DISCONNECT', playerId: 1 });
  // AI 接管補派的 DISPATCH_LLM effect（transition 層只驗 effect 存在）
  transition(s, { type: 'RECONNECT', playerId: 1 });
  const snap = buildPlayerSnapshot(s, 1);
  assert.equal(snap.you.canAct, true);
  const me = s.players.find((p) => p.id === 1)!;
  const target = me.role === Role.WEREWOLF
    ? aliveIds(s).filter((id) => id !== 1 && s.players.find((p) => p.id === id)!.team !== Team.WEREWOLF)[0]
    : aliveIds(s).filter((id) => id !== 1)[0];
  assert.equal(transition(s, { type: 'HUMAN_NIGHT_ACTION', playerId: 1, targetId: target }).accepted, true);
});

test('斷線接管後 AI 完成行動 → 重連 → 行動不可重做（canAct = false）', () => {
  const s = started6();
  toDiscussion(s);
  readyAllToVoting(s);
  transition(s, { type: 'DISCONNECT', playerId: 1 });   // AI 接管
  // AI 代投（done 含 P1）
  const target = aliveIds(s).filter((id) => id !== 1)[0];
  assert.equal(transition(s, { type: 'AI_VOTE_DONE', playerId: 1, targetId: target }).accepted, true);
  transition(s, { type: 'RECONNECT', playerId: 1 });
  const snap = buildPlayerSnapshot(s, 1);
  assert.equal(snap.you.canAct, false);
});

test('DISCONNECT 冪等：已是 ai → 接受但無效果', () => {
  const s = started6();
  const aiId = 2;
  const before = JSON.stringify(s.players);
  const r = transition(s, { type: 'DISCONNECT', playerId: aiId });
  assert.equal(r.accepted, true);
  assert.equal(JSON.stringify(s.players), before);
  assert.ok(!r.effects.some((e) => e.type === 'DISPATCH_LLM'));
});
