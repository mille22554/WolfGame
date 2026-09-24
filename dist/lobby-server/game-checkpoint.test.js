/**
 * game-checkpoint.test.ts — DAY_DISCUSSION checkpoint 的 focused tests
 *
 * 這些測試只驗證 GameEngine 的遊戲事實／restore 邊界；不涉及 AI private snapshot。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Role, Team } from '../types.js';
import { GameEngine } from './game.js';
function makeHarness(playerCount = 3) {
    const cap = { broadcast: [], phaseSnapshots: [] };
    const players = Array.from({ length: playerCount }, (_, i) => ({ clientId: `p${i}`, nickname: `P${i}` }));
    let game;
    const callbacks = {
        sendTo: () => undefined,
        broadcast: (msg, targets) => {
            cap.broadcast.push({ msg, targets });
            const record = msg;
            if (record.type === 'PHASE_CHANGED') {
                const dayState = game.getDayState();
                cap.phaseSnapshots.push({
                    phase: String(record.phase),
                    day: Number(record.day),
                    ready: new Map(dayState.dayReady),
                    messageCount: dayState.dayMessages.length,
                });
            }
        },
    };
    game = new GameEngine('CHECKPOINT', players, callbacks);
    // 測試 harness 直接放入已開始的最小 DAY_DISCUSSION state，避免等待真實 phase timer。
    const state = game.state;
    state.players = players.map((player) => ({
        clientId: player.clientId,
        nickname: player.nickname,
        role: Role.VILLAGER,
        team: Team.VILLAGE,
        alive: true,
        isMasonPartner: false,
        wolfPartnerIds: [],
        seerChecks: [],
        guardProtects: [],
    }));
    state.phase = 'DAY_DISCUSSION';
    state.dayReady = new Map(players.map((player) => [player.clientId, false]));
    state.dayMessages = [];
    return { game, cap, players };
}
function countBroadcasts(cap, type) {
    return cap.broadcast.filter((entry) => entry.msg.type === type).length;
}
test('DAY_DISCUSSION restore 保留 dayReady；全 ready 也不會在 restore 自動進 DAY_VOTING', () => {
    const source = makeHarness();
    const restoredPartial = makeHarness();
    const restoredAll = makeHarness();
    try {
        source.game.setDayReady(source.players[0].clientId, true);
        source.game.sendDayMessage(source.players[0].clientId, 'same text');
        const snapshot = source.game.saveState();
        restoredPartial.game.restoreState(snapshot);
        const partial = restoredPartial.game.getDayState();
        assert.equal(restoredPartial.game.getNightState().phase, 'DAY_DISCUSSION');
        assert.equal(partial.dayReady.get(source.players[0].clientId), true);
        assert.equal(partial.dayReady.get(source.players[1].clientId), false);
        assert.equal(partial.dayReady.get(source.players[2].clientId), false);
        assert.equal(partial.dayMessages.length, 1);
        // PHASE_CHANGED callback 看到的 day state 必須已經 hydrate 完成。
        const phaseView = restoredPartial.cap.phaseSnapshots.at(-1);
        assert.ok(phaseView);
        assert.equal(phaseView.ready.get(source.players[0].clientId), true);
        assert.equal(phaseView.messageCount, 1);
        // 尚未全 ready 時，reconcile 是純 no-op，不重複 broadcast。
        const beforePartialReconcile = restoredPartial.cap.broadcast.length;
        restoredPartial.game.reconcileDayReady();
        assert.equal(restoredPartial.game.getNightState().phase, 'DAY_DISCUSSION');
        assert.equal(restoredPartial.cap.broadcast.length, beforePartialReconcile);
        const allReadySnapshot = {
            ...snapshot,
            dayReady: Object.fromEntries(source.players.map((player) => [player.clientId, true])),
        };
        restoredAll.game.restoreState(allReadySnapshot);
        const all = restoredAll.game.getDayState();
        assert.equal(restoredAll.game.getNightState().phase, 'DAY_DISCUSSION');
        assert.deepEqual([...all.dayReady.values()], [true, true, true]);
        assert.equal(countBroadcasts(restoredAll.cap, 'PHASE_CHANGED'), 1);
        assert.equal(restoredAll.cap.phaseSnapshots[0].ready.get(source.players[0].clientId), true);
        // 已 ready 的值重送是 no-op：不再 broadcast，也不觸發 voting phase。
        const before = restoredAll.cap.broadcast.length;
        restoredAll.game.setDayReady(source.players[0].clientId, true);
        assert.equal(restoredAll.cap.broadcast.length, before);
        assert.equal(restoredAll.game.getNightState().phase, 'DAY_DISCUSSION');
        // restore 不自動跳 phase；明確呼叫 reconcile 才做一次 liveness progression。
        const beforeReconcile = restoredAll.cap.broadcast.length;
        restoredAll.game.reconcileDayReady();
        assert.equal(restoredAll.game.getNightState().phase, 'DAY_VOTING');
        assert.equal(restoredAll.cap.broadcast.length, beforeReconcile + 1);
        assert.equal(countBroadcasts(restoredAll.cap, 'PHASE_CHANGED'), 2);
        assert.equal(countBroadcasts(restoredAll.cap, 'DAY_READY_STATUS'), 1);
        // 已進入 DAY_VOTING 後再次呼叫也是 no-op。
        const beforeSecondReconcile = restoredAll.cap.broadcast.length;
        restoredAll.game.reconcileDayReady();
        assert.equal(restoredAll.cap.broadcast.length, beforeSecondReconcile);
    }
    finally {
        source.game.destroy();
        restoredPartial.game.destroy();
        restoredAll.game.destroy();
    }
});
test('getDayState 回傳 Map、array 與訊息物件的複本', () => {
    const { game, players } = makeHarness();
    try {
        game.sendDayMessage(players[0].clientId, 'original');
        const first = game.getDayState();
        first.dayReady.set(players[0].clientId, true);
        first.dayMessages.push({
            from: 'intruder',
            text: 'injected',
            day: 1,
            seq: 99,
            id: 'injected',
        });
        const firstMessage = first.dayMessages[0];
        assert.ok(firstMessage);
        firstMessage.text = 'mutated';
        const second = game.getDayState();
        assert.equal(second.dayReady.get(players[0].clientId), false);
        assert.equal(second.dayMessages.length, 1);
        assert.equal(second.dayMessages[0].text, 'original');
    }
    finally {
        game.destroy();
    }
});
test('dayMessages 保留順序與重複 from/text；day/seq/id 可 round-trip', () => {
    const source = makeHarness();
    const restored = makeHarness();
    try {
        source.game.sendDayMessage(source.players[0].clientId, 'same text');
        source.game.sendDayMessage(source.players[0].clientId, 'same text');
        const messages = source.game.getDayState().dayMessages;
        assert.equal(messages.length, 2);
        assert.deepEqual(messages.map((message) => message.seq), [1, 2]);
        assert.deepEqual(messages.map((message) => message.day), [1, 1]);
        assert.notEqual(messages[0].id, messages[1].id);
        restored.game.restoreState(source.game.saveState());
        assert.deepEqual(restored.game.getDayState().dayMessages, messages);
        restored.game.sendDayMessage(source.players[0].clientId, 'next');
        const afterResume = restored.game.getDayState().dayMessages;
        assert.equal(afterResume.at(-1)?.seq, 3);
        assert.equal(new Set(afterResume.map((message) => message.id)).size, afterResume.length);
    }
    finally {
        source.game.destroy();
        restored.game.destroy();
    }
});
test('dayMessages 50 則上限：第 51 則後仍只保留最近 50 則', () => {
    const { game, players } = makeHarness();
    try {
        for (let i = 1; i <= 51; i++)
            game.sendDayMessage(players[0].clientId, `message-${i}`);
        const messages = game.getDayState().dayMessages;
        assert.equal(messages.length, 50);
        assert.equal(messages[0]?.text, 'message-2');
        assert.equal(messages.at(-1)?.text, 'message-51');
        assert.deepEqual(messages.map((message) => message.seq), Array.from({ length: 50 }, (_, i) => i + 2));
        assert.equal(new Set(messages.map((message) => message.id)).size, 50);
    }
    finally {
        game.destroy();
    }
});
test('oversized dayMessages restore 仍截為 50 則，下一則 seq 不碰撞', () => {
    const source = makeHarness();
    const restored = makeHarness();
    try {
        const snapshot = source.game.saveState();
        snapshot.dayMessages = Array.from({ length: 75 }, (_, index) => ({
            from: source.players[0].nickname,
            text: `legacy-${index + 1}`,
        }));
        restored.game.restoreState(snapshot);
        const messages = restored.game.getDayState().dayMessages;
        assert.equal(messages.length, 50);
        assert.equal(messages[0]?.text, 'legacy-26');
        assert.equal(messages.at(-1)?.text, 'legacy-75');
        assert.deepEqual(messages.map((message) => message.seq), Array.from({ length: 50 }, (_, i) => i + 26));
        assert.equal(new Set(messages.map((message) => message.id)).size, 50);
        restored.game.sendDayMessage(source.players[0].clientId, 'next');
        const afterResume = restored.game.getDayState().dayMessages;
        assert.equal(afterResume.length, 50);
        assert.equal(afterResume.at(-1)?.seq, 76);
        assert.equal(new Set(afterResume.map((message) => message.id)).size, 50);
        assert.equal(afterResume.at(-1)?.text, 'next');
    }
    finally {
        source.game.destroy();
        restored.game.destroy();
    }
});
test('混合舊／新 dayMessages metadata 會保留訊息並產生合法唯一身份', () => {
    const source = makeHarness();
    const restored = makeHarness();
    try {
        const snapshot = source.game.saveState();
        snapshot.dayMessages = [
            { from: source.players[0].nickname, text: 'legacy-a' },
            { from: source.players[0].nickname, text: 'new-b', day: 1, seq: 2, id: 'new-b' },
            { from: source.players[1].nickname, text: 'new-c', day: 1, seq: 2, id: 'new-c' },
            { from: source.players[0].nickname, text: 'legacy-d' },
        ];
        restored.game.restoreState(snapshot);
        const messages = restored.game.getDayState().dayMessages;
        assert.deepEqual(messages.map((message) => message.text), ['legacy-a', 'new-b', 'new-c', 'legacy-d']);
        assert.deepEqual(messages.map((message) => message.day), [1, 1, 1, 1]);
        assert.equal(new Set(messages.map((message) => message.seq)).size, messages.length);
        assert.equal(new Set(messages.map((message) => message.id)).size, messages.length);
        assert.ok(messages.every((message) => Number.isInteger(message.seq) && message.seq > 0 && message.id.length > 0));
    }
    finally {
        source.game.destroy();
        restored.game.destroy();
    }
});
test('wolfTargetId 會 round-trip；舊 snapshot 或不存在的 target 安全降為 null', () => {
    const source = makeHarness();
    const restored = makeHarness();
    try {
        const targetId = source.players[1].clientId;
        source.game.state.wolfTargetId = targetId;
        const snapshot = source.game.saveState();
        assert.equal(snapshot.wolfTargetId, targetId);
        restored.game.restoreState(snapshot);
        assert.equal(restored.game.getNightState().wolfTargetId, targetId);
        restored.game.restoreState({ ...snapshot, wolfTargetId: 'missing-player' });
        assert.equal(restored.game.getNightState().wolfTargetId, null);
        const legacySnapshot = { ...snapshot };
        delete legacySnapshot.wolfTargetId;
        restored.game.restoreState(legacySnapshot);
        assert.equal(restored.game.getNightState().wolfTargetId, null);
    }
    finally {
        source.game.destroy();
        restored.game.destroy();
    }
});
test('舊 snapshot 缺 day/seq/id 時可 restore，且不把 NIGHT phase 帶回來', () => {
    const source = makeHarness();
    const restored = makeHarness();
    try {
        const snapshot = source.game.saveState();
        snapshot.phase = 'NIGHT';
        delete snapshot.dayReady;
        snapshot.dayMessages = [
            { from: source.players[0].nickname, text: 'same text' },
            { from: source.players[0].nickname, text: 'same text' },
        ];
        restored.game.restoreState(snapshot);
        const state = restored.game.getDayState();
        assert.equal(restored.game.getNightState().phase, 'DAY_DISCUSSION');
        assert.equal(state.dayMessages.length, 2);
        assert.equal(state.dayMessages[0].day, 1);
        assert.equal(state.dayMessages[0].seq, 1);
        assert.equal(state.dayMessages[1].seq, 2);
        assert.notEqual(state.dayMessages[0].id, state.dayMessages[1].id);
        assert.deepEqual([...state.dayReady.values()], [false, false, false]);
        assert.equal(restored.cap.phaseSnapshots.filter((view) => view.phase === 'NIGHT').length, 0);
    }
    finally {
        source.game.destroy();
        restored.game.destroy();
    }
});
test('setDayReady 是 idempotent；handleToggleVoteReady 保留 toggle 語意', () => {
    const { game, cap, players } = makeHarness();
    try {
        game.setDayReady(players[0].clientId, true);
        assert.equal(countBroadcasts(cap, 'DAY_READY_STATUS'), 1);
        game.setDayReady(players[0].clientId, true);
        assert.equal(countBroadcasts(cap, 'DAY_READY_STATUS'), 1);
        game.setDayReady(players[0].clientId, false);
        game.setDayReady(players[0].clientId, false);
        assert.equal(countBroadcasts(cap, 'DAY_READY_STATUS'), 2);
        assert.equal(game.getDayState().dayReady.get(players[0].clientId), false);
        game.handleToggleVoteReady(players[0].clientId);
        assert.equal(game.getDayState().dayReady.get(players[0].clientId), true);
        game.setDayReady(players[1].clientId, true);
        game.setDayReady(players[2].clientId, true);
        assert.equal(game.getNightState().phase, 'DAY_VOTING');
        const before = cap.broadcast.length;
        game.setDayReady(players[2].clientId, true);
        assert.equal(cap.broadcast.length, before);
    }
    finally {
        game.destroy();
    }
});
test('正常進入新一天會清空 dayReady 與當日 day board', () => {
    const { game, players } = makeHarness();
    try {
        game.sendDayMessage(players[0].clientId, 'day one');
        game.setDayReady(players[0].clientId, true);
        game.state.day = 2;
        game.transitionTo('DAY_DISCUSSION');
        const state = game.getDayState();
        assert.deepEqual([...state.dayReady.values()], [false, false, false]);
        assert.equal(state.dayMessages.length, 0);
        game.sendDayMessage(players[0].clientId, 'day two');
        const message = game.getDayState().dayMessages[0];
        assert.ok(message);
        assert.equal(message.day, 2);
        assert.equal(message.seq, 1);
    }
    finally {
        game.destroy();
    }
});
//# sourceMappingURL=game-checkpoint.test.js.map