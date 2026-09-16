#!/usr/bin/env node
/**
 * ai-trace.mjs — AI 管線外部測試腳本
 *
 * 模擬 15 人純 AI 局第 1 夜狼會議，執行完整管線：
 * PRE_SPEECH（分批）→ JUDGE → SELECT → EXPAND
 * 輸出所有 prompt + AI 回應。
 *
 * 用法（在 server 上）：
 *   SGLANG_API_KEY=xxx node scripts/ai-trace.mjs
 *
 * 產物：ai-trace-output.md（當前目錄）
 */

import { writeFileSync } from 'node:fs';
import { loadCharacterProfile, runWolfMeetingPipeline } from '../dist/lobby-server/ai-player.js';

// ============================================
// 硬編 15 人局遊戲狀態
// ============================================

const players = [
  { id: 1, name: 'kenta', role: 'werewolf', personality: 'kenta', alive: true },
  { id: 2, name: 'aoi', role: 'seer', personality: 'aoi', alive: true },
  { id: 3, name: 'ryoko', role: 'werewolf', personality: 'ryoko', alive: true },
  { id: 4, name: 'shinichi', role: 'villager', personality: 'shinichi', alive: true },
  { id: 5, name: 'rin', role: 'medium', personality: 'rin', alive: true },
  { id: 6, name: 'futa', role: 'villager', personality: 'futa', alive: true },
  { id: 7, name: 'tatuya', role: 'werewolf', personality: 'tatuya', alive: true },
  { id: 8, name: 'misaki', role: 'villager', personality: 'misaki', alive: true },
  { id: 9, name: 'shota', role: 'madman', personality: 'shota', alive: true },
  { id: 10, name: 'chihiro', role: 'mason', personality: 'chihiro', alive: true },
  { id: 11, name: 'koharu', role: 'mason', personality: 'koharu', alive: true },
  { id: 12, name: 'ren', role: 'guard', personality: 'ren', alive: true },
  { id: 13, name: 'sayuki', role: 'villager', personality: 'sayuki', alive: true },
  { id: 14, name: 'yuko', role: 'villager', personality: 'yuko', alive: true },
  { id: 15, name: 'yuma', role: 'villager', personality: 'yuma', alive: true },
];

const wolves = players.filter(p => p.role === 'werewolf');

const gameState = {
  day: 1,
  phase: 'NIGHT_WOLF_MEETING',
  players,
  privateInfo: '你是人狼。你的同夥：P1(kenta)、P3(ryoko)、P7(tatuya)。狂人是 P9(shota)，他是友方但不知道誰是狼。不可刀同夥和狂人。',
  wolfIds: [1, 3, 7],
  madmanId: 9,
};

// ============================================
// 載入角色設定檔
// ============================================

console.log('載入角色設定檔...');
const profiles = new Map();
for (const wolf of wolves) {
  const profile = loadCharacterProfile(wolf.personality);
  if (profile) {
    profiles.set(wolf.personality, profile);
    console.log(`  ✓ ${wolf.personality} (${profile.persona.length} chars)`);
  } else {
    console.error(`  ✗ ${wolf.personality} — 找不到 character/${wolf.personality}/agents.md`);
  }
}

// ============================================
// 執行管線
// ============================================

console.log('\n開始執行狼會議管線...\n');
const output = [];
output.push('# AI Trace Output — 15 人局 第 1 夜 狼會議\n');
output.push(`時間：${new Date().toISOString()}\n`);
output.push(`Wolf 數：${wolves.length}（${wolves.map(w => w.name).join(', ')}）\n`);

const result = await runWolfMeetingPipeline(wolves, profiles, gameState, (step) => {
  console.log(`  [${step.name}]`);
  output.push(`\n---\n## ${step.name}\n`);

  // 印出 prompts
  for (const msg of step.prompts) {
    output.push(`### ${msg.role} prompt\n`);
    output.push('```\n' + msg.content + '\n```\n');
  }

  // 印出 response
  output.push(`### Response\n`);
  output.push('```\n' + (step.response ?? '(null)') + '\n```\n');

  // 印出 parsed
  if (step.parsed) {
    output.push(`### Parsed JSON\n`);
    output.push('```json\n' + JSON.stringify(step.parsed, null, 2) + '\n```\n');
  }
});

// ============================================
// 總結
// ============================================

output.push(`\n---\n## 結果\n`);
output.push(`- 選中 draft：#${result.selectedDraftIndex + 1}（${wolves[result.selectedDraftIndex]?.name}）\n`);
output.push(`- 最終發言：「${result.finalSpeech}」\n`);

console.log(`\n選中：#${result.selectedDraftIndex + 1}（${wolves[result.selectedDraftIndex]?.name}）`);
console.log(`最終發言：「${result.finalSpeech}」`);

// 寫入檔案
const outPath = 'ai-trace-output.md';
writeFileSync(outPath, output.join('\n'), 'utf-8');
console.log(`\n✓ 已寫入 ${outPath}`);
