/**
 * human-discussion.test.ts — Phase 2 討論規則（SKIP 追蹤 / OPEN 內 READY_VOTE / 全跳過偵測）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGameState, transition, getNightActors, allAliveHumansSkipped,
} from './game-state.js';
import type { GameState } from './types.js';
import { Role, Team } from './types.js';

function aliveIds(s: GameState): number[] {
  return s.players.filter((p) => p.alive).map((p) => p.id);
}

function aliveHumans(s: GameState): number[] {
  return s.players.filter((p) => p.alive && p.controlledBy === 'human').map((p) => p.id);
}

/** 真人座位 3、7 的 9 人局，開局並跑完首夜（狼殺 keep 外最低非狼） */
function mixedDiscussionState(keep: number[] = [3, 7]): GameState {
  const s = createGameState(9);
  transition(s, { type: 'HUMAN_JOIN', playerId: 3, name: 'H1' });
  transition(s, { type: 'HUMAN_JOIN', playerId: 7, name: 'H2' });
  for (let id = 1; id <= 9; id++) {
    if (!s.players.some((p) => p.id === id)) transition(s, { type: 'AI_JOIN', playerId: id });
  }
  transition(s, { type: 'START_GAME' });
  for (const pid of getNightActors(s)) {
    const me = s.players.find((p) => p.id === pid)!;
    let pool = aliveIds(s).filter((id) => id !== pid && !keep.includes(id));
    if (me.role === Role.WEREWOLF) {
      pool = pool.filter((id) => s.players.find((p) => p.id === id)!.team !== Team.WEREWOLF);
    }
    if (pool.length === 0) pool = aliveIds(s).filter((id) => id !== pid);
    transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: pool[0] });
  }
  // 真人座位若在 gate 內（狼/seer/guard），補人類行動
  for (const pid of getNightActors(s)) {
    if (s.phase !== 'NIGHT_COLLECTING') break;
    const me = s.players.find((p) => p.id === pid)!;
    if (me.controlledBy !== 'human') continue;
    // gate 未完成代表該真人尚未行動
    if (s.pendingGate && !s.pendingGate.done.includes(pid)) {
      let pool = aliveIds(s).filter((id) => id !== pid && !keep.includes(id));
      if (me.role === Role.WEREWOLF) {
        pool = pool.filter((id) => s.players.find((p) => p.id === id)!.team !== Team.WEREWOLF);
      }
      if (pool.length === 0) pool = aliveIds(s).filter((id) => id !== pid);
      const r = transition(s, { type: 'HUMAN_NIGHT_ACTION', playerId: pid, targetId: pool[0] });
      assert.equal(r.accepted, true);
    }
  }
  transition(s, { type: 'RESOLVE_NIGHT' });
  assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
  return s;
}

test('HUMAN_SPEAK → 進 log + boardVersion++ + 移除發言者 skip', () => {
  const s = mixedDiscussionState();
  const humans = aliveHumans(s);
  assert.ok(humans.length >= 1);
  transition(s, { type: 'HUMAN_SKIP', playerId: humans[0] });
  assert.ok(s.skippedHumans.includes(humans[0]));
  const bv = s.boardVersion;
  const r = transition(s, { type: 'HUMAN_SPEAK', playerId: humans[0], text: '大家好' });
  assert.equal(r.accepted, true);
  assert.equal(s.boardVersion, bv + 1);
  assert.ok(!s.skippedHumans.includes(humans[0]));
  assert.equal(s.discussionLog.length, 1);
});

test('HUMAN_SKIP → 加入 skippedHumans；重複 skip 冪等；不觸發 boardVersion++', () => {
  const s = mixedDiscussionState();
  const humans = aliveHumans(s);
  assert.ok(humans.length >= 1);
  const bv = s.boardVersion;
  assert.equal(transition(s, { type: 'HUMAN_SKIP', playerId: humans[0] }).accepted, true);
  assert.equal(transition(s, { type: 'HUMAN_SKIP', playerId: humans[0] }).accepted, true);
  assert.deepEqual(s.skippedHumans, [humans[0]]);
  assert.equal(s.boardVersion, bv);
  // 死亡玩家 skip → 拒絕
  const dead = s.players.find((p) => !p.alive);
  if (dead) {
    assert.equal(transition(s, { type: 'HUMAN_SKIP', playerId: dead.id }).accepted, false);
  }
});

