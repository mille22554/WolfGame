#!/usr/bin/env node
// scripts/pkg-smoke.mjs — exe 冒煙測試（mock 模式全鏈路）
// 1. 確認 dist-pkg/WerewolfGame.exe 存在
// 2. spawn exe（LLM_PROVIDER=mock, OPEN_BROWSER=0, PORT=0, ZERO_CLIENT_SHUTDOWN_MS=60000）
// 3. 讀 stdout 等「啟動：http://localhost:PORT」→ 解析 port
// 4. fetch / → 200（public/ 資產從 snapshot 可讀）
// 5. ws 連線 → 收 SNAPSHOT → 等 discussionLog ≥ 1（character/ + engine + scheduler + ws 全鏈路）
//    註：server 既有 ping 邏輯會在 ~30s 斷開沉默客戶端（與 dev 一致），
//    故比照前端 main.js onclose 重連行為：斷線即重連，持續等到 180s 預算用完。
// 6. 乾淨退出：POSIX 送 SIGTERM（exit 0）；Windows 訊號無法觸發 handler，
//    改由 WS 送 LEAVE（最後 client → orderly shutdown → exit 0）。
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { WebSocket } from 'ws';

const EXE = 'dist-pkg/WerewolfGame.exe';

function fail(child, reason) {
  console.error(`❌ smoke 失敗：${reason}`);
  console.error('--- stdout 尾部 ---');
  console.error((child.stdoutTail ?? []).slice(-30).join('\n'));
  console.error('--- stderr 尾部 ---');
  console.error((child.stderrTail ?? []).slice(-30).join('\n'));
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  process.exit(1);
}

if (!fs.existsSync(EXE)) {
  console.error(`❌ 找不到 ${EXE}，請先執行 npm run build:pkg`);
  process.exit(1);
}

const child = spawn(EXE, [], {
  env: {
    ...process.env,
    LLM_PROVIDER: 'mock',
    OPEN_BROWSER: '0',
    PORT: '0',
    ZERO_CLIENT_SHUTDOWN_MS: '60000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
child.stdoutTail = [];
child.stderrTail = [];
child.stdout.on('data', (d) => {
  const lines = String(d).split('\n');
  for (const l of lines) {
    child.stdoutTail.push(l);
    if (child.stdoutTail.length > 100) child.stdoutTail.shift();
  }
  process.stdout.write(d);
});
child.stderr.on('data', (d) => {
  const lines = String(d).split('\n');
  for (const l of lines) {
    child.stderrTail.push(l);
    if (child.stderrTail.length > 100) child.stderrTail.shift();
  }
  process.stderr.write(d);
});

// 等 stdout 出現 localhost:PORT
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('等 exe 啟動逾時（30s）')), 30000);
  const onData = (d) => {
    const m = String(d).match(/localhost:(\d+)/);
    if (m) {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve(Number(m[1]));
    }
  };
  child.stdout.on('data', onData);
  child.once('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`exe 提前退出（code=${code}）`));
  });
}).catch((err) => {
  fail(child, err.message);
});
console.log(`✅ exe 啟動，port=${port}`);

// HTTP 200（public/ 從 snapshot 可讀）
const httpRes = await fetch(`http://localhost:${port}/`);
if (httpRes.status !== 200) fail(child, `GET / → ${httpRes.status}（期望 200）`);
const html = await httpRes.text();
if (!html.includes('人狼')) fail(child, '首頁內容異常（缺 人狼 字樣）');
console.log('✅ HTTP / → 200');

// WS：等 discussionLog ≥ 1（斷線即重連，180s 總預算）
let leaveWs = null;
await new Promise((resolve, reject) => {
  const deadline = Date.now() + 180000;
  let done = false;
  const connect = () => {
    if (done) return;
    if (Date.now() >= deadline) {
      reject(new Error('等 discussionLog 逾時（180s）'));
      return;
    }
    const ws = new WebSocket(`ws://localhost:${port}`);
    leaveWs = ws;
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG' }));
          return;
        }
        if (msg.type === 'SNAPSHOT' && msg.snapshot?.discussionLog?.length >= 1) {
          done = true;
          resolve();
        }
      } catch {
        /* ignore */
      }
    });
    ws.on('close', () => {
      leaveWs = null;
      if (!done) setTimeout(connect, 1000); // 比照前端重連
    });
    ws.on('error', () => {
      // close 事件隨後觸發重連
    });
  };
  connect();
}).catch((err) => {
  fail(child, err.message);
});
console.log('✅ WS 收到 discussionLog ≥ 1（engine + scheduler + ws 全鏈路）');

// 乾淨退出
const waitExit = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

if (process.platform === 'win32') {
  // Windows：訊號無法觸發 handler（TerminateProcess 直接終止），改由 WS 送 LEAVE 觸發 orderly shutdown
  try {
    leaveWs?.send(JSON.stringify({ type: 'LEAVE' }));
  } catch {
    /* ignore */
  }
  const exitCode = await waitExit(15000);
  if (exitCode === null) fail(child, 'LEAVE 後 15s 未退出');
  if (exitCode !== 0) fail(child, `exit code=${exitCode}（期望 0）`);
} else {
  child.kill('SIGTERM');
  const exitCode = await waitExit(15000);
  if (exitCode === null) fail(child, 'SIGTERM 後 15s 未退出');
  if (exitCode !== 0) fail(child, `exit code=${exitCode}（期望 0）`);
}
console.log('✅ exe 乾淨退出（exit 0）');
console.log('🎉 smoke:pkg 通過');
