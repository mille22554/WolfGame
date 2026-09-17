/**
 * game-wolf.test.ts — 狼會議狀態機測試（stage 2，連續對話制）
 *
 * 用假 callbacks（mock AI 控制器掛鉤）+ 手動呼叫 handler 驗證（不真呼叫 LLM）：
 * - 3 狼 2:1 → 明確多數收斂（wolfTargetId 設定、推進下一步、無 WOLF_VOTE_SPLIT）
 * - 1:1:1 平票 → 回 DISCUSSION（round+1、ready 重置、broadcast WOLF_VOTE_SPLIT）→ 再投 2:1 收斂
 * - 非法行動被忽略：DISCUSSION 期間的 WOLF_KILL、刀狂人、非 WOLF step 的 SEER_CHECK
 * - WOLF_CHAT 只在 WOLF step 計數（MASON step 的訊息不計）
 * - 白板累計 100 則未收斂 → 停止並 broadcast WOLF_MEETING_ABORTED（不自動收斂、後續訊息／toggle 被忽略）
 * - onWolfSubphaseChange 回呼：DISCUSSION(round 1) → VOTING → 平票 → DISCUSSION(round 2)
 *
 * 跑法：node --test dist/lobby-server/game-wolf.test.js（不在 npm test 內，要手動跑）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Role } from '../types.js';
import { GameEngine } from './game.js';
/** 假 callbacks：記錄所有 sendTo / broadcast / onWolfSubphaseChange（mock AI 控制器掛鉤） */
function makeHarness() {
    const cap = { sendTo: [], broadcast: [], wolfSubphaseChanges: [] };
    const callbacks = {
        sendTo: (clientId, msg) => { cap.sendTo.push({ clientId, msg }); },
        broadcast: (msg, targets) => { cap.broadcast.push({ msg, targets }); },
        onWolfSubphaseChange: (subphase, round) => { cap.wolfSubphaseChanges.push({ subphase, round }); },
    };
    return { cap, callbacks };
}
/** 建 15 人引擎、開局後直接跳進 NIGHT（不等 ROLE_REVEAL 的 10s timer） */
function makeNightGame() {
    const { cap, callbacks } = makeHarness();
    const players = Array.from({ length: 15 }, (_, i) => ({ clientId: `p${i}`, nickname: `N${i}` }));
    // wolfMessageCap=100：e95f5d6 後預設 0=停用，本測試要測上限行為需明確開啟
    const game = new GameEngine('TEST', players, callbacks, 100);
    game.start();
    // 手動推進到 NIGHT（start 已分配角色；pending 的 ROLE_REVEAL timer 由 destroy 清除）
    game.transitionTo('NIGHT');
    return { game, cap };
}
function roleOf(game, role) {
    return game.getPlayers().filter((p) => p.role === role);
}
function broadcastsWithType(cap, type) {
    return cap.broadcast.filter((b) => b.msg.type === type).map((b) => b.msg);
}
test('狼會議：3 狼 2:1 → 明確多數收斂（無 WOLF_VOTE_SPLIT）', () => {
    const { game, cap } = makeNightGame();
    try {
        const wolves = roleOf(game, Role.WEREWOLF);
        const masons = roleOf(game, Role.MASON);
        const seer = roleOf(game, Role.SEER)[0];
        assert.equal(wolves.length, 3);
        const villagers = roleOf(game, Role.VILLAGER);
        const target = villagers[0];
        const other = villagers[1];
        // MASON step：雙共有者 toggle ON → 推進到 WOLF
        for (const m of masons)
            game.handleToggleMasonEndTurn(m.clientId);
        assert.equal(game.getNightState().nightStep, 'WOLF');
        assert.equal(broadcastsWithType(cap, 'MASON_READY').length, 2);
        // WOLF step：DISCUSSION → 全狼 toggle ready → VOTING
        assert.equal(game.getNightState().wolfSubphase, 'DISCUSSION');
        for (const w of wolves)
            game.handleToggleWolfReady(w.clientId);
        assert.equal(game.getNightState().wolfSubphase, 'VOTING');
        assert.equal(broadcastsWithType(cap, 'WOLF_READY').length, 3);
        // 投票 2:1 → 收斂
        game.handleNightAction(wolves[0].clientId, { type: 'WOLF_KILL', targetClientId: target.clientId });
        game.handleNightAction(wolves[1].clientId, { type: 'WOLF_KILL', targetClientId: target.clientId });
        game.handleNightAction(wolves[2].clientId, { type: 'WOLF_KILL', targetClientId: other.clientId });
        const state = game.getNightState();
        assert.equal(state.wolfTargetId, target.clientId, '應收斂到 2 票的目標');
        assert.equal(state.nightStep, 'SEER', 'WOLF 完成後應推進到 SEER');
        assert.equal(broadcastsWithType(cap, 'WOLF_VOTE_SPLIT').length, 0, '明確多數不應有平票事件');
        // SEER 提交 → 夜間結算：目標死亡
        game.handleNightAction(seer.clientId, { type: 'SEER_CHECK', targetClientId: wolves[0].clientId });
        assert.equal(game.getPlayers().find((p) => p.clientId === target.clientId)?.alive, false);
        assert.equal(game.getNightState().phase, 'NIGHT_RESULT');
    }
    finally {
        game.destroy();
    }
});
test('狼會議：1:1:1 平票 → 回討論（round+1、ready 重置）→ 再投 2:1 收斂', () => {
    const { game, cap } = makeNightGame();
    try {
        const wolves = roleOf(game, Role.WEREWOLF);
        const masons = roleOf(game, Role.MASON);
        const villagers = roleOf(game, Role.VILLAGER);
        const [t1, t2, t3] = villagers;
        for (const m of masons)
            game.handleToggleMasonEndTurn(m.clientId);
        for (const w of wolves)
            game.handleToggleWolfReady(w.clientId);
        assert.equal(game.getNightState().wolfSubphase, 'VOTING');
        // 1:1:1 平票
        game.handleNightAction(wolves[0].clientId, { type: 'WOLF_KILL', targetClientId: t1.clientId });
        game.handleNightAction(wolves[1].clientId, { type: 'WOLF_KILL', targetClientId: t2.clientId });
        game.handleNightAction(wolves[2].clientId, { type: 'WOLF_KILL', targetClientId: t3.clientId });
        const afterSplit = game.getNightState();
        assert.equal(afterSplit.wolfSubphase, 'DISCUSSION', '平票應回討論');
        assert.equal(afterSplit.wolfMeetingRound, 2, 'round 應 +1');
        assert.equal(afterSplit.wolfTargetId, null, '平票不可決定狼刀（不用先提交者/隨機）');
        const splits = broadcastsWithType(cap, 'WOLF_VOTE_SPLIT');
        assert.equal(splits.length, 1, '應 broadcast WOLF_VOTE_SPLIT');
        assert.deepEqual(Object.fromEntries(Object.entries(splits[0].votes).map(([k, v]) => [game.getPlayers().find((p) => p.clientId === k)?.nickname, v])), { [t1.nickname]: 1, [t2.nickname]: 1, [t3.nickname]: 1 });
        // ready 已重置：重新 toggle 應回 ON（若未重置，toggle 會變 OFF）
        for (const w of wolves)
            game.handleToggleWolfReady(w.clientId);
        const readyAfterRetoggle = broadcastsWithType(cap, 'WOLF_READY').filter((m) => m.clientId === wolves[0].clientId);
        assert.equal(readyAfterRetoggle[readyAfterRetoggle.length - 1].ready, true, 'wolfReady 應已重置為 OFF（再 toggle → ON）');
        assert.equal(game.getNightState().wolfSubphase, 'VOTING');
        // 第二回合 2:1 → 收斂
        game.handleNightAction(wolves[0].clientId, { type: 'WOLF_KILL', targetClientId: t1.clientId });
        game.handleNightAction(wolves[1].clientId, { type: 'WOLF_KILL', targetClientId: t1.clientId });
        game.handleNightAction(wolves[2].clientId, { type: 'WOLF_KILL', targetClientId: t2.clientId });
        assert.equal(game.getNightState().wolfTargetId, t1.clientId);
        assert.equal(game.getNightState().wolfMeetingRound, 2);
    }
    finally {
        game.destroy();
    }
});
test('狼會議：非法行動被忽略（DISCUSSION 期投票、刀狂人、非 WOLF step 的 SEER）', () => {
    const { game, cap } = makeNightGame();
    try {
        const wolves = roleOf(game, Role.WEREWOLF);
        const masons = roleOf(game, Role.MASON);
        const seer = roleOf(game, Role.SEER)[0];
        const madman = roleOf(game, Role.MADMAN)[0];
        const villager = roleOf(game, Role.VILLAGER)[0];
        for (const m of masons)
            game.handleToggleMasonEndTurn(m.clientId);
        assert.equal(game.getNightState().wolfSubphase, 'DISCUSSION');
        // DISCUSSION 期間的 WOLF_KILL → 忽略（未進 VOTING）
        game.handleNightAction(wolves[0].clientId, { type: 'WOLF_KILL', targetClientId: villager.clientId });
        assert.equal(game.getNightState().wolfSubphase, 'DISCUSSION', 'DISCUSSION 期間投票應被忽略');
        // 刀狂人 → 忽略（該狼視為未投票 → 不收斂；若被誤收會 2:1 收斂，可用 wolfTargetId 區分）
        game.handleToggleWolfReady(wolves[0].clientId);
        game.handleToggleWolfReady(wolves[1].clientId);
        game.handleToggleWolfReady(wolves[2].clientId);
        assert.equal(game.getNightState().wolfSubphase, 'VOTING');
        game.handleNightAction(wolves[0].clientId, { type: 'WOLF_KILL', targetClientId: madman.clientId });
        game.handleNightAction(wolves[1].clientId, { type: 'WOLF_KILL', targetClientId: villager.clientId });
        game.handleNightAction(wolves[2].clientId, { type: 'WOLF_KILL', targetClientId: villager.clientId });
        assert.equal(game.getNightState().wolfTargetId, null, '刀狂人被忽略 → 該狼未投票 → 不收斂');
        // 該狼補投村民 → 3:0 收斂
        game.handleNightAction(wolves[0].clientId, { type: 'WOLF_KILL', targetClientId: villager.clientId });
        assert.equal(game.getNightState().wolfTargetId, villager.clientId, '補票後應收斂');
        // 非 WOLF step 的行動 → 忽略（收斂後 step 已推進到 SEER；GUARD 不在本夜 steps）
        assert.equal(game.getNightState().nightStep, 'SEER');
        const before = cap.broadcast.length;
        game.handleNightAction(roleOf(game, Role.GUARD)[0].clientId, { type: 'GUARD_PROTECT', targetClientId: villager.clientId });
        assert.equal(cap.broadcast.length, before, '非對應 step 的夜間行動應被忽略（不觸發結算 broadcast）');
    }
    finally {
        game.destroy();
    }
});
test('狼會議：WOLF_CHAT 只在 WOLF step 計數（MASON step 的訊息不計入白板）', () => {
    const { game } = makeNightGame();
    try {
        const wolves = roleOf(game, Role.WEREWOLF);
        const masons = roleOf(game, Role.MASON);
        // 開局後第一個 step 是 MASON（Day1 無 GUARD）：此時狼發言不計數
        assert.equal(game.getNightState().nightStep, 'MASON');
        game.handleWolfChat(wolves[0].clientId, 'mason step 的訊息');
        assert.equal(game.getNightState().wolfMessageCount, 0, '非 WOLF step 的 WOLF_CHAT 應被忽略');
        // 推進到 WOLF step 後才計數
        for (const m of masons)
            game.handleToggleMasonEndTurn(m.clientId);
        assert.equal(game.getNightState().nightStep, 'WOLF');
        game.handleWolfChat(wolves[0].clientId, 'wolf step 的訊息');
        assert.equal(game.getNightState().wolfMessageCount, 1);
    }
    finally {
        game.destroy();
    }
});
test('狼會議：白板累計 100 則未收斂 → 停止並報告（不自動收斂、後續訊息／toggle 被忽略）', () => {
    const { game, cap } = makeNightGame();
    try {
        const wolves = roleOf(game, Role.WEREWOLF);
        const masons = roleOf(game, Role.MASON);
        for (const m of masons)
            game.handleToggleMasonEndTurn(m.clientId);
        assert.equal(game.getNightState().wolfSubphase, 'DISCUSSION');
        // 灌 100 則訊息（未收斂）
        for (let i = 0; i < 100; i++)
            game.handleWolfChat(wolves[0].clientId, `msg ${i}`);
        const state = game.getNightState();
        assert.equal(state.wolfMessageCount, 100);
        assert.equal(state.wolfMeetingAborted, true, '第 100 則應觸發停止');
        const aborts = broadcastsWithType(cap, 'WOLF_MEETING_ABORTED');
        assert.equal(aborts.length, 1, '應 broadcast 一次 WOLF_MEETING_ABORTED');
        assert.equal(aborts[0].count, 100);
        // 停止後：新訊息被忽略（計數不變、不再 broadcast）
        game.handleWolfChat(wolves[1].clientId, 'abort 之後的訊息');
        assert.equal(game.getNightState().wolfMessageCount, 100);
        assert.equal(broadcastsWithType(cap, 'WOLF_MESSAGE').length, 100);
        // 停止後：toggle 被忽略（不進 VOTING）、不自動收斂
        for (const w of wolves)
            game.handleToggleWolfReady(w.clientId);
        assert.equal(game.getNightState().wolfSubphase, 'DISCUSSION', 'abort 後 toggle 應被忽略');
        assert.equal(game.getNightState().wolfTargetId, null, '不自動收斂、不強制決選');
    }
    finally {
        game.destroy();
    }
});
test('狼會議：onWolfSubphaseChange 回呼序列（DISCUSSION r1 → VOTING → 平票 → DISCUSSION r2）', () => {
    const { game, cap } = makeNightGame();
    try {
        const wolves = roleOf(game, Role.WEREWOLF);
        const masons = roleOf(game, Role.MASON);
        const villagers = roleOf(game, Role.VILLAGER);
        const [t1, t2, t3] = villagers;
        for (const m of masons)
            game.handleToggleMasonEndTurn(m.clientId);
        assert.deepEqual(cap.wolfSubphaseChanges, [{ subphase: 'DISCUSSION', round: 1 }], 'WOLF step 啟動應通知 DISCUSSION');
        for (const w of wolves)
            game.handleToggleWolfReady(w.clientId);
        assert.deepEqual(cap.wolfSubphaseChanges, [
            { subphase: 'DISCUSSION', round: 1 },
            { subphase: 'VOTING', round: 1 },
        ], '全 ready 應通知 VOTING');
        // 1:1:1 平票 → 回 DISCUSSION（round+1）
        game.handleNightAction(wolves[0].clientId, { type: 'WOLF_KILL', targetClientId: t1.clientId });
        game.handleNightAction(wolves[1].clientId, { type: 'WOLF_KILL', targetClientId: t2.clientId });
        game.handleNightAction(wolves[2].clientId, { type: 'WOLF_KILL', targetClientId: t3.clientId });
        assert.deepEqual(cap.wolfSubphaseChanges[cap.wolfSubphaseChanges.length - 1], { subphase: 'DISCUSSION', round: 2 }, '平票應通知 DISCUSSION round 2');
    }
    finally {
        game.destroy();
    }
});
//# sourceMappingURL=game-wolf.test.js.map