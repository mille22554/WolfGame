/**
 * memory.test.ts — 私有記憶層層測試（純函式 + IO 注入）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildDailyMemory, buildMemoryContent, writeMemory, clearMemory, readMemory,
  memoryFilePath, MEMORY_SPEECHES_PER_DAY,
} from './memory.js';
import { createGameState, transition } from './game-state.js';
import type { GameState } from './types.js';
import { Role, NightActionType } from './types.js';

function joinAll(state: GameState, count: number): void {
  for (let i = 0; i < count; i++) transition(state, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
}

function day1State(): GameState {
  const s = createGameState(9);
  joinAll(s, 9);
  transition(s, { type: 'START_GAME' });
  // 推進到白天（狼 ready → timeout → resolve）
  for (const p of s.players) {
    if (p.alive && p.role === Role.WEREWOLF) {
      transition(s, { type: 'AI_WOLF_READY', playerId: p.id });
    }
  }
  transition(s, { type: 'ACTION_TIMEOUT', gateId: 'night-1' });
  transition(s, { type: 'RESOLVE_NIGHT' });
  assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
  return s;
}

test('buildDailyMemory：白天發言/投票/夜間行動/狼會議各自沉澝', () => {
  const s = day1State();
  const speaker = s.players.find((p) => p.alive && p.role === Role.VILLAGER)!;
  transition(s, { type: 'HUMAN_SPEAK', playerId: speaker.id, text: '我覺得P3有點奇怪' });
  const wolf = s.players.find((p) => p.alive && p.role === Role.WEREWOLF)!;
  // 狼會議記錄：白天 phase 不接受 HUMAN_WOLF_SPEAK，直接落 log 模擬當晚已發生事實
  s.wolfDiscussionLog.push({ playerId: wolf.id, text: '先殺P2', day: s.day });
  s.wolfKillTarget = 2;
  s.nightActions.push({ type: NightActionType.WOLF_KILL, actorId: wolf.id, targetId: 2 });

  const villagerMem = buildDailyMemory(s, speaker.id, s.day);
  assert.ok(villagerMem.includes(`第${s.day}天`), '應含天數標頭');
  assert.ok(villagerMem.includes('我覺得P3有點奇怪'), '應含我的白天發言');
  assert.ok(!villagerMem.includes('先殺P2'), '村民不應看到狼會議內容');

  const wolfMem = buildDailyMemory(s, wolf.id, s.day);
  assert.ok(wolfMem.includes('狼會議我說：「先殺P2」'), '狼應看到自己的狼會議發言');
  assert.ok(wolfMem.includes('狼群最終襲擊了 P2'), '狼應看到最終擊殺目標');
  assert.ok(wolfMem.includes('我夜間襲擊了 P2'), '狼應看到自己的夜間行動');
});

test('buildDailyMemory：無事實的一天 → 空字串', () => {
  const s = day1State();
  const quiet = s.players.find((p) => p.alive && p.role === Role.VILLAGER)!;
  assert.equal(buildDailyMemory(s, quiet.id, s.day), '');
});

test('buildMemoryContent：整局保留，不設天數上限', () => {
  const s = day1State();
  const speaker = s.players.find((p) => p.alive && p.role === Role.VILLAGER)!;
  // 為 1..5 天各塞一筆發言事實（day 欄位直接標），確保每天都有非空段
  for (const d of [1, 2, 3, 4, 5]) {
    s.discussionLog.push({ playerId: speaker.id, text: `第${d}天的發言`, day: d });
  }
  const days = [1, 2, 3, 4, 5];
  const content = buildMemoryContent(s, speaker.id, days);
  for (const d of days) {
    assert.ok(content.includes(`第${d}天`), `應保留第${d}天（整局記憶）`);
  }
});

test('buildDailyMemory：單日發言超過上限只記最後 N 則（防膨脹）', () => {
  const s = day1State();
  const speaker = s.players.find((p) => p.alive && p.role === Role.VILLAGER)!;
  for (let i = 0; i < MEMORY_SPEECHES_PER_DAY + 3; i++) {
    s.discussionLog.push({ playerId: speaker.id, text: `發言${i}`, day: s.day });
  }
  const mem = buildDailyMemory(s, speaker.id, s.day);
  assert.ok(!mem.includes('發言0'), '應丟最舊發言');
  assert.ok(!mem.includes('發言1'), '應丟次舊發言');
  assert.ok(!mem.includes('發言2'), '應丟第三舊發言');
  assert.ok(mem.includes(`發言${MEMORY_SPEECHES_PER_DAY + 2}`), '應保留最新發言');
});

test('writeMemory/readMemory/clearMemory：IO 注入目錄往返', () => {
  const dir = tmpDir();
  try {
    writeMemory('kenta', '第1天：\n- 我說：「測試」', dir);
    assert.equal(readMemory('kenta', dir), '第1天：\n- 我說：「測試」', '寫入後應讀回相同內容');
    clearMemory('kenta', dir);
    assert.equal(readMemory('kenta', dir), '', '清空後應為空');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memoryFilePath：落在注入目錄的 character-memory/ 下', () => {
  const dir = tmpDir();
  try {
    const p = memoryFilePath('rin', dir);
    assert.ok(p.includes('character-memory'), '應在 character-memory 子目錄');
    assert.ok(p.endsWith('rin.md'), '檔名應為 personaId.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
