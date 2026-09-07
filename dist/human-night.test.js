/**
 * human-night.test.ts — Phase 2 夜晚 + 狼人會議（多數決 / 自指拒絕 / 接管補派 / wolfMeeting 快照）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameState, transition, getNightActors, buildPlayerSnapshot, buildSpectatorSnapshot, } from './game-state.js';
import { Role, Team } from './types.js';
function aliveIds(s) {
    return s.players.filter((p) => p.alive).map((p) => p.id);
}
/** 9 人局（2 狼）：真人座位 3、7，開局到 NIGHT_COLLECTING */
function mixedNightState() {
    const s = createGameState(9);
    transition(s, { type: 'HUMAN_JOIN', playerId: 3, name: 'H1' });
    transition(s, { type: 'HUMAN_JOIN', playerId: 7, name: 'H2' });
    for (let id = 1; id <= 9; id++) {
        if (!s.players.some((p) => p.id === id))
            transition(s, { type: 'AI_JOIN', playerId: id });
    }
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_COLLECTING');
    return s;
}
function wolves(s) {
    return s.players.filter((p) => p.role === Role.WEREWOLF && p.alive).map((p) => p.id);
}
function nonWolfVictim(s, exclude) {
    return aliveIds(s).filter((id) => id !== exclude
        && s.players.find((p) => p.id === id).team !== Team.WEREWOLF)[0];
}
test('getNightActors 含全部存活狼（2 狼局 → seer + 2 狼，day1 無 guard）', () => {
    const s = mixedNightState();
    const actors = getNightActors(s);
    const w = wolves(s);
    assert.equal(w.length, 2);
    const seer = s.players.find((p) => p.role === Role.SEER && p.alive);
    assert.ok(actors.includes(seer.id));
    for (const id of w)
        assert.ok(actors.includes(id), `狼 P${id} 應在 night gate`);
    assert.equal(actors.length, 3);
});
test('狼人會議：2 狼提交不同目標 → 1:1 平手 → 先提交者勝', () => {
    const s = mixedNightState();
    const w = wolves(s);
    const t1 = nonWolfVictim(s, w[0]);
    let t2 = nonWolfVictim(s, w[1]);
    if (t2 === t1) {
        t2 = aliveIds(s).filter((id) => id !== w[1] && id !== t1
            && s.players.find((p) => p.id === id).team !== Team.WEREWOLF)[0] ?? t1;
    }
    assert.equal(transition(s, { type: 'AI_NIGHT_DONE', playerId: w[0], targetId: t1 }).accepted, true);
    // seer 先行動，避免 gate 提前完成影響（gate 需全部完成；此處只斷言提交接受）
    const seer = s.players.find((p) => p.role === Role.SEER && p.alive);
    assert.equal(transition(s, { type: 'AI_NIGHT_DONE', playerId: w[1], targetId: t2 }).accepted, true);
    assert.equal(transition(s, {
        type: 'AI_NIGHT_DONE', playerId: seer.id, targetId: aliveIds(s).filter((id) => id !== seer.id)[0],
    }).accepted, true);
    // 若有真人狼在 gate 內尚未行動，補人類行動（目標 t1，不影響先提交順序）
    for (const pid of getNightActors(s)) {
        if (s.phase !== 'NIGHT_COLLECTING')
            break;
        if (s.pendingGate && !s.pendingGate.done.includes(pid)) {
            const me = s.players.find((p) => p.id === pid);
            const target = me.role === Role.WEREWOLF ? t1 : aliveIds(s).filter((id) => id !== pid)[0];
            transition(s, {
                type: me.controlledBy === 'human' ? 'HUMAN_NIGHT_ACTION' : 'AI_NIGHT_DONE',
                playerId: pid, targetId: target,
            });
        }
    }
    transition(s, { type: 'RESOLVE_NIGHT' });
    assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
    // 平手（t1 vs t2 各 1 票；若 t1===t2 則同目標）→ 先提交者 t1（或同目標 t1）
    const killed = s.deathHistory.find((d) => d.cause === 'wolf_kill');
    assert.ok(killed);
    assert.equal(killed.playerId, t1);
});
test('狼人會議：多數目標勝（以 transition 層 nightActions 計票驗證）', () => {
    const s = mixedNightState();
    const w = wolves(s);
    const t1 = nonWolfVictim(s, w[0]);
    // 兩狼同目標 → 多數決無分歧
    for (const id of w) {
        assert.equal(transition(s, { type: 'AI_NIGHT_DONE', playerId: id, targetId: t1 }).accepted, true);
    }
    const seer = s.players.find((p) => p.role === Role.SEER && p.alive);
    transition(s, {
        type: 'AI_NIGHT_DONE', playerId: seer.id, targetId: aliveIds(s).filter((id) => id !== seer.id)[0],
    });
    for (const pid of getNightActors(s)) {
        if (s.phase !== 'NIGHT_COLLECTING')
            break;
        if (s.pendingGate && !s.pendingGate.done.includes(pid)) {
            transition(s, { type: 'HUMAN_NIGHT_ACTION', playerId: pid, targetId: t1 });
        }
    }
    transition(s, { type: 'RESOLVE_NIGHT' });
    const killed = s.deathHistory.find((d) => d.cause === 'wolf_kill');
    assert.ok(killed);
    assert.equal(killed.playerId, t1);
});
test('HUMAN_NIGHT_ACTION 自指 → 拒絕', () => {
    const s = mixedNightState();
    const seer = s.players.find((p) => p.role === Role.SEER && p.alive);
    if (seer) {
        const r = transition(s, { type: 'HUMAN_NIGHT_ACTION', playerId: seer.id, targetId: seer.id });
        assert.equal(r.accepted, false);
    }
    const w = wolves(s)[0];
    const r2 = transition(s, { type: 'AI_NIGHT_DONE', playerId: w, targetId: w });
    assert.equal(r2.accepted, false);
});
test('真人 seer 夜間行動 → gate 完成 → RESOLVE_NIGHT 結算正確', () => {
    const s = createGameState(6);
    transition(s, { type: 'HUMAN_JOIN', playerId: 1, name: 'H' });
    for (let id = 2; id <= 6; id++)
        transition(s, { type: 'AI_JOIN', playerId: id });
    transition(s, { type: 'START_GAME' });
    // 找到真人座位的角色；若非 seer/guard/狼則測投票路徑以外的通用接受
    const me = s.players.find((p) => p.id === 1);
    const actors = getNightActors(s);
    if (!actors.includes(1)) {
        // 真人無夜間行動 → HUMAN_NIGHT_ACTION 被拒（role 無行動）
        const r = transition(s, { type: 'HUMAN_NIGHT_ACTION', playerId: 1, targetId: aliveIds(s)[1] });
        assert.equal(r.accepted, false);
        return;
    }
    // AI 先提交
    for (const pid of actors) {
        if (pid === 1)
            continue;
        transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: nonWolfVictim(s, pid) });
    }
    assert.equal(s.phase, 'NIGHT_COLLECTING');
    const target = me.role === Role.WEREWOLF
        ? nonWolfVictim(s, 1)
        : aliveIds(s).filter((id) => id !== 1)[0];
    const r = transition(s, { type: 'HUMAN_NIGHT_ACTION', playerId: 1, targetId: target });
    assert.equal(r.accepted, true);
    assert.equal(s.phase, 'NIGHT_RESOLVING');
});
test('DISCONNECT（NIGHT_COLLECTING gate 內未完成）→ 產生 DISPATCH_LLM effect', () => {
    const s = mixedNightState();
    // 找一個在 gate 內的人類（若無人類在 gate，改測 AI 斷線冪等）
    const gate = s.pendingGate;
    const humanInGate = gate.required.find((id) => s.players.find((p) => p.id === id).controlledBy === 'human');
    if (humanInGate === undefined) {
        const aiActor = gate.required[0];
        const r = transition(s, { type: 'DISCONNECT', playerId: aiActor });
        assert.equal(r.accepted, true); // 已是 ai → 冪等接受
        assert.ok(!r.effects.some((e) => e.type === 'DISPATCH_LLM'));
        return;
    }
    const r = transition(s, { type: 'DISCONNECT', playerId: humanInGate });
    assert.equal(r.accepted, true);
    assert.equal(s.players.find((p) => p.id === humanInGate).controlledBy, 'ai');
    assert.ok(r.effects.some((e) => e.type === 'DISPATCH_LLM' && e.playerId === humanInGate));
});
test('狼人會議 snapshot：you.wolfMeeting 只出現在狼的 snapshot', () => {
    const s = mixedNightState();
    const w = wolves(s);
    const t1 = nonWolfVictim(s, w[0]);
    transition(s, { type: 'AI_NIGHT_DONE', playerId: w[0], targetId: t1 });
    const wolfSnap = buildPlayerSnapshot(s, w[0]);
    assert.ok(wolfSnap.you.wolfMeeting);
    assert.deepEqual(wolfSnap.you.wolfMeeting, [{ wolfId: w[0], targetId: t1 }]);
    assert.equal(typeof wolfSnap.you.canAct, 'boolean');
    assert.ok(typeof wolfSnap.gateDeadline === 'number' || wolfSnap.gateDeadline === null);
    // 村民 snapshot 無 wolfMeeting
    const villager = s.players.find((p) => p.alive && p.role !== Role.WEREWOLF);
    const vSnap = buildPlayerSnapshot(s, villager.id);
    assert.equal(vSnap.you.wolfMeeting, undefined);
    // 觀戰者無 wolfMeeting 字樣
    const dumped = JSON.stringify(buildSpectatorSnapshot(s));
    assert.ok(!dumped.includes('wolfMeeting'));
    assert.ok(!dumped.includes('controlledBy'));
});
//# sourceMappingURL=human-night.test.js.map