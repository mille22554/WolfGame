#!/usr/bin/env node
// driver.mjs — 角色 session 架構 CLI 入口（呼叫 dist/ 編譯產物）
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { createProvider, MockProvider, ensureModelDownloaded, DEFAULT_LLAMACPP_MODEL_URI, getDefaultModelsDir } = await import('./dist/llm.js');
const { runDiscussion, runVoting, runNight } = await import('./dist/driver.js');
const gameStateMod = await import('./dist/game-state.js');
const { loadState, initGame, startDay, processNight, processVotes } = gameStateMod;

function usage() {
  console.error('用法：node driver.mjs <discuss|vote|night|mock-test|model>');
  process.exit(1);
}

const command = process.argv[2];
if (!command) usage();

try {
  switch (command) {
    case 'discuss': {
      const state = loadState();
      const before = state.discussionLog.length;
      const provider = await createProvider();
      await runDiscussion(state, provider);
      const fresh = state.discussionLog.slice(before);
      if (fresh.length === 0) {
        console.log('（無人發言：沒有存活的 AI 玩家）');
      } else {
        for (const d of fresh) {
          console.log(`P${d.playerId}：${d.message}`);
        }
      }
      console.log(`✅ 已記錄 ${fresh.length} 則發言`);
      break;
    }
    case 'vote': {
      const state = loadState();
      const provider = await createProvider();
      const votes = await runVoting(state, provider);
      if (votes.length === 0) {
        console.log('（無投票：全部解析失敗）');
      } else {
        for (const v of votes) {
          console.log(`P${v.voterId} 投 P${v.targetId}`);
        }
      }
      console.log(`✅ 共 ${votes.length} 票`);
      break;
    }
    case 'night': {
      const state = loadState();
      const provider = await createProvider();
      const actions = await runNight(state, provider);
      console.log(`🌙 夜間行動：${JSON.stringify(actions)}`);
      if (actions.wolfKill !== undefined) console.log(`🔴 人狼選擇：P${actions.wolfKill}`);
      if (actions.seerCheck !== undefined) console.log(`🔮 預言家查驗：P${actions.seerCheck}`);
      if (actions.guardProtect !== undefined) console.log(`🛡️ 守衛守護：P${actions.guardProtect}`);
      break;
    }
    case 'mock-test': {
      console.log('🧪 以 MockProvider 跑一輪完整流程（init 9 → start-day → night → discussion → vote）');
      const provider = new MockProvider();
      let state = initGame(9);
      console.log(`✅ 初始化完成：${state.players.length} 位玩家`);
      state = startDay(state);
      console.log(`🌅 第 ${state.day} 天開始`);

      const actions = await runNight(state, provider);
      console.log(`🌙 夜間行動：${JSON.stringify(actions)}`);

      const { nightResult } = processNight(state, actions);
      if (nightResult.killBlocked) {
        console.log('🌅 平安夜（守衛成功守護）');
      } else if (nightResult.killedPlayerId !== undefined) {
        console.log(`💀 夜間犧牲者：P${nightResult.killedPlayerId}（身分不公開）`);
      } else {
        console.log('🌅 平安夜');
      }

      const before = state.discussionLog.length;
      await runDiscussion(state, provider);
      const fresh = state.discussionLog.slice(before);
      console.log(`💬 討論（${fresh.length} 則）：`);
      for (const d of fresh) {
        console.log(`  P${d.playerId}：${d.message}`);
      }

      const votes = await runVoting(state, provider);
      console.log(`🗳️ 投票（${votes.length} 票）：`);
      for (const v of votes) {
        console.log(`  P${v.voterId} 投 P${v.targetId}`);
      }
      const { eliminatedPlayerId } = processVotes(
        state,
        votes.map((v) => ({ voterId: v.voterId, targetId: v.targetId })),
      );
      if (eliminatedPlayerId !== undefined) {
        console.log(`🗳️ P${eliminatedPlayerId} 被投票出局（身分不公開）`);
      } else {
        console.log('🗳️ 無人被投票出局');
      }

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
