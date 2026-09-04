#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gmPath = path.join(__dirname, 'dist', 'gm.js');

// Helper to escape argument for Windows cmd.exe: double quotes inside are doubled, then wrapped in double quotes
function shellQuote(str) {
  if (str === undefined || str === null) return '""';
  const s = String(str);
  // Escape double quotes by doubling them for cmd.exe
  const escaped = s.replace(/"/g, '""');
  return `"${escaped}"`;
}

// Execute gm.js with given argument string, return stdout as string
function runGm(argStr) {
  const cmd = `node ${shellQuote(gmPath)} ${argStr}`;
  return execSync(cmd, { encoding: 'utf-8', cwd: __dirname, stdio: 'pipe' });
}

function parseJsonOutput(output) {
  return JSON.parse(output);
}

function roleToChinese(role) {
  const map = {
    villager: '村民',
    seer: '占卜師',
    medium: '靈能者',
    guard: '獵人',
    mason: '共有者',
    werewolf: '人狼',
    madman: '狂人',
  };
  return map[role] || role;
}

function phaseToChinese(phase) {
  const map = {
    setup: '準備階段',
    night: '夜晚',
    day_discussion: '白天討論',
    day_voting: '投票階段',
    day_result: '結果公佈',
    game_over: '遊戲結束',
  };
  return map[phase] || phase;
}

function teamToChinese(team) {
  const map = {
    village: '村人陣營',
    werewolf: '人狼陣營',
    werewolfTeam: '人狼陣營',
  };
  return map[team] || team;
}

function handleError(e) {
  let msg = '';
  if (e.stderr) {
    try {
      const s = e.stderr.toString();
      msg += s;
    } catch {}
  }
  if (e.stdout) {
    try {
      const s = e.stdout.toString();
      if (s) msg += (msg ? '\n' : '') + s;
    } catch {}
  }
  if (!msg) msg = e.message || String(e);

  // Try to parse JSON error like {"error":"..."}
  try {
    const parsed = JSON.parse(msg.trim());
    if (parsed.error) {
      console.error(parsed.error);
      return;
    }
    // If parsed is object with error inside first line?
    // Also handle case where msg contains JSON plus extra
    // Try to extract JSON object
  } catch {}
  // If msg is JSON string with error field on multiple lines, try to find
  try {
    const trimmed = msg.trim();
    // Find first { and last } maybe contains JSON
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      const jsonPart = trimmed.substring(firstBrace, lastBrace + 1);
      const parsed2 = JSON.parse(jsonPart);
      if (parsed2.error) {
        console.error(parsed2.error);
        return;
      }
    }
  } catch {}
  // Extract "Error: ..." line from stack trace for cleaner output
  const errorMatch = msg.match(/Error:\s*(.+)/);
  if (errorMatch) {
    console.error(errorMatch[1].trim());
    return;
  }
  console.error(msg.trim());
}

