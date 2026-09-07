/**
 * Utility Functions
 */

import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';

/**
 * 本模組所在目錄：
 * - ESM（tsc dev）：import.meta.url
 * - esbuild CJS bundle（pkg exe）：import.meta 為空，改用 CJS __dirname
 *   （typeof 守衛避免 ESM 下 ReferenceError；此處不宣告同名區域變數以免遮蔽全域）
 */
const moduleDir: string = (() => {
  if (typeof __dirname === 'string') return __dirname;
  return path.dirname(fileURLToPath(import.meta.url));
})();

/**
 * 唯讀資源根（character/ 等唯讀資源讀取用；同舊 getProjectRoot）
 */
export function getResourceRoot(): string {
  return path.resolve(moduleDir, '..');
}

/**
 * 專案根目錄：以模組自身位置（src/ 或 dist/ 的上一層）定位，
 * 而非 process.cwd()，避免從其他目錄執行時找不到資源
 */
export function getProjectRoot(): string {
  return getResourceRoot();
}

/**
 * 可寫資料目錄（存檔等寫入用）
 * - pkg 環境（`process.pkg` 存在）：exe 旁 `data/`，探測可寫性；不可寫 → fallback `%APPDATA%/WerewolfGame`
 * - dev 環境：專案根
 */
export function getDataDir(): string {
  const procAny = process as unknown as { pkg?: unknown };
  if (procAny.pkg !== undefined) {
    const exeDir = path.dirname(process.execPath);
    const dataDir = path.join(exeDir, 'data');
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.accessSync(dataDir, fs.constants.W_OK);
      return dataDir;
    } catch {
      // fallback below
    }
    if (process.env.APPDATA) {
      const fb = path.join(process.env.APPDATA, 'WerewolfGame');
      fs.mkdirSync(fb, { recursive: true });
      return fb;
    }
    const fb = path.join(os.homedir(), '.werewolf-game');
    fs.mkdirSync(fb, { recursive: true });
    return fb;
  }
  return getResourceRoot();
}

/**
 * Fisher-Yates shuffle
 */
export function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Prompt user for input in CLI
 */
export async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Random integer [min, max] inclusive
 */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Pick random element from array
 */
export function pickRandom<T>(array: T[]): T {
  return array[randomInt(0, array.length - 1)];
}

/**
 * Pick random element from array, excluding certain elements
 */
export function pickRandomExcluding<T>(array: T[], exclude: T[]): T | null {
  const filtered = array.filter(item => !exclude.includes(item));
  if (filtered.length === 0) return null;
  return pickRandom(filtered);
}

/**
 * Count occurrences in array
 */
export function countOccurrences<T>(array: T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const item of array) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return counts;
}

/**
 * Find player by ID
 */
export function findPlayerById<T extends { id: number }>(players: T[], id: number): T | undefined {
  return players.find(p => p.id === id);
}

/**
 * Sleep for milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format player list for display
 */
export function formatPlayerList(players: { id: number; name: string; alive: boolean }[]): string {
  return players
    .map(p => `${p.name}${p.alive ? '' : ' ☠'}`)
    .join('、');
}

/**
 * Get majority threshold for voting
 */
export function getMajorityThreshold(aliveCount: number): number {
  return Math.floor(aliveCount / 2) + 1;
}

/**
 * Check if vote has majority
 */
export function hasMajority(votes: number, aliveCount: number): boolean {
  return votes >= getMajorityThreshold(aliveCount);
}