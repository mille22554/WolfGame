/**
 * novelty.ts — 新穎性懲罰（純函式）
 *
 * 綜合相似度 = 0.7 × bigramJaccard + 0.3 × pNumberOverlap
 * 新穎性懲罰 = min(3, 5 × maxSim)，範圍 [0, 3]
 */
/** 字元 bigram Jaccard 相似度 [0,1]；任一為空 → 0 */
export declare function bigramJaccard(a: string, b: string): number;
/** P 編號重疊率 [0,1]（兩者皆無 P 編號 → 0） */
export declare function pNumberOverlap(a: string, b: string): number;
/** 綜合相似度 = 0.7 × bigramJaccard + 0.3 × pNumberOverlap */
export declare function similarity(a: string, b: string): number;
/** 新穎性懲罰 = min(3, 5 × maxSim)，maxSim 對 recentMessages 取最大；無歷史 → 0 */
export declare function noveltyPenalty(text: string, recentMessages: string[]): number;
//# sourceMappingURL=novelty.d.ts.map