async function main() {
  const command = process.argv[2];

  if (!command) {
    console.error('請提供指令：init, reset, night, night-auto, speak, discuss, vote, state, start-day, mason-chat');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'init': {
        const n = process.argv[3] || '9';
        const playerCount = parseInt(n, 10);
        const out = runGm(`init ${playerCount}`);
        // Validate output is JSON but ignore content
        try { parseJsonOutput(out); } catch {}
        console.log(`✅ 遊戲初始化完成，${playerCount} 位玩家`);
        break;
      }
      case 'reset': {
        // 歸零遊戲：清空所有遊戲紀錄，回到尚未開始的狀態（保留檔案骨架）
        const charDir = path.join(__dirname, 'character');
        // 1. 清空 game-state.json 為空殼（無角色分配）
        const emptyState = {
          players: [], day: 0, phase: 'setup',
          nightActions: [], votes: [], deathHistory: [],
          discussionLog: [], masonChatLog: [], gameOver: false,
          wolfKillTarget: null, seerCheckTarget: null, seerCheckResult: null,
        };
        writeFileSync(path.join(__dirname, 'game-state.json'), JSON.stringify(emptyState, null, 2), 'utf-8');
        // 2. 清空所有角色的 memory.md
        if (existsSync(charDir)) {
          for (const entry of readdirSync(charDir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              const memFile = path.join(charDir, entry.name, 'memory.md');
              if (existsSync(memFile)) writeFileSync(memFile, '', 'utf-8');
            }
          }
          // 3. 清空白板與公開狀態
          for (const f of ['day-meeting.md', 'wolf-meeting.md', 'mason-meeting.md', 'game-public.md']) {
            const fp = path.join(charDir, f);
            if (existsSync(fp)) writeFileSync(fp, '', 'utf-8');
          }
          // 4. 移除所有 lock 檔案（含子目錄）
          function removeLocks(dir) {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
              const p = path.join(dir, e.name);
              if (e.isDirectory()) removeLocks(p);
              else if (e.name.endsWith('.lock')) unlinkSync(p);
            }
          }
          removeLocks(charDir);
        }
        console.log('✅ 遊戲已歸零，回到尚未開始的狀態');
        break;
      }
      case 'start-day': {
        const out = runGm('start-day');
        try { parseJsonOutput(out); } catch {}
        console.log('🌅 新的一天開始了');
        break;
      }
      case 'night-auto': {
        // Generate random night actions internally - no exposure to caller
        // Read game state to get alive players
        const stateOut = runGm('state');
        const stateData = parseJsonOutput(stateOut);
        const snapshot = stateData.state || stateData;
        const alive = (snapshot.alivePlayers || []).map(p => p.id);
        const phase = snapshot.phase;
        if (phase === 'setup' || phase === 'day_discussion' || phase === 'day_voting' || phase === 'day_result') {
          runGm('start-day');
        }
        if (alive.length === 0) {
          console.error('沒有存活玩家');
          process.exit(1);
        }
        function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
        // Seer check: avoid already-checked targets and the seer themself
        let seerId = -1;
        let checkedTargets = [];
        try {
          const raw = readFileSync('game-state.json', 'utf-8');
          const gs = JSON.parse(raw);
          const seer = (gs.players || []).find(p => p.role === 'seer');
          if (seer) {
            seerId = seer.id;
            checkedTargets = (seer.seerChecks || []).map(c => c.targetId);
          }
        } catch (e) { seerId = -1; checkedTargets = []; }
        const checkable = alive.filter(id => !checkedTargets.includes(id) && id !== seerId);
        const seerCheck = checkable.length > 0 ? pickRandom(checkable) : pickRandom(alive);
        // Wolf kill: wolves don't kill their own kind or the madman
        let wolfIds = [];
        let madmanId = -1;
        try {
          const raw = readFileSync('game-state.json', 'utf-8');
          const gs = JSON.parse(raw);
          wolfIds = (gs.players || []).filter(p => p.role === 'werewolf').map(p => p.id);
          const madman = (gs.players || []).find(p => p.role === 'madman');
          if (madman) madmanId = madman.id;
        } catch (e) { wolfIds = []; madmanId = -1; }
        const killable = alive.filter(id => !wolfIds.includes(id) && id !== madmanId);
        const wolfKill = killable.length > 0 ? pickRandom(killable) : pickRandom(alive);
        const guardProtect = pickRandom(alive);
        const nightParams = { seerCheck, wolfKill, guardProtect };
        const jsonArg = shellQuote(JSON.stringify(nightParams));
        const nightOut = runGm(`night ${jsonArg}`);
        const nightParsed = parseJsonOutput(nightOut);
        const nr = nightParsed.nightResult || nightParsed;
        const lines = [];
        if (nr.killBlocked) {
          lines.push('🌅 平安夜！');
        } else if (nr.killed !== undefined && nr.killed !== null) {
          lines.push(`💀 昨晚犧牲者：P${nr.killed}`);
        } else {
          lines.push('🌅 平安夜！');
        }
        // Always show seer result for night-auto since we always include seerCheck
        const target = nr.seerCheck ?? nr.seerCheckTargetId;
        const result = nr.seerResult ?? nr.seerCheckResult;
        if (target !== undefined && result !== undefined) {
          const resultChinese = result === 'werewolf' ? '人狼' : '村人';
          lines.push(`🔍 占卜結果：P${target} 是「${resultChinese}」`);
        }
        // Medium info (from snapshot - already formatted string)
        const mediumSnap1 = nightParsed.state;
        if (mediumSnap1 && mediumSnap1.mediumInfo) {
          lines.push(mediumSnap1.mediumInfo);
        }
        console.log(lines.join('\n'));
        break;
      }
      case 'night': {
        let rawInput = process.argv[3] || '{}';
        // If JSON was split into multiple args (PowerShell quoting issues), join them
        if (process.argv.length > 4) {
          rawInput = process.argv.slice(3).join(' ');
        }
        let inputObj = null;
        let jsonInput = rawInput;
        // Try loose parsing to handle PowerShell stripping double quotes
        function parseLoose(s) {
          try { return JSON.parse(s); } catch {}
          try {
            const fixed = s.replace(/([{,\[]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
            return JSON.parse(fixed);
          } catch {}
          try {
            const fixed2 = s.replace(/'/g, '"').replace(/([{,\[]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
            return JSON.parse(fixed2);
          } catch {}
          return null;
        }
        inputObj = parseLoose(rawInput);
        if (inputObj === null) {
          console.error('night 參數必須是合法 JSON');
          process.exit(1);
        }
        // Normalize to proper JSON string for internal exec
        jsonInput = JSON.stringify(inputObj);
        // Check current phase - if setup, need start-day first
        try {
          const stateOut = runGm('state');
          const stateData = parseJsonOutput(stateOut);
          const phase = stateData.phase || stateData.state?.phase;
          if (phase === 'setup') {
            runGm('start-day');
          }
        } catch (e) {
          // If state check fails, proceed anyway; night will error if needed
          // but try to handle start-day if possible
        }

        const jsonArg = shellQuote(jsonInput);
        const out = runGm(`night ${jsonArg}`);
        const parsed = parseJsonOutput(out);
        const nightResult = parsed.nightResult || parsed;
        const lines = [];

        // Determine death / blocked
        if (nightResult.killBlocked) {
          lines.push('🌅 平安夜！');
        } else if (nightResult.killed !== undefined && nightResult.killed !== null) {
          lines.push(`💀 昨晚犧牲者：P${nightResult.killed}`);
        } else if (nightResult.killedPlayerId !== undefined && nightResult.killedPlayerId !== null) {
          // fallback older field
          lines.push(`💀 昨晚犧牲者：P${nightResult.killedPlayerId}`);
        } else {
          // No kill and not blocked => also平安夜
          lines.push('🌅 平安夜！');
        }

        // Seer check result only if input had seerCheck
        if (inputObj.seerCheck !== undefined && inputObj.seerCheck !== null) {
          const target = nightResult.seerCheck ?? nightResult.seerCheckTargetId;
          const result = nightResult.seerResult ?? nightResult.seerCheckResult;
          if (target !== undefined && result !== undefined) {
            const resultChinese = result === 'werewolf' ? '人狼' : '村人';
            lines.push(`🔍 占卜結果：P${target} 是「${resultChinese}」`);
          }
        }

        // Medium info (from snapshot - already formatted string)
        const mediumSnap2 = parsed.state;
        if (mediumSnap2 && mediumSnap2.mediumInfo) {
          lines.push(mediumSnap2.mediumInfo);
        }

        console.log(lines.join('\n'));
        break;
      }
      case 'discuss': {
        // Read JSON array of {id, msg} pairs from stdin, record all, return single confirmation
        // Usage: echo '[{"id":1,"msg":"hello"}]' | node gm-helper.mjs discuss
        const raw = readFileSync(0, 'utf-8').trim();
        let entries;
        try {
          entries = JSON.parse(raw);
        } catch {
          console.error('discuss stdin 必須是合法 JSON 陣列');
          process.exit(1);
        }
        if (!Array.isArray(entries)) {
          console.error('discuss stdin 必須是 JSON 陣列');
          process.exit(1);
        }
        let count = 0;
        for (const entry of entries) {
          const id = entry.id;
          const msg = entry.msg || '';
          if (!id || !msg) continue;
          const msgArg = shellQuote(msg);
          try {
            runGm(`speak ${id} ${msgArg}`);
            count++;
          } catch {}
        }
        console.log(`✅ 已記錄 ${count} 則發言`);
        break;
      }
      case 'speak': {
        const id = process.argv[3];
        const msg = process.argv[4] || '';
        if (!id || !msg) {
          console.error('Usage: gm-helper.mjs speak <id> \'<message>\'');
          process.exit(1);
        }
        const msgArg = shellQuote(msg);
        const out = runGm(`speak ${id} ${msgArg}`);
        try { parseJsonOutput(out); } catch {}
        console.log(`✅ P${id} 發言已記錄`);
        break;
      }
      case 'vote': {
        let rawVote = process.argv[3] || '[]';
        if (process.argv.length > 4) {
          // vote is the command, json may be split; reconstruct from index 3 onward
          rawVote = process.argv.slice(3).join(' ');
        }
        function parseLooseVote(s) {
          try { return JSON.parse(s); } catch {}
          try {
            const fixed = s.replace(/([{,\[]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
            return JSON.parse(fixed);
          } catch {}
          try {
            const fixed2 = s.replace(/'/g, '"').replace(/([{,\[]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
            return JSON.parse(fixed2);
          } catch {}
          return null;
        }
        const voteObj = parseLooseVote(rawVote);
        if (voteObj === null) {
          console.error('vote 參數必須是合法 JSON');
          process.exit(1);
        }
        // Normalize: accept both {id, target} and {voterId, targetId} formats
        const normalizedVotes = Array.isArray(voteObj)
          ? voteObj.map(v => ({ voterId: v.voterId ?? v.id, targetId: v.targetId ?? v.target }))
          : voteObj;
        const jsonInput = JSON.stringify(normalizedVotes);
        const jsonArg = shellQuote(jsonInput);
        const out = runGm(`vote ${jsonArg}`);
        const parsed = parseJsonOutput(out);
        const eliminated = parsed.eliminated ?? parsed.eliminatedPlayerId;
        const role = parsed.eliminatedRole ?? parsed.eliminatedPlayerRole;
        if (eliminated !== undefined && eliminated !== null) {
          console.log(`🗳️ P${eliminated} 被投票出局`);
        } else {
          console.log('🗳️ 無人被投票出局');
        }
        break;
      }
      case 'mason-chat': {
        const id = process.argv[3];
        const msg = process.argv[4] || '';
        if (!id || !msg) {
          console.error('Usage: gm-helper.mjs mason-chat <id> \'<message>\'');
          process.exit(1);
        }
        const msgArg = shellQuote(msg);
        const out = runGm(`mason-chat ${id} ${msgArg}`);
        try { parseJsonOutput(out); } catch {}
        console.log(`✅ P${id} 共有者私聊已記錄`);
        break;
      }
      case 'state': {
        const out = runGm('state');
        const data = parseJsonOutput(out);
        // data is snapshot directly: {day, phase, alivePlayers, deadPlayers, gameOver, winner}
        // Or possibly {state: {...}} for some commands, but state command returns snapshot directly
        const snapshot = data.state || data;
        const day = snapshot.day ?? 0;
        const phase = snapshot.phase ?? 'unknown';
        const aliveCount = Array.isArray(snapshot.alivePlayers) ? snapshot.alivePlayers.length : 0;
        const deadCount = Array.isArray(snapshot.deadPlayers) ? snapshot.deadPlayers.length : 0;
        const gameOver = snapshot.gameOver;
        const winner = snapshot.winner;

        const lines = [];
        lines.push(`📅 第 ${day} 天 - ${phaseToChinese(phase)}`);
        lines.push(`👥 存活：${aliveCount} 人`);
        lines.push(`💀 死亡：${deadCount} 人`);
        if (gameOver) {
          if (winner) {
            lines.push(`🏁 遊戲結束，勝利方：${teamToChinese(winner)}`);
          } else {
            lines.push('🏁 遊戲結束');
          }
        } else {
          lines.push('🎮 遊戲進行中');
        }
        console.log(lines.join('\n'));
        break;
      }
      default:
        console.error(`未知指令: ${command}. 可用: init, reset, night, speak, vote, state, start-day, mason-chat`);
        process.exit(1);
    }
  } catch (e) {
    handleError(e);
    process.exit(1);
  }
}

main();
