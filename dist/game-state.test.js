/**
 * game-state.test.ts — 轉移表全路徑測試（node:test + node:assert）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { createGameState, transition, getNightActors, saveState, loadState, } from './game-state.js';
import { Role, Team, SCHEMA_VERSION } from './types.js';
// ---------- helpers ----------
function joinAll(state, count) {
    for (let i = 0; i < count; i++) {
        const r = transition(state, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
        assert.equal(r.accepted, true);
    }
}
function joinedState(count = 9, humans = []) {
    const s = createGameState(count, humans);
    joinAll(s, count);
    return s;
}
function startedState(count = 9, humans = []) {
    const s = joinedState(count, humans);
    const r = transition(s, { type: 'START_GAME' });
    assert.equal(r.accepted, true);
    return s;
}
function aliveIds(s) {
    return s.players.filter((p) => p.alive).map((p) => p.id);
}
function completeNight(s, targetForWolf) {
    const actors = getNightActors(s);
    for (const pid of actors) {
        const me = s.players.find((p) => p.id === pid);
        let target = aliveIds(s).filter((id) => id !== pid);
        if (me.role === Role.WEREWOLF && targetForWolf !== undefined) {
            target = [targetForWolf];
        }
        const r = transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: target[0] });
        assert.equal(r.accepted, true);
    }
    const r = transition(s, { type: 'RESOLVE_NIGHT' });
    assert.equal(r.accepted, true);
}
function toDiscussion(s) {
    completeNight(s);
    assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
}
/** 確定性守夜：狼殺指定 keep 之外的最低存活非狼；keep 內玩家保證存活 */
function nightKeeping(s, keep = []) {
    for (const pid of getNightActors(s)) {
        const me = s.players.find((p) => p.id === pid);
        let pool = aliveIds(s).filter((id) => id !== pid && !keep.includes(id));
        if (me.role === Role.WEREWOLF) {
            pool = pool.filter((id) => s.players.find((p) => p.id === id).team !== Team.WEREWOLF);
        }
        if (pool.length === 0)
            pool = aliveIds(s).filter((id) => id !== pid);
        const r = transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: pool[0] });
        assert.equal(r.accepted, true);
    }
    const r = transition(s, { type: 'RESOLVE_NIGHT' });
    assert.equal(r.accepted, true);
}
function toVotingAllAI(s) {
    toDiscussion(s);
    const r = transition(s, { type: 'CLOSE_DISCUSSION' });
    assert.equal(r.accepted, true);
    assert.equal(s.phase, 'DAY_VOTING_COLLECTING');
}
// ---------- SETUP ----------
test('SETUP_WAITING_JOIN：CLIENT_JOIN 加入、人數達標 → SETUP_READY', () => {
    const s = createGameState(6);
    assert.equal(s.phase, 'SETUP_WAITING_JOIN');
    for (let i = 0; i < 5; i++) {
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
        assert.equal(s.phase, 'SETUP_WAITING_JOIN');
    }
    assert.equal(s.players.length, 5);
    transition(s, { type: 'CLIENT_JOIN', name: 'P6' });
    assert.equal(s.phase, 'SETUP_READY');
    assert.equal(s.players.length, 6);
    // 佔位：全 VILLAGER
    assert.ok(s.players.every((p) => p.role === Role.VILLAGER));
});
test('SETUP_WAITING_JOIN：START_GAME 被拒絕（人數不足）', () => {
    const s = createGameState(6);
    joinAll(s, 3);
    const r = transition(s, { type: 'START_GAME' });
    assert.equal(r.accepted, false);
    assert.equal(s.phase, 'SETUP_WAITING_JOIN');
});
test('SETUP_READY：START_GAME → 角色分配 + NIGHT_COLLECTING + boardVersion++', () => {
    const s = joinedState(9);
    assert.equal(s.phase, 'SETUP_READY');
    const bv0 = s.boardVersion;
    const r = transition(s, { type: 'START_GAME' });
    assert.equal(r.accepted, true);
    assert.equal(s.phase, 'NIGHT_COLLECTING');
    assert.equal(s.day, 1);
    assert.equal(s.boardVersion, bv0 + 1);
    // 角色已分配（不再全是村民），9 人局應有 2 狼
    const wolves = s.players.filter((p) => p.role === Role.WEREWOLF);
    assert.equal(wolves.length, 2);
    // night gate 已開，deadline 為 0（timer 由 engine 設定）
    assert.ok(s.pendingGate);
    assert.equal(s.pendingGate.kind, 'night');
    assert.equal(s.pendingGate.deadline, 0);
    assert.deepEqual([...s.pendingGate.required].sort(), [...getNightActors(s)].sort());
    // effects 含 ARM_GATE + 對應 DISPATCH_LLM
    assert.ok(r.effects.some((e) => e.type === 'ARM_GATE'));
    const dispatches = r.effects.filter((e) => e.type === 'DISPATCH_LLM');
    assert.equal(dispatches.length, s.pendingGate.required.length);
});
// ---------- NIGHT ----------
test('NIGHT_COLLECTING：gate 完成 → NIGHT_RESOLVING + ENQUEUE RESOLVE_NIGHT', () => {
    const s = startedState(6);
    const actors = getNightActors(s);
    assert.ok(actors.length >= 2); // seer + wolf（day1 無 guard）
    for (let i = 0; i < actors.length - 1; i++) {
        const r = transition(s, { type: 'AI_NIGHT_DONE', playerId: actors[i], targetId: aliveIds(s).filter((id) => id !== actors[i])[0] });
        assert.equal(r.accepted, true);
        assert.equal(s.phase, 'NIGHT_COLLECTING');
    }
    const last = transition(s, {
        type: 'AI_NIGHT_DONE',
        playerId: actors[actors.length - 1],
        targetId: aliveIds(s).filter((id) => id !== actors[actors.length - 1])[0],
    });
    assert.equal(last.accepted, true);
    assert.equal(s.phase, 'NIGHT_RESOLVING');
    assert.ok(last.effects.some((e) => e.type === 'ENQUEUE' && e.event.type === 'RESOLVE_NIGHT'));
});
test('NIGHT_COLLECTING：ACTION_TIMEOUT → NIGHT_RESOLVING', () => {
    const s = startedState(6);
    const r = transition(s, { type: 'ACTION_TIMEOUT', gateId: 'night-1' });
    assert.equal(r.accepted, true);
    assert.equal(s.phase, 'NIGHT_RESOLVING');
});
test('NIGHT_COLLECTING：無夜間行動角色被拒絕', () => {
    const s = startedState(9);
    const villager = s.players.find((p) => p.role === Role.VILLAGER && p.alive);
    const r = transition(s, { type: 'HUMAN_NIGHT_ACTION', playerId: villager.id, targetId: aliveIds(s).filter((id) => id !== villager.id)[0] });
    assert.equal(r.accepted, false);
});
test('NIGHT_RESOLVING：RESOLVE_NIGHT → 死亡套用 + DAY_DISCUSSION_OPEN + boardVersion++', () => {
    const s = startedState(9);
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    const victimId = aliveIds(s).find((id) => {
        const p = s.players.find((x) => x.id === id);
        return p.team !== 'werewolf';
    });
    const bv0 = s.boardVersion;
    completeNight(s, victimId);
    void wolf;
    assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
    assert.equal(s.boardVersion, bv0 + 1);
    const victim = s.players.find((p) => p.id === victimId);
    assert.equal(victim.alive, false);
    assert.ok(s.deathHistory.some((d) => d.playerId === victimId && d.cause === 'wolf_kill'));
});
// ---------- DISCUSSION ----------
test('DAY_DISCUSSION_OPEN：HUMAN_SPEAK 進 log + boardVersion++', () => {
    const s = startedState(6, [0]);
    toDiscussion(s);
    const bv0 = s.boardVersion;
    const speaker = aliveIds(s)[0];
    const r = transition(s, { type: 'HUMAN_SPEAK', playerId: speaker, text: '大家好' });
    assert.equal(r.accepted, true);
    assert.equal(s.discussionLog.length, 1);
    assert.equal(s.discussionLog[0].text, '大家好');
    assert.equal(s.boardVersion, bv0 + 1);
});
test('DAY_DISCUSSION_OPEN：AI_SPEECH_DONE 版本相符接受、版本不符丟棄', () => {
    const s = startedState(6);
    toDiscussion(s);
    const speaker = aliveIds(s)[0];
    const bv = s.boardVersion;
    const ok = transition(s, { type: 'AI_SPEECH_DONE', playerId: speaker, text: '發言A', boardVersion: bv });
    assert.equal(ok.accepted, true);
    assert.equal(s.discussionLog.length, 1);
    // 白板已推進，舊版本作廢
    const stale = transition(s, { type: 'AI_SPEECH_DONE', playerId: speaker, text: '過期發言', boardVersion: bv });
    assert.equal(stale.accepted, false);
    assert.equal(stale.reason, 'stale boardVersion');
    assert.equal(s.discussionLog.length, 1);
});
test('boardVersion 不觸發點：JOIN / SKIP / READY / MASON_CHAT', () => {
    const s = createGameState(6);
    transition(s, { type: 'CLIENT_JOIN', name: 'P1' });
    assert.equal(s.boardVersion, 0);
    const s2 = startedState(6, [0, 1]);
    toDiscussion(s2);
    const bv = s2.boardVersion;
    transition(s2, { type: 'HUMAN_SKIP', playerId: aliveIds(s2)[0] });
    assert.equal(s2.boardVersion, bv);
    transition(s2, { type: 'CLOSE_DISCUSSION' });
    assert.equal(s2.phase, 'DAY_DISCUSSION_CLOSING');
    transition(s2, { type: 'HUMAN_READY_VOTE', playerId: 1 });
    assert.equal(s2.boardVersion, bv);
});
// ---------- CLOSING ----------
test('DAY_DISCUSSION_CLOSING：voteReady 增減；全 ready → DAY_VOTING_COLLECTING', () => {
    const s = startedState(6, [0, 1]);
    nightKeeping(s, [1, 2]); // 保兩真人存活，確定性雙人路徑
    assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
    transition(s, { type: 'CLOSE_DISCUSSION' });
    assert.equal(s.phase, 'DAY_DISCUSSION_CLOSING');
    const humans = s.players.filter((p) => p.alive && p.controlledBy === 'human').map((p) => p.id);
    assert.ok(humans.length >= 1); // 狼首夜至多殺一人，至少一真人生還
    if (humans.length >= 2) {
        transition(s, { type: 'HUMAN_READY_VOTE', playerId: humans[0] });
        assert.equal(s.phase, 'DAY_DISCUSSION_CLOSING');
        transition(s, { type: 'HUMAN_UNREADY_VOTE', playerId: humans[0] });
        assert.ok(!s.voteReady.includes(humans[0]));
        transition(s, { type: 'HUMAN_READY_VOTE', playerId: humans[0] });
        const r = transition(s, { type: 'HUMAN_READY_VOTE', playerId: humans[1] });
        assert.equal(r.accepted, true);
        assert.equal(s.phase, 'DAY_VOTING_COLLECTING');
        assert.ok(s.pendingGate);
        assert.equal(s.pendingGate.kind, 'vote');
        assert.ok(r.effects.some((e) => e.type === 'ARM_GATE'));
    }
    else {
        const r = transition(s, { type: 'HUMAN_READY_VOTE', playerId: humans[0] });
        assert.equal(r.accepted, true);
        assert.equal(s.phase, 'DAY_VOTING_COLLECTING');
        assert.ok(s.pendingGate);
        assert.equal(s.pendingGate.kind, 'vote');
    }
});
test('DAY_DISCUSSION_CLOSING：HUMAN_SKIP 視同準備投票', () => {
    const s = startedState(6, [0]);
    nightKeeping(s, [1]); // 保唯一真人存活
    assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
    transition(s, { type: 'CLOSE_DISCUSSION' });
    const humans = s.players.filter((p) => p.alive && p.controlledBy === 'human').map((p) => p.id);
    assert.equal(humans.length, 1);
    transition(s, { type: 'HUMAN_SKIP', playerId: humans[0] });
    assert.equal(s.phase, 'DAY_VOTING_COLLECTING');
});
// ---------- VOTING ----------
test('DAY_VOTING_COLLECTING：gate 完成 → DAY_VOTING_RESOLVING；平票 → 無人出局', () => {
    const s = startedState(9);
    toVotingAllAI(s);
    const voters = [...s.pendingGate.required];
    assert.ok(voters.length >= 5);
    const [x, y, z] = voters;
    const k = Math.floor(voters.length / 2);
    voters.forEach((voter, i) => {
        const target = i < k ? x : i < 2 * k ? y : z;
        const r = transition(s, { type: 'AI_VOTE_DONE', playerId: voter, targetId: target });
        assert.equal(r.accepted, true);
    });
    assert.equal(s.phase, 'DAY_VOTING_RESOLVING');
    const deathsBefore = s.deathHistory.length;
    const r = transition(s, { type: 'RESOLVE_VOTES' });
    assert.equal(r.accepted, true);
    // 平票：無新增死亡，進 ANNOUNCING
    assert.equal(s.deathHistory.length, deathsBefore);
    assert.equal(s.phase, 'DAY_RESULT_ANNOUNCING');
});
test('DAY_VOTING_COLLECTING：ACTION_TIMEOUT 未投票者視為棄權', () => {
    const s = startedState(6);
    toVotingAllAI(s);
    const r = transition(s, { type: 'ACTION_TIMEOUT', gateId: 'vote-1' });
    assert.equal(r.accepted, true);
    assert.equal(s.phase, 'DAY_VOTING_RESOLVING');
});
test('DAY_VOTING_RESOLVING：RESOLVE_VOTES → 最高票出局 + DAY_RESULT_ANNOUNCING', () => {
    const s = startedState(9);
    toVotingAllAI(s);
    const voters = [...s.pendingGate.required];
    const target = voters[0];
    const bv0 = s.boardVersion;
    for (const voter of voters) {
        transition(s, { type: 'AI_VOTE_DONE', playerId: voter, targetId: voter === target ? voters[1] : target });
    }
    assert.equal(s.phase, 'DAY_VOTING_RESOLVING');
    transition(s, { type: 'RESOLVE_VOTES' });
    assert.equal(s.boardVersion, bv0 + 1);
    const out = s.players.find((p) => p.id === target);
    assert.equal(out.alive, false);
    assert.ok(s.deathHistory.some((d) => d.playerId === target && d.cause === 'vote'));
    assert.equal(s.phase, 'DAY_RESULT_ANNOUNCING');
});
// ---------- ANNOUNCING / ADVANCE ----------
test('DAY_RESULT_ANNOUNCING：ADVANCE_DAY → daySummary + NIGHT_COLLECTING', () => {
    const s = startedState(6);
    toVotingAllAI(s);
    const voters = [...s.pendingGate.required];
    // 硬化（flake 修復）：鎖定非狼為票死目標，避免洗牌使首日票死最後一狼而直接結束
    // （原寫 voters[0] 在狼為最低存活 id 時觸發 GAME_OVER；斷言意圖不變）
    const target = voters.find((v) => s.players.find((p) => p.id === v).role !== Role.WEREWOLF) ?? voters[0];
    for (const voter of voters) {
        transition(s, { type: 'AI_VOTE_DONE', playerId: voter, targetId: voter === target ? voters[0] === target ? voters[1] : voters[0] : target });
    }
    transition(s, { type: 'RESOLVE_VOTES' });
    assert.equal(s.phase, 'DAY_RESULT_ANNOUNCING');
    const day0 = s.day;
    const bv0 = s.boardVersion;
    const r = transition(s, { type: 'ADVANCE_DAY' });
    assert.equal(r.accepted, true);
    assert.equal(s.day, day0 + 1);
    assert.equal(s.phase, 'NIGHT_COLLECTING');
    assert.equal(s.daySummaries.length, 1);
    assert.equal(s.boardVersion, bv0 + 1);
    assert.ok(s.pendingGate);
    assert.equal(s.pendingGate.kind, 'night');
    assert.deepEqual(s.voteReady, []);
});
// ---------- GAME OVER ----------
test('GAME_OVER_FINAL：全部事件被忽略', () => {
    const s = startedState(6);
    s.phase = 'GAME_OVER_FINAL';
    s.gameOver = true;
    for (const ev of [
        { type: 'CLOSE_DISCUSSION' },
        { type: 'ADVANCE_DAY' },
        { type: 'ACTION_TIMEOUT', gateId: 'x' },
    ]) {
        const r = transition(s, ev);
        assert.equal(r.accepted, false);
    }
});
// ---------- 持久化 ----------
test('saveState / loadState：原子寫入 + schemaVersion 檢查', () => {
    const file = path.join(process.cwd(), 'game-state.json');
    const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    try {
        const s = startedState(6);
        saveState(s);
        assert.ok(fs.existsSync(file));
        assert.ok(!fs.existsSync(`${file}.tmp`));
        const loaded = loadState();
        assert.ok(loaded);
        assert.equal(loaded.schemaVersion, SCHEMA_VERSION);
        assert.equal(loaded.players.length, 6);
        // schemaVersion 不符 → null
        const bad = { ...loaded, schemaVersion: 999 };
        fs.writeFileSync(file, JSON.stringify(bad));
        assert.equal(loadState(), null);
    }
    finally {
        if (backup !== null)
            fs.writeFileSync(file, backup);
        else if (fs.existsSync(file))
            fs.unlinkSync(file);
    }
});
//# sourceMappingURL=game-state.test.js.map