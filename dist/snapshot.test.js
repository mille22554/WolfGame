/**
 * snapshot.test.ts — per-client 資訊過濾測試
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameState, transition, buildPlayerSnapshot, buildGMSnapshot, getNightActors } from './game-state.js';
import { Role, Team } from './types.js';
function joinAll(state, count) {
    for (let i = 0; i < count; i++)
        transition(state, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
}
function aliveIds(s) {
    return s.players.filter((p) => p.alive).map((p) => p.id);
}
function toDiscussion(s, keep = []) {
    for (const pid of getNightActors(s)) {
        const me = s.players.find((p) => p.id === pid);
        let pool = aliveIds(s).filter((id) => id !== pid && !keep.includes(id));
        if (me.role === Role.WEREWOLF) {
            pool = pool.filter((id) => s.players.find((p) => p.id === id).team !== Team.WEREWOLF);
        }
        if (pool.length === 0)
            pool = aliveIds(s).filter((id) => id !== pid);
        transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: pool[0] });
    }
    transition(s, { type: 'RESOLVE_NIGHT' });
}
test('村民看不到任何 role/team/controlledBy', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    toDiscussion(s);
    const villager = s.players.find((p) => p.role === Role.VILLAGER && p.alive);
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
    const seer = s.players.find((p) => p.role === Role.SEER);
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    for (const pid of getNightActors(s)) {
        const target = pid === seer.id ? wolf.id : aliveIds(s).filter((id) => id !== pid)[0];
        transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: target });
    }
    transition(s, { type: 'RESOLVE_NIGHT' });
    const snap = buildPlayerSnapshot(s, seer.id);
    assert.ok(snap.you.seerChecks);
    assert.equal(snap.you.seerChecks.length, 1);
    assert.equal(snap.you.seerChecks[0].targetId, wolf.id);
    assert.equal(snap.you.seerChecks[0].result, Team.WEREWOLF);
    // 非 seer 看不到
    const villager = s.players.find((p) => p.role === Role.VILLAGER && p.alive);
    assert.equal(buildPlayerSnapshot(s, villager.id).you.seerChecks, undefined);
});
test('guard 看得到自己的 guardProtects', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    const guard = s.players.find((p) => p.role === Role.GUARD);
    // 保守衛首夜存活，推進到 day2（guard day1 不可行動）
    toDiscussion(s, [guard.id]);
    transition(s, { type: 'CLOSE_DISCUSSION' }); // 全 AI → 直接 VOTING
    const voters = [...s.pendingGate.required];
    const voteTarget = voters.find((id) => id !== guard.id);
    for (const voter of voters) {
        transition(s, { type: 'AI_VOTE_DONE', playerId: voter, targetId: voter === voteTarget ? voters.find((id) => id !== voteTarget) : voteTarget });
    }
    transition(s, { type: 'RESOLVE_VOTES' });
    transition(s, { type: 'ADVANCE_DAY' });
    assert.equal(s.day, 2);
    assert.ok(guard.alive);
    const actors = getNightActors(s);
    assert.ok(actors.includes(guard.id));
    for (const pid of actors) {
        const me = s.players.find((p) => p.id === pid);
        let pool = aliveIds(s).filter((id) => id !== pid && id !== guard.id);
        if (me.role === Role.WEREWOLF) {
            pool = pool.filter((id) => s.players.find((p) => p.id === id).team !== Team.WEREWOLF);
        }
        transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: pool[0] });
    }
    transition(s, { type: 'RESOLVE_NIGHT' });
    const snap = buildPlayerSnapshot(s, guard.id);
    assert.ok(snap.you.guardProtects);
    assert.equal(snap.you.guardProtects.length, 1);
});
test('medium 的 mediumResults 由 deathHistory 推導', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    const mediumEarly = s.players.find((p) => p.role === Role.MEDIUM);
    toDiscussion(s, [mediumEarly.id]); // 保靈能者首夜存活
    transition(s, { type: 'CLOSE_DISCUSSION' });
    const voters = [...s.pendingGate.required];
    const target = voters[0];
    for (const voter of voters) {
        transition(s, { type: 'AI_VOTE_DONE', playerId: voter, targetId: voter === target ? voters[1] : target });
    }
    transition(s, { type: 'RESOLVE_VOTES' });
    const medium = s.players.find((p) => p.role === Role.MEDIUM);
    assert.ok(medium.alive);
    const snap = buildPlayerSnapshot(s, medium.id);
    assert.ok(snap.you.mediumResults);
    const entry = snap.you.mediumResults.find((m) => m.targetId === target);
    assert.ok(entry);
    const actual = s.players.find((p) => p.id === target);
    assert.equal(entry.team, actual.role === Role.WEREWOLF ? Team.WEREWOLF : Team.VILLAGE);
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
    assert.equal(snap.you.masonChatLog.length, 1);
    assert.equal(snap.you.masonChatLog[0].text, '今晚平安');
    // 非共有者看不到
    const outsider = s.players.find((p) => p.role !== Role.MASON && p.alive);
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
});
test('nightResult 由最後一筆 wolf_kill 推導', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    const victim = aliveIds(s).find((id) => s.players.find((p) => p.id === id).team !== Team.WEREWOLF);
    for (const pid of getNightActors(s)) {
        const target = pid === wolf.id ? victim : aliveIds(s).filter((id) => id !== pid)[0];
        transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: target });
    }
    transition(s, { type: 'RESOLVE_NIGHT' });
    const anyAlive = aliveIds(s)[0];
    const snap = buildPlayerSnapshot(s, anyAlive);
    assert.ok(snap.nightResult);
    assert.ok(snap.nightResult.includes(`P${victim}`));
});
//# sourceMappingURL=snapshot.test.js.map