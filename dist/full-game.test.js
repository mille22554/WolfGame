/**
 * full-game.test.ts — 完整局整合測試
 * engine（mode 'web'）+ SpeechScheduler + ScriptedDispatcher（啟發式）+ 假 registry
 * 從 CLIENT_JOIN × 9 → START_GAME → 跑到 gameOver，全程經 scheduler 管線發言
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from './engine.js';
import { SpeechScheduler } from './ai-scheduler.js';
import { createGameState, getNightActors, buildSpectatorSnapshot } from './game-state.js';
import { Role, Team } from './types.js';
function aliveIds(s) {
    return s.players.filter((p) => p.alive).map((p) => p.id);
}
function lowestAliveExcept(s, exclude) {
    const ids = aliveIds(s).filter((id) => id !== exclude).sort((a, b) => a - b);
    return ids[0];
}
/** 啟發式 dispatcher：確定性投票/夜間；發言經完整管線（預發言/裁判/展開皆回確定性文本） */
class ScriptedDispatcher {
    getState;
    prespeechCalls = 0;
    judgeCalls = 0;
    expandCalls = 0;
    constructor(getState) {
        this.getState = getState;
    }
    async generate(prompt) {
        if (prompt.includes('【裁判任務】')) {
            this.judgeCalls++;
            const slots = [];
            for (const m of prompt.matchAll(/^(\d+)\.\s/gm))
                slots.push(parseInt(m[1], 10));
            return slots.map((s, i) => `${s}: ${8 - (i % 8)}`).join('\n');
        }
        if (prompt.includes('【你的預發言草稿】')) {
            this.expandCalls++;
            const m = prompt.match(/你是 P(\d+)/);
            return `P${m ? m[1] : '1'}：「聽完大家的發言，我會審慎投下這一票。」`;
        }
        this.prespeechCalls++;
        const m = prompt.match(/你是 P(\d+)/);
        const id = m ? parseInt(m[1], 10) : 1;
        // 狼夜極簡 prompt 無存活名單，改讀「今晚可襲擊：」合法目標列（避開同盟/自己，免觸拒收）
        const wolfTargets = prompt.match(/今晚可襲擊：([^。\n]+)/);
        const pool = wolfTargets
            ? [...wolfTargets[1].matchAll(/P(\d+)/g)].map((x) => parseInt(x[1], 10))
            : aliveIds(this.getState()).filter((x) => x !== id);
        const sorted = pool.filter((x) => x !== id).sort((a, b) => a - b);
        const target = sorted[0] ?? id;
        // 草稿帶正規 decided flag → 收斂直進投票（flag 由 scheduler 剝離，不進白板）
        return `P${id}：「我比較在意 P${target} 的發言，想多聽聽他的說法。」\n[決定:投P${target}]`;
    }
    async requestSpeech(playerId) {
        return { text: `P${playerId}：「補充發言。」` };
    }
    async requestVote(playerId) {
        const s = this.getState();
        // 全投最低存活（非自己則投最低）→ 每天穩定出局一人
        const sorted = [...aliveIds(s)].sort((a, b) => a - b);
        const lowest = sorted[0];
        return { targetId: playerId === lowest ? sorted[1] : lowest };
    }
    async requestNightAction(playerId) {
        const s = this.getState();
        const me = s.players.find((p) => p.id === playerId);
        if (me.role === Role.WEREWOLF) {
            const prey = s.players.filter((p) => p.alive && p.team !== Team.WEREWOLF && p.id !== playerId);
            return { targetId: (prey[0] ?? s.players.find((p) => p.alive && p.id !== playerId)).id };
        }
        return { targetId: lowestAliveExcept(s, playerId) };
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
test('完整局：web engine + scheduler + 啟發式 dispatcher 跑到 gameOver', async () => {
    let engine;
    const dispatcher = new ScriptedDispatcher(() => engine.getState());
    const snapshots = [];
    const registry = {
        getConnectedPlayerIds: () => [],
        send: () => undefined,
        sendSpectator: () => { snapshots.push(1); },
        hasSpectators: () => true,
    };
    const scheduler = new SpeechScheduler({
        // 與 server.ts 同步：AI 事件需立即處理，否則發言成功確認永遠失敗、收斂無法推進
        enqueue: (e) => {
            engine.enqueue(e);
            engine.drain();
        },
        getState: () => engine.getState(),
        llm: dispatcher,
    }, { cdMs: 30, preSpeechBatch: 5 });
    engine = new GameEngine({ mode: 'web', llm: dispatcher, scheduler, registry }, createGameState(9));
    try {
        for (let i = 0; i < 9; i++)
            engine.enqueue({ type: 'CLIENT_JOIN', name: `P${i + 1}` });
        engine.enqueue({ type: 'START_GAME' });
        engine.drain();
        let steps = 0;
        while (!engine.getState().gameOver && steps < 800) {
            steps++;
            await sleep(10); // 放行 scheduler timer 與 async dispatch
            engine.drain();
            // 收斂直進投票：不手動關閉討論，由 AI_READY_VOTE 統一檢查推進
        }
        const final = engine.getState();
        assert.ok(final.gameOver, `應分出勝負（steps=${steps}, phase=${final.phase}）`);
        assert.ok(final.winner === Team.VILLAGE || final.winner === Team.WEREWOLF);
        assert.ok(steps < 800);
        // scheduler 全程參與：預發言/裁判/展開皆被呼叫，且討論確實有發言
        assert.ok(dispatcher.prespeechCalls > 0, '預發言應被呼叫');
        assert.ok(dispatcher.judgeCalls > 0, '裁判應被呼叫');
        assert.ok(dispatcher.expandCalls > 0, '展開應被呼叫');
        assert.ok(final.daySummaries.length >= 0);
        const totalSpeeches = final.discussionLog.length;
        assert.ok(totalSpeeches > 0, '應有 AI 發言');
        // flag 永不洩漏進白板
        assert.ok(final.discussionLog.every((d) => !d.text.includes('[決定')), 'flag 不得進白板');
        // 觀戰 snapshot 可建且無洩漏
        const spec = buildSpectatorSnapshot(final);
        assert.ok(!('you' in spec));
        assert.ok(!JSON.stringify(spec).includes('"role"'));
        // 註冊表觀戰廣播曾被觸發
        assert.ok(snapshots.length > 0);
        void getNightActors;
    }
    finally {
        scheduler.stop();
        engine.close();
    }
});
//# sourceMappingURL=full-game.test.js.map