test('全真人跳過 → allAliveHumansSkipped = true；無真人 → false', () => {
  const s = mixedDiscussionState();
  const humans = aliveHumans(s);
  assert.ok(humans.length >= 1);
  assert.equal(allAliveHumansSkipped(s), false);
  for (const h of humans) transition(s, { type: 'HUMAN_SKIP', playerId: h });
  assert.equal(allAliveHumansSkipped(s), true);
  // 無真人局 → false
  const s2 = createGameState(6);
  for (let i = 0; i < 6; i++) transition(s2, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
  assert.equal(allAliveHumansSkipped(s2), false);
});

test('AI_SPEECH_DONE 被接受 → skippedHumans 清空', () => {
  const s = mixedDiscussionState();
  const humans = aliveHumans(s);
  for (const h of humans) transition(s, { type: 'HUMAN_SKIP', playerId: h });
  assert.equal(allAliveHumansSkipped(s), true);
  const speaker = aliveIds(s)[0];
  const r = transition(s, { type: 'AI_SPEECH_DONE', playerId: speaker, text: 'AI 發言', boardVersion: s.boardVersion });
  assert.equal(r.accepted, true);
  assert.deepEqual(s.skippedHumans, []);
});

test('HUMAN_READY_VOTE（OPEN）→ 全 ready → DAY_VOTING_COLLECTING + vote gate 開啟', () => {
  const s = mixedDiscussionState();
  const humans = aliveHumans(s);
  assert.ok(humans.length >= 1);
  for (let i = 0; i < humans.length - 1; i++) {
    const r = transition(s, { type: 'HUMAN_READY_VOTE', playerId: humans[i] });
    assert.equal(r.accepted, true);
    assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');   // 部分 ready → 維持 OPEN
  }
  const last = transition(s, { type: 'HUMAN_READY_VOTE', playerId: humans[humans.length - 1] });
  assert.equal(last.accepted, true);
  assert.equal(s.phase, 'DAY_VOTING_COLLECTING');
  assert.ok(s.pendingGate);
  assert.equal(s.pendingGate!.kind, 'vote');
  assert.ok(last.effects.some((e) => e.type === 'ARM_GATE'));
});

test('HUMAN_UNREADY_VOTE（OPEN）→ 移出 voteReady', () => {
  const s = mixedDiscussionState();
  const humans = aliveHumans(s);
  assert.ok(humans.length >= 1);
  transition(s, { type: 'HUMAN_READY_VOTE', playerId: humans[0] });
  assert.ok(s.voteReady.includes(humans[0]));
  const r = transition(s, { type: 'HUMAN_UNREADY_VOTE', playerId: humans[0] });
  assert.equal(r.accepted, true);
  assert.ok(!s.voteReady.includes(humans[0]));
  assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
  // 死亡玩家 ready → 拒絕
  const dead = s.players.find((p) => !p.alive);
  if (dead) {
    assert.equal(transition(s, { type: 'HUMAN_READY_VOTE', playerId: dead.id }).accepted, false);
  }
});

test('HUMAN_READY_VOTE（CLOSING）沿用；HUMAN_SKIP（CLOSING）視同 ready', () => {
  const s = mixedDiscussionState();
  transition(s, { type: 'CLOSE_DISCUSSION' });
  assert.equal(s.phase, 'DAY_DISCUSSION_CLOSING');
  const humans = aliveHumans(s);
  assert.ok(humans.length >= 1);
  // SKIP 視同 ready：唯一真人 skip → 直接開投票
  if (humans.length === 1) {
    const r = transition(s, { type: 'HUMAN_SKIP', playerId: humans[0] });
    assert.equal(r.accepted, true);
    assert.equal(s.phase, 'DAY_VOTING_COLLECTING');
  } else {
    transition(s, { type: 'HUMAN_SKIP', playerId: humans[0] });
    assert.equal(s.phase, 'DAY_DISCUSSION_CLOSING');
    const r = transition(s, { type: 'HUMAN_READY_VOTE', playerId: humans[1] });
    assert.equal(r.accepted, true);
  }
});
