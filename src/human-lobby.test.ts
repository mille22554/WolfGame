/**
 * human-lobby.test.ts — Phase 2 大廳轉移（HUMAN_JOIN / AI_JOIN / DISCONNECT / START_GAME）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameState, transition, buildLobbySnapshot } from './game-state.js';
import type { GameState } from './types.js';
import { Role } from './types.js';

function lobby(count = 9): GameState {
  return createGameState(count);
}

test('HUMAN_JOIN 空位 → 建立真人玩家；前方空位自動 AI 填補', () => {
  const s = lobby(9);
  const r = transition(s, { type: 'HUMAN_JOIN', playerId: 5, name: 'Alice' });
  assert.equal(r.accepted, true);
  assert.equal(s.players.length, 5);
  // 座位 1-4 自動為 AI，座位 5 為真人
  for (let id = 1; id <= 4; id++) {
    const p = s.players.find((x) => x.id === id)!;
    assert.ok(p, `P${id} 應存在`);
    assert.equal(p.controlledBy, 'ai');
  }
  const me = s.players.find((x) => x.id === 5)!;
  assert.equal(me.controlledBy, 'human');
  assert.equal(me.name, 'Alice');
  assert.equal(s.phase, 'SETUP_WAITING_JOIN');
});

test('HUMAN_JOIN 已被真人佔 → 拒絕 seat taken', () => {
  const s = lobby(6);
  assert.equal(transition(s, { type: 'HUMAN_JOIN', playerId: 1, name: 'A' }).accepted, true);
  const r = transition(s, { type: 'HUMAN_JOIN', playerId: 1, name: 'B' });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'seat taken');
});

test('HUMAN_JOIN 已被 AI 佔 → 轉換為真人（name 更新）', () => {
  const s = lobby(6);
  assert.equal(transition(s, { type: 'AI_JOIN', playerId: 2 }).accepted, true);
  const r = transition(s, { type: 'HUMAN_JOIN', playerId: 2, name: 'Bob' });
  assert.equal(r.accepted, true);
  const p = s.players.find((x) => x.id === 2)!;
  assert.equal(p.controlledBy, 'human');
  assert.equal(p.name, 'Bob');
});

test('HUMAN_JOIN 超出 1..expectedPlayerCount → 拒絕', () => {
  const s = lobby(6);
  assert.equal(transition(s, { type: 'HUMAN_JOIN', playerId: 0 }).accepted, false);
  assert.equal(transition(s, { type: 'HUMAN_JOIN', playerId: 7 }).accepted, false);
  assert.equal(s.players.length, 0);
});

test('AI_JOIN 空位 → 建立 AI；已佔 → 拒絕', () => {
  const s = lobby(6);
  assert.equal(transition(s, { type: 'AI_JOIN', playerId: 1 }).accepted, true);
  assert.equal(s.players.find((x) => x.id === 1)!.controlledBy, 'ai');
  const r = transition(s, { type: 'AI_JOIN', playerId: 1 });
  assert.equal(r.accepted, false);
  assert.equal(transition(s, { type: 'AI_JOIN', playerId: 99 }).accepted, false);
});

test('全座位填滿 → SETUP_READY', () => {
  const s = lobby(6);
  transition(s, { type: 'HUMAN_JOIN', playerId: 3, name: 'H' });   // 1,2 AI + 3 真人
  assert.equal(s.phase, 'SETUP_WAITING_JOIN');
  transition(s, { type: 'AI_JOIN', playerId: 4 });
  transition(s, { type: 'AI_JOIN', playerId: 5 });
  transition(s, { type: 'AI_JOIN', playerId: 6 });
  assert.equal(s.players.length, 6);
  assert.equal(s.phase, 'SETUP_READY');
});

test('DISCONNECT（SETUP）→ 移除玩家、座位釋放、少於 expected → SETUP_WAITING_JOIN', () => {
  const s = lobby(6);
  for (let id = 1; id <= 6; id++) transition(s, { type: 'AI_JOIN', playerId: id });
  assert.equal(s.phase, 'SETUP_READY');
  // 先轉一個為真人再斷線
  transition(s, { type: 'HUMAN_JOIN', playerId: 3, name: 'H' });
  const r = transition(s, { type: 'DISCONNECT', playerId: 3 });
  assert.equal(r.accepted, true);
  assert.ok(!s.players.some((p) => p.id === 3));
  assert.equal(s.phase, 'SETUP_WAITING_JOIN');
  // 座位釋放：可被他人選走
  assert.equal(transition(s, { type: 'HUMAN_JOIN', playerId: 3, name: 'H2' }).accepted, true);
  assert.equal(s.players.find((x) => x.id === 3)!.name, 'H2');
  // 不存在的玩家 → 拒絕
  assert.equal(transition(s, { type: 'DISCONNECT', playerId: 99 }).accepted, false);
});

test('START_GAME 後角色分配包含真人座位', () => {
  const s = lobby(9);
  transition(s, { type: 'HUMAN_JOIN', playerId: 3, name: 'H1' });
  transition(s, { type: 'HUMAN_JOIN', playerId: 7, name: 'H2' });
  for (let id = 1; id <= 9; id++) {
    if (!s.players.some((p) => p.id === id)) transition(s, { type: 'AI_JOIN', playerId: id });
  }
  assert.equal(s.phase, 'SETUP_READY');
  const r = transition(s, { type: 'START_GAME' });
  assert.equal(r.accepted, true);
  assert.equal(s.phase, 'NIGHT_COLLECTING');
  const humans = s.players.filter((p) => p.controlledBy === 'human');
  assert.equal(humans.length, 2);
  // 真人座位也有分配到正式角色（不再全是佔位 VILLAGER 唯—情況除外，至少 team 正確）
  for (const h of humans) {
    assert.ok(Object.values(Role).includes(h.role));
  }
  // boardVersion++ 且不觸發點：JOIN 不觸發 boardVersion
  const s2 = lobby(6);
  transition(s2, { type: 'HUMAN_JOIN', playerId: 1 });
  assert.equal(s2.boardVersion, 0);
});

test('buildLobbySnapshot：座位列舉 + started 旗標', () => {
  const s = lobby(6);
  transition(s, { type: 'HUMAN_JOIN', playerId: 2, name: 'H' });
  const snap = buildLobbySnapshot(s);
  assert.equal(snap.phase, 'SETUP_WAITING_JOIN');
  assert.equal(snap.expectedPlayerCount, 6);
  assert.equal(snap.seats.length, 6);
  assert.equal(snap.seats[0].controlledBy, 'ai');      // 前方填補
  assert.equal(snap.seats[1].controlledBy, 'human');
  assert.equal(snap.seats[1].name, 'H');
  assert.equal(snap.seats[2].controlledBy, 'empty');
  assert.equal(snap.started, false);
});
