/**
 * novelty.ts — 新穎性懲罰（純函式）
 *
 * 綜合相似度 = 0.7 × bigramJaccard + 0.3 × pNumberOverlap
 * 新穎性懲罰 = min(3, 5 × maxSim)，範圍 [0, 3]
 */
function bigrams(s) {
    const set = new Set();
    for (let i = 0; i + 1 < s.length; i++) {
        set.add(s.slice(i, i + 2));
    }
    return set;
}
/** 字元 bigram Jaccard 相似度 [0,1]；任一為空 → 0 */
export function bigramJaccard(a, b) {
    const setA = bigrams(a);
    const setB = bigrams(b);
    if (setA.size === 0 || setB.size === 0)
        return 0;
    let inter = 0;
    for (const g of setA) {
        if (setB.has(g))
            inter++;
    }
    const union = setA.size + setB.size - inter;
    if (union === 0)
        return 0;
    return inter / union;
}
function pNumbers(s) {
    const set = new Set();
    const re = /P(\d+)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        set.add(parseInt(m[1], 10));
    }
    return set;
}
/** P 編號重疊率 [0,1]（兩者皆無 P 編號 → 0） */
export function pNumberOverlap(a, b) {
    const setA = pNumbers(a);
    const setB = pNumbers(b);
    if (setA.size === 0 && setB.size === 0)
        return 0;
    let inter = 0;
    for (const n of setA) {
        if (setB.has(n))
            inter++;
    }
    const union = new Set([...setA, ...setB]).size;
    if (union === 0)
        return 0;
    return inter / union;
}
/** 綜合相似度 = 0.7 × bigramJaccard + 0.3 × pNumberOverlap */
export function similarity(a, b) {
    return 0.7 * bigramJaccard(a, b) + 0.3 * pNumberOverlap(a, b);
}
/** 新穎性懲罰 = min(3, 5 × maxSim)，maxSim 對 recentMessages 取最大；無歷史 → 0 */
export function noveltyPenalty(text, recentMessages) {
    if (recentMessages.length === 0)
        return 0;
    let maxSim = 0;
    for (const m of recentMessages) {
        const s = similarity(text, m);
        if (s > maxSim)
            maxSim = s;
    }
    return Math.min(3, 5 * maxSim);
}
//# sourceMappingURL=novelty.js.map