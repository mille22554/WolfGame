/**
 * snapshot.test.ts — per-client 資訊過濾測試
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameState, transition, buildPlayerSnapshot, buildGMSnapshot, buildSpectatorSnapshot, getNightActors } from './game-state.js';
import type { GameState } from './types.js';
import { Role, Team, NightActionType } from './types.js';
import { personalities } from './personalities.js';

function joinAll(state: GameState, count: number): void {
  for (let i = 0; i < count; i++) transition(state, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
}

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

function toDiscussion(s: GameState, keep: number[] = []): void {
  if (s.phase === 'NIGHT_DISCUSSION_OPEN') convergeWolfDiscussion(s);
  for (const pid of getNightActors(s)) {
    const me = s.players.find((p) => p.id === pid)!;
    let pool = aliveIds(s).filter((id) => id !== pid && !keep.includes(id));
    if (me.role === Role.WEREWOLF) {
      pool = pool.filter((id) => s.players.find((p) => p.id === id)!.team !== Team.WEREWOLF);
    }
    if (pool.length === 0) pool = aliveIds(s).filter((id) => id !== pid);
    transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: pool[0] });
  }
  transition(s, { type: 'RESOLVE_NIGHT' });
}

test('村民看不到任何 role/team/controlledBy', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  toDiscussion(s);
  const villager = s.players.find((p) => p.role === Role.VILLAGER && p.alive)!;
  const snap = buildPlayerSnapshot(s, villager.id);
  for (const p of snap.alivePlayers) {
    assert.deepEqual(Object.keys(p).sort(), ['id', 'name']);
  }
  const { you, ...pub } = snap;
  const dumped = JSON.stringify(pub);
  assert.ok(!dumped.includes('controlledBy'));
  assert.ok(!dumped.includes('"role"'));
  assert.ok(!dumped.includes('"team"'));
  assert.ok(!dumped.includes('werewolf') || dumped.includes('nightResult'));
});

test('seer 看得到自己的 seerChecks', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  convergeWolfDiscussion(s);
  const seer = s.players.find((p) => p.role === Role.SEER)!;
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  for (const pid of getNightActors(s)) {
    const target = pid === seer.id ? wolf.id : aliveIds(s).filter((id) => id !== pid)[0];
    transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: target });
  }
  transition(s, { type: 'RESOLVE_NIGHT' });
  const snap = buildPlayerSnapshot(s, seer.id);
  assert.ok(snap.you.seerChecks);
  assert.equal(snap.you.seerChecks!.length, 1);
  assert.equal(snap.you.seerChecks![0].targetId, wolf.id);
  assert.equal(snap.you.seerChecks![0].result, Team.WEREWOLF);
  // 非 seer 看不到
  const villager = s.players.find((p) => p.role === Role.VILLAGER && p.alive)!;
  assert.equal(buildPlayerSnapshot(s, villager.id).you.seerChecks, undefined);
});

test('guard 看得到自己的 guardProtects', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const guard = s.players.find((p) => p.role === Role.GUARD)!;
  // 保守衛首夜存活，推進到 day2（guard day1 不可行動）
  toDiscussion(s, [guard.id]);
  for (const p of s.players.filter((x) => x.alive)) {
    transition(s, { type: 'AI_READY_VOTE', playerId: p.id });
  } // 全 AI 收斂 → 直接 VOTING
  const voters = [...s.pendingGate!.required];
  const voteTarget = voters.find((id) => id !== guard.id)!;
  for (const voter of voters) {
    transition(s, { type: 'AI_VOTE_DONE', playerId: voter, targetId: voter === voteTarget ? voters.find((id) => id !== voteTarget)! : voteTarget });
  }
  transition(s, { type: 'RESOLVE_VOTES' });
  transition(s, { type: 'ADVANCE_DAY' });
  assert.equal(s.day, 2);
  assert.ok(guard.alive);
  convergeWolfDiscussion(s);
  const actors = getNightActors(s);
  assert.ok(actors.includes(guard.id));
  for (const pid of actors) {
    const me = s.players.find((p) => p.id === pid)!;
    let pool = aliveIds(s).filter((id) => id !== pid && id !== guard.id);
    if (me.role === Role.WEREWOLF) {
      pool = pool.filter((id) => s.players.find((p) => p.id === id)!.team !== Team.WEREWOLF);
    }
    transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: pool[0] });
  }
  transition(s, { type: 'RESOLVE_NIGHT' });
  const snap = buildPlayerSnapshot(s, guard.id);
  assert.ok(snap.you.guardProtects);
  assert.equal(snap.you.guardProtects!.length, 1);
});

test('medium 的 mediumResults 由 deathHistory 推導', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const mediumEarly = s.players.find((p) => p.role === Role.MEDIUM)!;
  toDiscussion(s, [mediumEarly.id]); // 保靈能者首夜存活
  for (const p of s.players.filter((x) => x.alive)) {
    transition(s, { type: 'AI_READY_VOTE', playerId: p.id });
  }
  const voters = [...s.pendingGate!.required];
  // 目標避開靈能者（否則被票死，本案例無法觀察；voters[0] 恰為靈能者約 1/8 機率）
  const target = voters.find((v) => v !== mediumEarly.id) ?? voters[0];
  for (const voter of voters) {
    transition(s, { type: 'AI_VOTE_DONE', playerId: voter, targetId: voter === target ? voters[1] : target });
  }
  transition(s, { type: 'RESOLVE_VOTES' });
  const medium = s.players.find((p) => p.role === Role.MEDIUM)!;
  assert.ok(medium.alive);
  const snap = buildPlayerSnapshot(s, medium.id);
  assert.ok(snap.you.mediumResults);
  const entry = snap.you.mediumResults!.find((m) => m.targetId === target);
  assert.ok(entry);
  const actual = s.players.find((p) => p.id === target)!;
  assert.equal(entry!.team, actual.role === Role.WEREWOLF ? Team.WEREWOLF : Team.VILLAGE);
});

test('共有者看得到 masonPartnerId + masonChatLog', () => {
  const s = createGameState(13);
  joinAll(s, 13);
  transition(s, { type: 'START_GAME' });
  const masons = s.players.filter((p) => p.role === Role.MASON);
  assert.equal(masons.length, 2);
  toDiscussion(s, masons.map((m) => m.id)); // 保共有者首夜存活
  assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
  const [m1, m2] = masons;
  assert.ok(m1.alive && m2.alive);
  const r = transition(s, { type: 'MASON_CHAT', playerId: m1.id, text: '今晚平安' });
  assert.equal(r.accepted, true);
  const snap = buildPlayerSnapshot(s, m1.id);
  assert.equal(snap.you.masonPartnerId, m2.id);
  assert.equal(snap.you.masonChatLog!.length, 1);
  assert.equal(snap.you.masonChatLog![0].text, '今晚平安');
  // 非共有者看不到
  const outsider = s.players.find((p) => p.role !== Role.MASON && p.alive)!;
  const snapOut = buildPlayerSnapshot(s, outsider.id);
  assert.equal(snapOut.you.masonPartnerId, undefined);
  assert.equal(snapOut.you.masonChatLog, undefined);
});

test('狼看得到 wolfAllyIds（不含自己）', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  const wolves = s.players.filter((p) => p.role === Role.WEREWOLF);
  assert.equal(wolves.length, 2);
  const snap = buildPlayerSnapshot(s, wolves[0].id);
  assert.deepEqual(snap.you.wolfAllyIds, [wolves[1].id]);
});

test('GM snapshot 完整（含 role/team/controlledBy）', () => {
  const s = createGameState(6);
  joinAll(s, 6);
  transition(s, { type: 'START_GAME' });
  convergeWolfDiscussion(s);
  // 構造夜間行動＋夜聊＋死亡，驗證新欄位
  const seer = s.players.find((p) => p.role === Role.SEER)!;
  const guard = s.players.find((p) => p.role === Role.GUARD)!;
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF)!;
  const victim = aliveIds(s).find((id) => s.players.find((p) => p.id === id)!.role === Role.VILLAGER)!;
  for (const pid of getNightActors(s)) {
    const target = pid === wolf.id ? victim : pid === seer.id ? wolf.id : aliveIds(s).filter((id) => id !== pid)[0];
    transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: target });
  }
  const mason = s.players.find((p) => p.role === Role.MASON);
  void mason;
  transition(s, { type: 'RESOLVE_NIGHT' });
  // day1 守衛不可行動（getNightActors 排除 guard），手動補一筆守護＋夜聊驗證透傳
  s.guardProtects.push({ guardId: guard.id, targetId: victim, day: 1 });
  s.masonChatLog.push({ playerId: victim, text: '測試夜聊', day: 1 });
  const gm = buildGMSnapshot(s);
  assert.equal(gm.players.length, 6);
  for (const p of gm.players) {
    assert.ok(p.role);
    assert.ok(p.team);
    assert.ok(p.controlledBy);
  }
  assert.equal(typeof gm.boardVersion, 'number');
  assert.ok('pendingGate' in gm);
  assert.ok('voteReady' in gm);
  assert.deepEqual(gm.takenOver, []);
  assert.deepEqual(gm.idleCounts, {});
  // 新欄位存在且內容正確
  assert.ok(Array.isArray(gm.nightActions));
  const wolfAct = gm.nightActions.find((a) => a.type === NightActionType.WOLF_KILL);
  assert.ok(wolfAct);
  assert.equal(wolfAct.actorId, wolf.id);
  assert.equal(wolfAct.targetId, victim);
  const seerAct = gm.nightActions.find((a) => a.type === NightActionType.SEER_CHECK);
  assert.ok(seerAct);
  assert.equal(seerAct.actorId, seer.id);
  assert.equal(seerAct.targetId, wolf.id);
  assert.ok(gm.seerChecks.length >= 1);
  assert.equal(gm.seerChecks[0].seerId, seer.id);
  assert.equal(gm.seerChecks[0].targetId, wolf.id);
  assert.equal(gm.seerChecks[0].result, Team.WEREWOLF);
  assert.equal(gm.guardProtects.length, 1);
  assert.equal(gm.guardProtects[0].guardId, guard.id);
  assert.equal(gm.masonChatLog.length, 1);
  assert.equal(gm.masonChatLog[0].text, '測試夜聊');
  assert.ok(gm.personalityNames);
  const aiPlayer = s.players.find((p) => p.controlledBy === 'ai')!;
  const expected = personalities.find((p) => p.id === aiPlayer.personality)!;
  assert.equal(gm.personalityNames[aiPlayer.personality], expected.name);
  assert.ok(gm.deadPlayers.some((d) => d.id === victim && d.cause === 'wolf_kill'));
  assert.ok(gm.nightResult && gm.nightResult.includes(`P${victim}`));
  assert.equal(gm.winner, null);
  assert.equal(gm.gameOver, false);
  // flagStats：未傳時 undefined，傳入時透傳
  assert.equal(gm.flagStats, undefined);
  const gmWithFlags = buildGMSnapshot(s, { decided: 2, abstain: 1, uncertain: 3 });
  assert.deepEqual(gmWithFlags.flagStats, { decided: 2, abstain: 1, uncertain: 3 });
});

test('接管標記進快照：you.takenOver＋GM takenOver', () => {
  const s = createGameState(6);
  joinAll(s, 6);
  transition(s, { type: 'START_GAME' });
  toDiscussion(s);
  s.takenOver.push(1);
  assert.equal(buildPlayerSnapshot(s, 1).you.takenOver, true);
  assert.equal(buildPlayerSnapshot(s, 2).you.takenOver, false);
  assert.deepEqual(buildGMSnapshot(s).takenOver, [1]);
});

test('nightResult 由最後一筆 wolf_kill 推導', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  convergeWolfDiscussion(s);
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  const victim = aliveIds(s).find((id) => s.players.find((p) => p.id === id)!.team !== Team.WEREWOLF)!;
  for (const pid of getNightActors(s)) {
    const target = pid === wolf.id ? victim : aliveIds(s).filter((id) => id !== pid)[0];
    transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: target });
  }
  transition(s, { type: 'RESOLVE_NIGHT' });
  const anyAlive = aliveIds(s)[0];
  const snap = buildPlayerSnapshot(s, anyAlive);
  assert.ok(snap.nightResult);
  assert.ok(snap.nightResult!.includes(`P${victim}`));
});

test('觀戰者 snapshot：公開欄位與玩家一致、無 you、無角色洩漏', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  toDiscussion(s);
  const spec = buildSpectatorSnapshot(s);
  assert.ok(!('you' in spec));
  assert.deepEqual(Object.keys(spec).sort(), [
    'alivePlayers', 'day', 'deadPlayers', 'discussionLog',
    'gameOver', 'nightResult', 'phase', 'votes', 'winner',
  ]);
  const dumped = JSON.stringify(spec);
  assert.ok(!dumped.includes('controlledBy'));
  assert.ok(!dumped.includes('"role"'));
  assert.ok(!dumped.includes('"team"'));
  // 公開欄位與玩家 snapshot 一致
  const anyAlive = aliveIds(s)[0];
  const player = buildPlayerSnapshot(s, anyAlive);
  assert.deepEqual(spec.alivePlayers, player.alivePlayers);
  assert.deepEqual(spec.deadPlayers, player.deadPlayers);
  assert.equal(spec.nightResult, player.nightResult);
  assert.deepEqual(spec.discussionLog, player.discussionLog);
  assert.deepEqual(spec.votes, player.votes);
});

test('狼密談快照：狼含 day-filtered you.wolfDiscussionLog；村民無；觀戰者無；GM 含全量', () => {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
  const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive)!;
  transition(s, { type: 'HUMAN_WOLF_SPEAK', playerId: wolf.id, text: '今晚殺P3' });
  const wolfSnap = buildPlayerSnapshot(s, wolf.id);
  assert.ok(wolfSnap.you.wolfDiscussionLog);
  assert.equal(wolfSnap.you.wolfDiscussionLog!.length, 1);
  const villager = s.players.find((p) => p.alive && p.role !== Role.WEREWOLF)!;
  assert.equal(buildPlayerSnapshot(s, villager.id).you.wolfDiscussionLog, undefined);
  const specDumped = JSON.stringify(buildSpectatorSnapshot(s));
  assert.ok(!specDumped.includes('wolfDiscussionLog'));
  const gm = buildGMSnapshot(s) as unknown as { wolfDiscussionLog: { playerId: number; text: string; day: number }[] };
  assert.ok(Array.isArray(gm.wolfDiscussionLog));
  assert.equal(gm.wolfDiscussionLog.length, 1);
});
