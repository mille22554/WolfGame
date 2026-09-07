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
import type { GameState, LLMDispatcher, ClientRegistry } from './types.js';
import { Role, Team } from './types.js';

function aliveIds(s: GameState): number[] {
  return s.players.filter((p) => p.alive).map((p) => p.id);
}

function lowestAliveExcept(s: GameState, exclude: number): number {
  const ids = aliveIds(s).filter((id) => id !== exclude).sort((a, b) => a - b);
  return ids[0];
}

/** 啟發式 dispatcher：確定性投票/夜間；發言經完整管線（預發言/裁判/展開皆回確定性文本） */
class ScriptedDispatcher implements LLMDispatcher {
  prespeechCalls = 0;
  judgeCalls = 0;
  expandCalls = 0;
  constructor(private readonly getState: () => GameState) {}
  async generate(prompt: string): Promise<string> {
    if (prompt.includes('【裁判任務】')) {
      this.judgeCalls++;
      const slots: number[] = [];
      for (const m of prompt.matchAll(/^(\d+)\.\s/gm)) slots.push(parseInt(m[1], 10));
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
    const s = this.getState();
    const target = lowestAliveExcept(s, id);
    return `P${id}：「我比較在意 P${target} 的發言，想多聽聽他的說法。」`;
  }
  async requestSpeech(playerId: number): Promise<{ text: string }> {
    return { text: `P${playerId}：「補充發言。」` };
  }
  async requestVote(playerId: number): Promise<{ targetId: number }> {
    const s = this.getState();
    // 全投最低存活（非自己則投最低）→ 每天穩定出局一人
    const sorted = [...aliveIds(s)].sort((a, b) => a - b);
    const lowest = sorted[0];
    return { targetId: playerId === lowest ? sorted[1] : lowest };
  }
  async requestNightAction(playerId: number): Promise<{ targetId: number }> {
    const s = this.getState();
    const me = s.players.find((p) => p.id === playerId)!;
    if (me.role === Role.WEREWOLF) {
      const prey = s.players.filter((p) => p.alive && p.team !== Team.WEREWOLF && p.id !== playerId);
      return { targetId: (prey[0] ?? s.players.find((p) => p.alive && p.id !== playerId)!).id };
    }
    return { targetId: lowestAliveExcept(s, playerId) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('完整局：web engine + scheduler + 啟發式 dispatcher 跑到 gameOver', async () => {
  let engine!: GameEngine;
  const dispatcher = new ScriptedDispatcher(() => engine.getState());
  const snapshots: number[] = [];
  const registry: ClientRegistry = {
    getConnectedPlayerIds: () => [],
    send: () => undefined,
    sendSpectator: () => { snapshots.push(1); },
    hasSpectators: () => true,
  };
  const scheduler = new SpeechScheduler(
    {
      enqueue: (e) => engine.enqueue(e),
      getState: () => engine.getState(),
      llm: dispatcher,
    },
    { quietMs: 15, cdMs: 30, checkIntervalMs: 5, preSpeechBatch: 5 },
  );
  engine = new GameEngine({ mode: 'web', llm: dispatcher, scheduler, registry }, createGameState(9));

  try {
    for (let i = 0; i < 9; i++) engine.enqueue({ type: 'CLIENT_JOIN', name: `P${i + 1}` });
    engine.enqueue({ type: 'START_GAME' });
    engine.drain();

    let steps = 0;
    while (!engine.getState().gameOver && steps < 500) {
      steps++;
      await sleep(10); // 放行 scheduler timer 與 async dispatch
      engine.drain();
      const s = engine.getState();
      // 全 AI 局：每日發言達 2 則 → 關閉討論（server 端自動推進的測試版）
      if (s.phase === 'DAY_DISCUSSION_OPEN') {
        const count = s.discussionLog.filter((d) => d.day === s.day).length;
        if (count >= 2) {
          engine.enqueue({ type: 'CLOSE_DISCUSSION' });
          engine.drain();
        }
      }
    }

    const final = engine.getState();
    assert.ok(final.gameOver, `應分出勝負（steps=${steps}, phase=${final.phase}）`);
    assert.ok(final.winner === Team.VILLAGE || final.winner === Team.WEREWOLF);
    assert.ok(steps < 500);
    // scheduler 全程參與：預發言/裁判/展開皆被呼叫，且討論確實有發言
    assert.ok(dispatcher.prespeechCalls > 0, '預發言應被呼叫');
    assert.ok(dispatcher.judgeCalls > 0, '裁判應被呼叫');
    assert.ok(dispatcher.expandCalls > 0, '展開應被呼叫');
    assert.ok(final.daySummaries.length >= 0);
    const totalSpeeches = final.discussionLog.length;
    assert.ok(totalSpeeches > 0, '應有 AI 發言');
    // 觀戰 snapshot 可建且無洩漏
    const spec = buildSpectatorSnapshot(final);
    assert.ok(!('you' in spec));
    assert.ok(!JSON.stringify(spec).includes('"role"'));
    // 註冊表觀戰廣播曾被觸發
    assert.ok(snapshots.length > 0);
    void getNightActors;
  } finally {
    scheduler.stop();
    engine.close();
  }
});
