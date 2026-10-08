/**
 * night-parse.test.ts — 夜間會議策略文字解析（validator）與 judge 輸出解析單元測試
 *
 * 純函數測試：不連 SGLang、不需要活 server。
 * 格式契約見 docs/strategy-prompt-variables.md「validator」「judge prompt」節。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_STRATEGY_ATTEMPTS,
  STRATEGY_BODY_MIN,
  parseJudge,
  parseStrategy,
  strategyBody,
} from './night-parse.js';

/** 測試用策略主文（固定 > 150 字，先自檢避免 fixture 退化） */
const LONG_BODY = [
  '1. 今晚刀健太，他昨天急着撇清，破綻最多。',
  '2. 白天票投美咲，先清外圍，別把火力集中在同一人。',
  '3. 明天我們都不主動發言，觀察誰先幫健太解圍，就順著那條線追。',
  '4. 若有人開始翻舊帳，就轉去談第一天的投票紀錄，把時間軸攤開。',
  '5. 收斂前互相確認一次票的方向，避免內耗，也別讓狂人看出口風。',
  '6. 若被反問動機，就回到發言紀錄上找實例，不要急著下結論。',
].join('\n');

test('常數：STRATEGY_BODY_MIN=150、MAX_STRATEGY_ATTEMPTS=3', () => {
  assert.equal(STRATEGY_BODY_MIN, 150);
  assert.equal(MAX_STRATEGY_ATTEMPTS, 3);
});

test('parseStrategy：合法 speak（正文 >150 字），reason 空字串、body 原樣回傳', () => {
  assert.ok(LONG_BODY.length > STRATEGY_BODY_MIN, 'fixture 正文必須 > 150 字');
  const r = parseStrategy(`status: speak\n${LONG_BODY}`);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.status, 'speak');
  assert.equal(r.reason, '');
  assert.equal(r.body, LONG_BODY);
});

test('parseStrategy：開頭空行不影響解析', () => {
  const r = parseStrategy('\n\nstatus: ready — 討論已足夠\n');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.status, 'ready');
  assert.equal(r.reason, '討論已足夠');
  assert.equal(r.body, '');
});

test('parseStrategy：大寫 STATUS 可辨識並歸一小寫', () => {
  const r = parseStrategy('STATUS: WAIT - 資訊還不夠\n');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.status, 'wait');
  assert.equal(r.reason, '資訊還不夠');
});

test('parseStrategy：缺 status 第一行 → 不合格', () => {
  const r = parseStrategy('我想先觀察一下討論走向，不急着發言。');
  assert.deepEqual(r, { ok: false, error: 'missing status line' });
});

test('parseStrategy：空文字（只有空白行）→ 不合格', () => {
  assert.deepEqual(parseStrategy('   \n  '), { ok: false, error: 'missing status line' });
});

test('parseStrategy：speak 但正文 ≤150 字 → 「speak 但無策略文」', () => {
  const r = parseStrategy('status: speak\n我有兩句話想說。');
  assert.deepEqual(r, { ok: false, error: 'speak 但無策略文' });
});

test('parseStrategy：wait 帶長正文（>150 字）→ 「wait 但帶策略文」', () => {
  assert.deepEqual(parseStrategy(`status: wait\n${LONG_BODY}`), {
    ok: false,
    error: 'wait 但帶策略文',
  });
});

test('parseStrategy：ready 帶長正文（>150 字）→ 「ready 但帶策略文」', () => {
  assert.deepEqual(parseStrategy(`status: ready\n${LONG_BODY}`), {
    ok: false,
    error: 'ready 但帶策略文',
  });
});

test('parseStrategy：ready 帶短理由（｜ 開頭標點被去掉）合法', () => {
  const r = parseStrategy('status: ready｜已收斂，可以定票了');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.status, 'ready');
  assert.equal(r.reason, '已收斂，可以定票了');
  assert.equal(r.body, '');
});

test('parseStrategy：邊界——正文恰好 150 字：speak 不合格、wait 合格', () => {
  const body150 = '字'.repeat(STRATEGY_BODY_MIN);
  assert.equal(body150.length, 150);
  assert.deepEqual(parseStrategy(`status: speak\n${body150}`), {
    ok: false,
    error: 'speak 但無策略文',
  });
  const ok = parseStrategy(`status: wait\n${body150}`);
  assert.equal(ok.ok, true);
});

test('strategyBody：去掉第一行 status 行，回傳剩餘主文', () => {
  assert.equal(
    strategyBody('status: speak\n- 刀健太\n- 白天票美咲\n'),
    '- 刀健太\n- 白天票美咲',
  );
});

test('strategyBody：status 行帶標點也照樣去掉', () => {
  assert.equal(strategyBody('status: speak｜開始\nline one\nline two'), 'line one\nline two');
});

test('strategyBody：第一行非 status 行 → 全文原樣回傳（trim）', () => {
  assert.equal(strategyBody('  就照這個辦。  \n'), '就照這個辦。');
});

test('parseJudge：best=1 → index 0', () => {
  assert.equal(parseJudge('{"scores":[3,7],"best":1}', 2), 0);
});

test('parseJudge：best=3（共 3 篇）→ index 2', () => {
  assert.equal(parseJudge('{"scores":[5,2,8],"best":3}', 3), 2);
});

test('parseJudge：best 超範圍 → 落回最高分', () => {
  assert.equal(parseJudge('{"scores":[4,9,6],"best":5}', 3), 1);
});

test('parseJudge：best=0（非 1-based 合法值）→ 落回最高分', () => {
  assert.equal(parseJudge('{"best":0,"scores":[1,2]}', 2), 1);
});

test('parseJudge：best 非數字 → 落回最高分', () => {
  assert.equal(parseJudge('{"scores":[1,5],"best":"1"}', 2), 1);
});

test('parseJudge：最高分同分 → 取第一個', () => {
  assert.equal(parseJudge('{"scores":[7,7,2],"best":9}', 3), 0);
});

test('parseJudge：無 best 且無 scores → -1', () => {
  assert.equal(parseJudge('{"note":"無法判斷"}', 3), -1);
});

test('parseJudge：scores 長度與 n 不符 → -1', () => {
  assert.equal(parseJudge('{"scores":[1,2,3,4],"best":9}', 3), -1);
});

test('parseJudge：垃圾文字（無 JSON）→ -1', () => {
  assert.equal(parseJudge('我比較傾向第二篇，但說不出理由。', 3), -1);
  assert.equal(parseJudge('', 2), -1);
  assert.equal(parseJudge('{"scores":[],"best":1}', 0), -1);
});

test('parseJudge：JSON 嵌在散文裡', () => {
  assert.equal(parseJudge('評完了。\n{"scores":[2,8,4],"best":2}\n以上。', 3), 1);
});

test('parseJudge：前面有非法 JSON 片段不擋住真正的結果', () => {
  assert.equal(parseJudge('附註：{這不是 JSON} {"scores":[9,3],"best":2}', 2), 1);
});
