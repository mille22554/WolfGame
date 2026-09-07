#!/usr/bin/env node
// driver.mjs — Phase 0 CLI 入口（呼叫 dist/ 編譯產物）
// mock-test 重實作為 ScriptedGM：engine（mode: 'gm'）+ 啟發式 AI 玩完整局（兼整合測試）
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { createProvider, MockProvider, ensureModelDownloaded, DEFAULT_LLAMACPP_MODEL_URI, getDefaultModelsDir } = await import('./dist/llm.js');

function usage() {
  console.error('用法：node driver.mjs <discuss|vote|night|mock-test|model|play [playerCount]>');
  process.exit(1);
}

const command = process.argv[2];
if (!command) usage();

/** 啟發式選目標：隨機存活非自己玩家 */
function pickRandomTarget(state, excludeId, filter) {
  const pool = state.players.filter((p) => p.alive && p.id !== excludeId && (!filter || filter(p)));
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)].id;
}

try {
  switch (command) {
    case 'discuss':
    case 'vote':
    case 'night':
    case 'play': {
      console.log('Phase 1 實作');
      break;
    }
    case 'mock-test': {
      const { GameEngine } = await import('./dist/engine.js');
      const { createGameState, getNightActors, buildGMSnapshot } = await import('./dist/game-state.js');

      const rawCount = process.argv[3] ?? '9';
      const playerCount = parseInt(rawCount, 10);
      if (!Number.isInteger(playerCount) || playerCount < 6 || playerCount > 15) {
        console.error(`玩家人數必須是 6-15，輸入為：${rawCount}`);
        process.exit(1);
      }
      console.log(`🧪 ScriptedGM：以 engine（mode: 'gm'）+ 啟發式 AI 跑完整局（${playerCount} 人）`);

      const engine = new GameEngine({ mode: 'gm' }, createGameState(playerCount));
      for (let i = 0; i < playerCount; i++) {
        engine.enqueue({ type: 'CLIENT_JOIN', name: `P${i + 1}` });
      }
      engine.drain();
      console.log(`✅ 初始化完成：${engine.getState().players.length} 位玩家`);
      engine.enqueue({ type: 'START_GAME' });
      engine.drain();

      let steps = 0;
      const maxSteps = 500;
      while (!engine.getState().gameOver && steps < maxSteps) {
        steps++;
        const s = engine.getState();
        switch (s.phase) {
          case 'NIGHT_COLLECTING': {
            console.log(`🌙 第 ${s.day} 夜：收集行動`);
            const actors = getNightActors(s);
            for (const pid of actors) {
              const me = s.players.find((p) => p.id === pid);
              let target = null;
              if (me.role === 'werewolf') {
                target = pickRandomTarget(s, pid, (p) => p.team !== 'werewolf');
              } else if (me.role === 'seer') {
                // 隨機檢查：優先未查驗過的存活玩家
                const checked = new Set((me.seerChecks || []).map((c) => c.targetId));
                const unchecked = s.players.filter((p) => p.alive && p.id !== pid && !checked.has(p.id));
                const pool = unchecked.length > 0 ? unchecked : s.players.filter((p) => p.alive && p.id !== pid);
                target = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)].id : null;
              } else {
                target = pickRandomTarget(s, pid);
              }
              if (target !== null) {
                engine.enqueue({ type: 'AI_NIGHT_DONE', playerId: pid, targetId: target });
              }
            }
            engine.drain();
            break;
          }
          case 'DAY_DISCUSSION_OPEN': {
            const alive = s.players.filter((p) => p.alive && p.controlledBy === 'ai');
            for (const p of alive) {
              const bv = engine.getState().boardVersion;
              engine.enqueue({
                type: 'AI_SPEECH_DONE',
                playerId: p.id,
                text: `P${p.id}：我覺得今天要多聽聽大家的發言，再決定票投誰。`,
                boardVersion: bv,
              });
            }
            engine.enqueue({ type: 'CLOSE_DISCUSSION' });
            engine.drain();
            console.log(`💬 第 ${s.day} 天討論：${alive.length} 則發言`);
            break;
          }
          case 'DAY_DISCUSSION_CLOSING': {
            // 全 AI 局不應停留於此；若有人類玩家，啟發式代投 ready
            for (const p of s.players.filter((x) => x.alive && x.controlledBy === 'human')) {
              engine.enqueue({ type: 'HUMAN_SKIP', playerId: p.id });
            }
            engine.drain();
            break;
          }
          case 'DAY_VOTING_COLLECTING': {
            const voters = s.players.filter((p) => p.alive);
            for (const v of voters) {
              // 啟發式：投票投最可疑（此處簡化為隨機存活非自己）
              const target = pickRandomTarget(engine.getState(), v.id);
              if (target === null) continue;
              if (v.controlledBy === 'human') {
                engine.enqueue({ type: 'HUMAN_VOTE', playerId: v.id, targetId: target });
              } else {
                engine.enqueue({ type: 'AI_VOTE_DONE', playerId: v.id, targetId: target });
              }
            }
            engine.drain();
            const after = engine.getState();
            const deaths = after.deathHistory.filter((d) => d.cause === 'vote' && d.day === s.day);
            if (deaths.length > 0) {
              console.log(`🗳️ 第 ${s.day} 天投票：P${deaths[0].playerId} 出局`);
            } else {
              console.log(`🗳️ 第 ${s.day} 天投票：無人出局（平票或棄權）`);
            }
            break;
          }
          case 'NIGHT_RESOLVING':
            engine.enqueue({ type: 'RESOLVE_NIGHT' });
            engine.drain();
            break;
          case 'DAY_VOTING_RESOLVING':
            engine.enqueue({ type: 'RESOLVE_VOTES' });
            engine.drain();
            break;
          case 'DAY_RESULT_ANNOUNCING':
            engine.enqueue({ type: 'ADVANCE_DAY' });
            engine.drain();
            break;
          default:
            engine.drain();
            break;
        }
      }

      const final = engine.getState();
      if (!final.gameOver) {
        console.error(`❌ ${maxSteps} 步後仍未分勝負（phase=${final.phase}）`);
        engine.close();
        process.exit(1);
      }
      console.log(`🏁 遊戲結束：${final.winner === 'werewolf' ? '🔴 人狼陣營獲勝' : '🟢 村人陣營獲勝'}（共 ${final.day} 天）`);
      engine.save();
      engine.close();
      void buildGMSnapshot;
      console.log('✅ mock-test 跑通，全流程無例外');
      break;
    }
    case 'model': {
      // 首次啟動下載本地模型（已存在則直接回傳路徑不下載）
      const modelUri = process.env.LLM_MODEL_URI ?? DEFAULT_LLAMACPP_MODEL_URI;
      const modelsDir = process.env.LLM_MODELS_DIR ?? getDefaultModelsDir();
      console.log(`📦 模型：${modelUri}`);
      console.log(`📁 目錄：${modelsDir}`);
      let lastPct = -1;
      let sawProgress = false;
      const modelPath = await ensureModelDownloaded(modelUri, modelsDir, (downloaded, total) => {
        sawProgress = true;
        if (total > 0) {
          const pct = Math.floor((downloaded / total) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            const mb = (downloaded / 1024 / 1024).toFixed(1);
            const totalMb = (total / 1024 / 1024).toFixed(1);
            console.log(`⬇️ 下載中：${pct}%（${mb} / ${totalMb} MB）`);
          }
        }
      });
      if (!sawProgress) {
        console.log(`✅ 模型已存在，無需下載：${modelPath}`);
      } else {
        console.log(`✅ 下載完成：${modelPath}`);
      }
      break;
    }
    default:
      usage();
  }
} catch (e) {
  console.error(`❌ 執行失敗：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
