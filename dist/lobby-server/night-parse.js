/**
 * night-parse.ts — 統一夜間會議 loop（§12.3）的純函數解析器（server 端，無 I/O）
 *
 * 格式契約（逐字以 docs/strategy-prompt-variables.md 為準）：
 * - 策略輸出第一行：`status: speak|wait|ready`＋一句理由
 * - speak：第一行之後的策略主文必須 > STRATEGY_BODY_MIN
 * - wait／ready：正文必須 ≤ STRATEGY_BODY_MIN（不出策略文）
 * - 不合格 → 整份重生，最多 MAX_STRATEGY_ATTEMPTS 次；仍不合格視為 wait
 *
 * judge 輸出（§12.3 ③，1-based `best`）：`{"scores":[n,...],"best":N}`
 */
/** 策略主文最小字數：speak 須 > 150；wait／ready 須 ≤ 150 */
export const STRATEGY_BODY_MIN = 150;
/** 策略不合格整份重生的最大次數 */
export const MAX_STRATEGY_ATTEMPTS = 3;
const STATUS_RE = /^status:\s*(speak|wait|ready)\b/i;
/** reason 開頭允許的標點（去除後再 trim） */
const LEADING_PUNCT_RE = /^[（(—\-:：｜|]+/;
function toLines(text) {
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}
/**
 * 解析策略輸出。
 * 規則：trim；切行並捨去空行；第一行須 match `status:`；
 * speak 正文 > STRATEGY_BODY_MIN；wait/ready 正文 ≤ STRATEGY_BODY_MIN。
 */
export function parseStrategy(text) {
    const lines = toLines(text);
    const m = lines[0] ? STATUS_RE.exec(lines[0]) : null;
    if (!m)
        return { ok: false, error: 'missing status line' };
    const status = m[1].toLowerCase();
    const reason = lines[0]
        .slice(m[0].length)
        .trim()
        .replace(LEADING_PUNCT_RE, '')
        .trim();
    const body = lines.slice(1).join('\n');
    if (status === 'speak' && body.length <= STRATEGY_BODY_MIN) {
        return { ok: false, error: 'speak 但無策略文' };
    }
    if (status !== 'speak' && body.length > STRATEGY_BODY_MIN) {
        return { ok: false, error: `${status} 但帶策略文` };
    }
    return { ok: true, status, reason, body };
}
/** 去掉第一行 status 行（若有），回傳剩餘文字（trim）；發言失敗時作為發布 fallback。 */
export function strategyBody(text) {
    const lines = toLines(text);
    if (lines.length > 0 && STATUS_RE.test(lines[0]))
        lines.splice(0, 1);
    return lines.join('\n').trim();
}
/** 取出 text 中第一個合法 JSON object（支援巢狀與前後散文）；找不到回 null。 */
function firstJsonObject(text) {
    let idx = text.indexOf('{');
    while (idx !== -1) {
        let depth = 0;
        let end = -1;
        for (let i = idx; i < text.length; i++) {
            const ch = text[i];
            if (ch === '{')
                depth++;
            else if (ch === '}' && --depth === 0) {
                end = i;
                break;
            }
        }
        if (end === -1)
            return null;
        const candidate = text.slice(idx, end + 1);
        let parsed;
        try {
            parsed = JSON.parse(candidate);
        }
        catch {
            parsed = null;
        }
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
        idx = text.indexOf('{', idx + 1);
    }
    return null;
}
/**
 * 解析 judge 輸出為被選中策略的 0-based index。
 * 優先序：合法 `best`（1-based，1..n）→ `scores`（長度 n 的數組）取最高分（同分取第一個）→ -1。
 * 永不拋錯；-1 由呼叫方 random fallback。
 */
export function parseJudge(text, n) {
    if (n < 1)
        return -1;
    const data = firstJsonObject(text);
    if (!data)
        return -1;
    const best = data.best;
    if (typeof best === 'number' && Number.isInteger(best) && best >= 1 && best <= n) {
        return best - 1;
    }
    const scores = data.scores;
    if (Array.isArray(scores) &&
        scores.length === n &&
        scores.every((s) => typeof s === 'number' && Number.isFinite(s))) {
        let idx = 0;
        for (let i = 1; i < n; i++) {
            if (scores[i] > scores[idx])
                idx = i;
        }
        return idx;
    }
    return -1;
}
//# sourceMappingURL=night-parse.js.map