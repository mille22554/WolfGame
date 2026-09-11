/**
 * memory.ts — 私有記憶層（機械式，無 LLM）
 *
 * 每天結束（ADVANCE_DAY）為每位玩家把「自己視角的一天」沉澝成 memory.md：
 * 我的發言、我的投票、我的夜間行動、狼會議我的發言與最終擊殺目標。
 * buildPrompt 的【你的私有記憶】區塊讀取它 → AI 跨天保有「我做過什麼」的連續性。
 *
 * 設計取捨：
 * - 機械式推導（純函式 builder）：零幻覺風險、零 LLM 成本、可單測
 * - 寫入走 getDataDir()（pkg 環境 exe 旁 data/ 可寫）；讀取 fallback resource root（dev 同源）
 * - 只記「事實」（誰說了/投了/殺了誰），不做主觀總結 — 主觀沉澱屬 external-accumulation-plan 範圍
 * - 整局保留：不設天數上限；單日發言取最後 5 則（防單日話癆膨脹 prompt）
 */
import type { GameState } from './types.js';
/** 單日發言保留上限（每人每天，防話癆膨脹） */
export declare const MEMORY_SPEECHES_PER_DAY = 5;
/**
 * 為單一玩家生成某天的記憶段（純函式）：
 * 我的白天發言 / 我的投票 / 我的夜間行動 / 我的狼會議發言與最終擊殺。
 * 只含該玩家自身視角的事實，不含他人私有資訊。
 */
export declare function buildDailyMemory(state: GameState, playerId: number, day: number): string;
/** memory 檔內容（純函式）：多天記憶段組合，整局保留（不設天數上限） */
export declare function buildMemoryContent(state: GameState, playerId: number, days: number[]): string;
/** memory 檔案路徑：與 character/ 源結構同位（<base>/character/<personaId>/memory.md）。
 * 寫入走 dataDir（dev＝repo 根＝源文件本身；pkg＝exe 旁 data/ 可寫）；
 * 與 GM 流程慣例一致：直接寫 character/<id>/memory.md，不另設目錄。 */
export declare function memoryFilePath(personaId: string, dataDir?: string): string;
/** 寫入單一玩家 memory（覆寫） */
export declare function writeMemory(personaId: string, content: string, dataDir?: string): void;
/** 清空單一玩家 memory（新局） */
export declare function clearMemory(personaId: string, dataDir?: string): void;
/**
 * 讀取單一玩家 memory：優先 dataDir（運行期寫入處），無檔則 fallback resource root
 * （dev 環境兩者同源，即同一檔案；pkg 環境 character/ 打包唯讀，運行期記憶在 data/character/ 下覆蓋）
 */
export declare function readMemory(personaId: string, dataDir?: string): string;
//# sourceMappingURL=memory.d.ts.map