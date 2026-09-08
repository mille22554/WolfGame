#!/usr/bin/env node
// scripts/patch-gui.mjs — 將 pkg 產出的 Windows exe 從 CONSOLE subsystem 改為 WINDOWS GUI subsystem
// 原理：修改 PE Optional Header 的 Subsystem 欄位（3=CUI → 2=GUI），雙擊不再開 CMD 黑窗。
// 注意：GUI subsystem 下 console.log 會被靜默丟棄（stdout/stderr 無效），process.exit 正常。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const exeDir = path.resolve(here, '..', 'dist-pkg');

const files = fs.readdirSync(exeDir).filter((f) => f.endsWith('.exe'));
if (files.length === 0) {
  console.warn('[patch-gui] dist-pkg 下沒有 .exe，跳過');
  process.exit(0);
}

for (const file of files) {
  const exePath = path.join(exeDir, file);
  const buf = Buffer.from(fs.readFileSync(exePath));

  const peOffset = buf.readUInt32LE(0x3c);
  // 驗證 PE 簽章 "PE\0\0"
  if (buf.readUInt32LE(peOffset) !== 0x00004550) {
    console.warn(`[patch-gui] ${file}: 無效 PE 簽章，跳過`);
    continue;
  }

  const subsystemOffset = peOffset + 0x5c; // PE + 4(簽章) + 20(COFF) + 68(Optional Header 內 Subsystem)
  const current = buf.readUInt16LE(subsystemOffset);

  if (current === 3) {
    // IMAGE_SUBSYSTEM_WINDOWS_CUI (3) → IMAGE_SUBSYSTEM_WINDOWS_GUI (2)
    buf.writeUInt16LE(2, subsystemOffset);
    // 清除 PE checksum（改動後已無效；未簽章 exe Windows 不強制檢查）
    buf.writeUInt32LE(0, peOffset + 4 + 20 + 64);
    fs.writeFileSync(exePath, buf);
    console.log(`[patch-gui] ${file}: CONSOLE → GUI ✓`);
  } else if (current === 2) {
    console.log(`[patch-gui] ${file}: 已是 GUI subsystem`);
  } else {
    console.warn(`[patch-gui] ${file}: 意外 subsystem 值 ${current}，跳過`);
  }
}