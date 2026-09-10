/**
 * human-discussion.test.ts — Phase 2 討論規則（SKIP 追蹤 / OPEN 內 READY_VOTE / 全跳過偵測）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGameState, transition, getNightActors, allAliveHumansSkipped,
  allAlivePlayersReady, IDLE_TAKEOVER_THRESHOLD,
} from './game-state.js';
import type { GameState } from './types.js';
import { Role, Team } from './types.js';

function aliveAI(s: GameState): number[] {
  return s.players.filter((p) => p.alive && p.controlledBy === 'ai').map((p) => p.id);
}

/** 灌滿 ready：全存活真人 HUMAN_READY＋全存活 AI AI_READY → 應直進投票 */
function readyAll(s: GameState): void {
  for (const h of aliveHumans(s)) transition(s, { type: 'HUMAN_READY_VOTE', playerId: h });
  for (const a of aliveAI(s)) transition(s, { type: 'AI_READY_VOTE', playerId: a });
}

function aliveIds(s: GameState): number[] {
  return s.players.filter((p) => p.alive).map((p) => p.id);
}

function aliveHumans(s: GameState): number[] {
  return s.players.filter((p) => p.alive && p.controlledBy === 'human').map((p) => p.id);
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

/** 真人座位 3、7 的 9 人局，開局並跑完首夜（狼殺 keep 外最低非狼） */
function mixedDiscussionState(keep: number[] = [3, 7]): GameState {
  const s = createGameState(9);
  transition(s, { type: 'HUMAN_JOIN', playerId: 3, name: 'H1' });
  transition(s, { type: 'HUMAN_JOIN', playerId: 7, name: 'H2' });
  for (let id = 1; id <= 9; id++) {
    if (!s.players.some((p) => p.id === id)) transition(s, { type: 'AI_JOIN', playerId: id });
  }
  transition(s, { type: 'START_GAME' });
  convergeWolfDiscussion(s);
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

test('統一檢查：全員（真人＋AI）ready → 直進投票（無 CLOSING）；部分 ready 維持 OPEN', () => {
  const s = mixedDiscussionState();
  const humans = aliveHumans(s);
  assert.ok(humans.length >= 1);
  for (const h of humans) {
    const r = transition(s, { type: 'HUMAN_READY_VOTE', playerId: h });
    assert.equal(r.accepted, true);
  }
  assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');   // AI 未定 → 維持 OPEN
  assert.equal(allAlivePlayersReady(s), false);
  let last: ReturnType<typeof transition> | undefined;
  for (const a of aliveAI(s)) {
    last = transition(s, { type: 'AI_READY_VOTE', playerId: a });
    assert.equal(last.accepted, true);
  }
  assert.equal(allAlivePlayersReady(s), true);
  assert.equal(s.phase, 'DAY_VOTING_COLLECTING');
  assert.ok(s.pendingGate);
  assert.equal(s.pendingGate!.kind, 'vote');
  assert.ok(last!.effects.some((e) => e.type === 'ARM_GATE'));
});

test('AI_READY_VOTE：死亡玩家拒絕；單向不退（無 AI_UNREADY）', () => {
  const s = mixedDiscussionState();
  const ai = aliveAI(s)[0];
  assert.equal(transition(s, { type: 'AI_READY_VOTE', playerId: ai }).accepted, true);
  assert.ok(s.voteReady.includes(ai));
  // 重複 ready 冪等
  assert.equal(transition(s, { type: 'AI_READY_VOTE', playerId: ai }).accepted, true);
  const dead = s.players.find((p) => !p.alive);
  if (dead) {
    assert.equal(transition(s, { type: 'AI_READY_VOTE', playerId: dead.id }).accepted, false);
  }
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

test('HUMAN_SKIP（OPEN）保留：只記 skippedHumans，不視同 ready、不推進投票', () => {
  const s = mixedDiscussionState();
  const humans = aliveHumans(s);
  assert.ok(humans.length >= 1);
  for (const h of humans) transition(s, { type: 'HUMAN_SKIP', playerId: h });
  assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
  assert.ok(!s.voteReady.includes(humans[0]), 'skip 不視同 ready');
});

test('掛機計數：AI 發言未定真人 +1；已 ready 排除；任一真人發話／跳過／收回即清空', () => {
  const s = mixedDiscussionState();
  const humans = aliveHumans(s);
  assert.ok(humans.length >= 1);
  const speaker = aliveAI(s)[0] ?? aliveIds(s)[0];
  const speak = (): void => {
    const r = transition(s, { type: 'AI_SPEECH_DONE', playerId: speaker, text: `發言${s.boardVersion}`, boardVersion: s.boardVersion });
    assert.equal(r.accepted, true);
  };
  speak();
  speak();
  assert.equal(s.idleCounts[humans[0]], 2);
  // 已 ready 者排除並清空
  transition(s, { type: 'HUMAN_READY_VOTE', playerId: humans[0] });
  assert.ok(!(humans[0] in s.idleCounts));
  speak();
  assert.ok(!(humans[0] in s.idleCounts), '已 ready 不計數');
  // 收回 → 從零重算（回到未定）
  transition(s, { type: 'HUMAN_UNREADY_VOTE', playerId: humans[0] });
  speak();
  assert.equal(s.idleCounts[humans[0]], 1);
  // 任一真人發話即清空全部
  transition(s, { type: 'HUMAN_SPEAK', playerId: humans[0], text: '我回來了' });
  assert.deepEqual(s.idleCounts, {});
  // 跳過亦清空
  speak();
  assert.equal(s.idleCounts[humans[0]], 1);
  transition(s, { type: 'HUMAN_SKIP', playerId: humans[0] });
  assert.deepEqual(s.idleCounts, {});
});

test('掛機接管鏈：計數到 10 → IDLE_TAKEOVER effect（transition 只回傳，不切座位）', () => {
  assert.equal(IDLE_TAKEOVER_THRESHOLD, 10);
  const s = mixedDiscussionState();
  const humans = aliveHumans(s);
  assert.ok(humans.length >= 1);
  const target = humans[0];
  const speaker = aliveAI(s)[0] ?? aliveIds(s)[0];
  let takeover: { type: string; playerId?: number } | undefined;
  for (let i = 0; i < IDLE_TAKEOVER_THRESHOLD; i++) {
    const r = transition(s, { type: 'AI_SPEECH_DONE', playerId: speaker, text: `發言${i}`, boardVersion: s.boardVersion });
    assert.equal(r.accepted, true);
    if (i === IDLE_TAKEOVER_THRESHOLD - 1) {
      takeover = r.effects.find((e) => e.type === 'IDLE_TAKEOVER');
    }
  }
  assert.ok(takeover, '第 10 次應回傳 IDLE_TAKEOVER');
  assert.equal((takeover as { playerId: number }).playerId, target);
  // transition 不切座位（engine 執行）
  assert.equal(s.players.find((p) => p.id === target)!.controlledBy, 'human');
});

test('接管拿回：RECONNECT → 回到未定＋接管標記移除＋計數清零', () => {
  const s = mixedDiscussionState();
  const target = aliveHumans(s)[0];
  transition(s, { type: 'HUMAN_READY_VOTE', playerId: target });
  s.takenOver.push(target);
  s.idleCounts[target] = 5;
  const r = transition(s, { type: 'RECONNECT', playerId: target });
  assert.equal(r.accepted, true);
  assert.ok(!s.voteReady.includes(target), '拿回後回到未定');
  assert.ok(!s.takenOver.includes(target));
  assert.ok(!(target in s.idleCounts));
});
