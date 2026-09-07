#!/usr/bin/env node
// scripts/build-pkg.mjs — esbuild CJS bundle + pkg 打包
// 1. 前置：npm run build（tsc）已產出 dist/
// 2. esbuild bundle（排除 node-llama-cpp / llamacpp.js）
// 3. 驗證 bundle 不含 node-llama-cpp
// 4. pkg → dist-pkg/WerewolfGame.exe
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

const run = (cmd) => {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', shell: true });
};

run('npm run build');

run(
  'npx esbuild src/entry.ts --bundle --platform=node --format=cjs --target=node18 ' +
    '--outfile=dist-pkg/WerewolfGame.cjs ' +
    '--external:node-llama-cpp --external:./llamacpp.js ' +
    '--external:bufferutil --external:utf-8-validate ' +
    '--log-level=warning',
);

const bundle = fs.readFileSync('dist-pkg/WerewolfGame.cjs', 'utf-8');
if (bundle.includes('node-llama-cpp')) {
  throw new Error('bundle 含 node-llama-cpp！');
}
console.log('✅ bundle 檢查通過（無 node-llama-cpp）');

run('npx pkg dist-pkg/WerewolfGame.cjs --config pkg.config.json');

if (!fs.existsSync('dist-pkg/WerewolfGame.exe')) {
  throw new Error('找不到產物 dist-pkg/WerewolfGame.exe');
}
const sizeMb = (fs.statSync('dist-pkg/WerewolfGame.exe').size / 1024 / 1024).toFixed(1);
console.log(`✅ 打包完成：dist-pkg/WerewolfGame.exe（${sizeMb} MB）`);
