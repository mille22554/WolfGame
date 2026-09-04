#!/usr/bin/env node
/**
 * 原子 lock 輔助腳本，供會議參與者序列化白板寫入。
 *
 * Usage:
 *   node meeting-lock.mjs acquire <lockFile>        — 嘗試取得 lock（成功 exit 0，失敗 exit 1）
 *   node meeting-lock.mjs release <lockFile>        — 釋放 lock（exit 0）
 *   node meeting-lock.mjs wait   <lockFile> [ms]    — 等待 lock 釋放（預設 60s，超時 exit 2）
 *
 * lockFile 通常是 character/[白板名].lock
 * 例如: node meeting-lock.mjs acquire character/wolf-meeting.md.lock
 */
import { openSync, unlinkSync, accessSync, constants } from 'fs';
import { exit } from 'process';

const command = process.argv[2];
const lockFile = process.argv[3];

if (!command || !lockFile) {
  console.error('Usage: meeting-lock.mjs <acquire|release|wait> <lockFile> [timeoutMs]');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

switch (command) {
  case 'acquire': {
    try {
      openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      process.exit(0);
    } catch {
      process.exit(1);
    }
  }

  case 'release': {
    try {
      unlinkSync(lockFile);
    } catch {
      // lock 不存在也正常
    }
    process.exit(0);
  }

  case 'wait': {
    const timeout = parseInt(process.argv[4] || '60000', 10);
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        accessSync(lockFile, constants.F_OK);
        // lock 還在，繼續等
      } catch {
        // lock 已釋放
        process.exit(0);
      }
      await sleep(1000);
    }
    // 超時
    process.exit(2);
  }

  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
