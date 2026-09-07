/**
 * Utility Functions
 */
/**
 * 唯讀資源根（character/ 等唯讀資源讀取用；同舊 getProjectRoot）
 */
export declare function getResourceRoot(): string;
/**
 * 專案根目錄：以模組自身位置（src/ 或 dist/ 的上一層）定位，
 * 而非 process.cwd()，避免從其他目錄執行時找不到資源
 */
export declare function getProjectRoot(): string;
/**
 * 可寫資料目錄（存檔等寫入用）
 * - pkg 環境（`process.pkg` 存在）：exe 旁 `data/`，探測可寫性；不可寫 → fallback `%APPDATA%/WerewolfGame`
 * - dev 環境：專案根
 */
export declare function getDataDir(): string;
/**
 * Fisher-Yates shuffle
 */
export declare function shuffleArray<T>(array: T[]): T[];
/**
 * Prompt user for input in CLI
 */
export declare function prompt(question: string): Promise<string>;
/**
 * Random integer [min, max] inclusive
 */
export declare function randomInt(min: number, max: number): number;
/**
 * Pick random element from array
 */
export declare function pickRandom<T>(array: T[]): T;
/**
 * Pick random element from array, excluding certain elements
 */
export declare function pickRandomExcluding<T>(array: T[], exclude: T[]): T | null;
/**
 * Count occurrences in array
 */
export declare function countOccurrences<T>(array: T[]): Map<T, number>;
/**
 * Find player by ID
 */
export declare function findPlayerById<T extends {
    id: number;
}>(players: T[], id: number): T | undefined;
/**
 * Sleep for milliseconds
 */
export declare function sleep(ms: number): Promise<void>;
/**
 * Format player list for display
 */
export declare function formatPlayerList(players: {
    id: number;
    name: string;
    alive: boolean;
}[]): string;
/**
 * Get majority threshold for voting
 */
export declare function getMajorityThreshold(aliveCount: number): number;
/**
 * Check if vote has majority
 */
export declare function hasMajority(votes: number, aliveCount: number): boolean;
//# sourceMappingURL=utils.d.ts.map