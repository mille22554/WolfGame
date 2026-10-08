/**
 * night-prompts.test.ts — 夜間會議 prompt 組裝純函式測試
 *
 * 驗證：段落順序、wolf vs mason 差異（夥伴標籤／任務行／「要有」行／進度 targets+狂人）、
 * memory 空時省略、白板格式、judge 編號、merge 標籤、extractStyle、
 * 以及 docs/strategy-prompt-variables.md 的遊戲規則／戰術提點／回覆內容要求／
 * 策略與發言任務段／judge 回覆內容要求／記憶合併逐字一致。
 * 不連 LLM、不做 I/O（僅在 verbatim 測試讀一次 docs 檔）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildJudgeMessages,
  buildMergeMessages,
  buildSpeechMessages,
  buildStrategyMessages,
  extractStyle,
  formatBoard,
  GAME_RULES,
  NO_WAIT_SUFFIX,
  PREFECTURE,
  SPEECH_REPLY,
  STRATEGY_REPLY_COMMON,
  TACTICAL_TIPS,
  withNoWait,
  type Meeting,
  type NightPromptCtx,
} from './night-prompts.js';

// ---------- fixtures ----------

const MASON_CTX: NightPromptCtx = {
  meeting: 'mason',
  nickname: '千尋',
  prefecture: PREFECTURE.chihiro,
  faction: '村人',
  role: '共有者',
  partners: ['裕子'],
  style: '說話有條理，語氣沉穩。',
  dayNo: 2,
  alive: ['千尋', '裕子', '健太', '美咲'],
  board: [{ from: '裕子', text: '明天我先拋話題。' }],
  memory: '第 1 夜：不 CO，觀察健太。',
};

const WOLF_CTX: NightPromptCtx = {
  meeting: 'wolf',
  nickname: '小晴',
  prefecture: PREFECTURE.koharu,
  faction: '人狼',
  role: '人狼',
  partners: ['健太', '良子'],
  style: '語氣直接，句子短。',
  dayNo: 1,
  alive: ['小晴', '健太', '良子', '千尋', '裕子', '美咲'],
  targets: ['千尋', '裕子', '美咲'],
  madman: '佐雪',
  board: [],
};

/** 取 user 內容中某 section（## heading 起，到下一個行首 ## 為止） */
function sectionOf(content: string, heading: string): string {
  const i = content.indexOf(heading);
  assert.ok(i >= 0, `section not found: ${heading}`);
  const next = content.indexOf('\n## ', i + heading.length);
  return content.slice(i, next === -1 ? content.length : next);
}

// ---------- 身分／system ----------

test('strategy：system 段＝身分＋行事風格（mason 逐字）', () => {
  const msgs = buildStrategyMessages(MASON_CTX);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.equal(
    msgs[0].content,
    `## 身分
你是「千尋」（日本長野縣人），村人陣營共有者。夥伴：裕子。
出身地只用於說話口吻，與人際關係無關

## 行事風格
說話有條理，語氣沉穩。`,
  );
});

test('strategy：wolf system 段用「隊友」標籤', () => {
  const msgs = buildStrategyMessages(WOLF_CTX);
  assert.ok(msgs[0].content.includes('你是「小晴」（日本京都府人），人狼陣營人狼。隊友：健太、良子。'));
  assert.ok(!msgs[0].content.includes('夥伴：'));
});

// ---------- 段落順序 ----------

test('strategy：user 段段落順序（規則→進度→記憶→任務→提點→回覆要求）', () => {
  const user = buildStrategyMessages(MASON_CTX)[1].content;
  const pos = (h: string) => {
    const i = user.indexOf(h);
    assert.ok(i >= 0, `missing section: ${h}`);
    return i;
  };
  assert.ok(
    pos('## 遊戲規則') < pos('## 進度') &&
      pos('## 進度') < pos('## 記憶') &&
      pos('## 記憶') < pos('## 任務') &&
      pos('## 任務') < pos('## 戰術提點') &&
      pos('## 戰術提點') < pos('## 回覆內容要求'),
  );
});

test('strategy：memory 為 undefined／空字串時省略「## 記憶」段', () => {
  const noMemory = buildStrategyMessages({ ...MASON_CTX, memory: undefined })[1].content;
  assert.ok(!noMemory.includes('## 記憶'));
  const emptyMemory = buildStrategyMessages({ ...MASON_CTX, memory: '' })[1].content;
  assert.ok(!emptyMemory.includes('## 記憶'));
  // 段落順序變成 進度 直接接 任務（sectionOf 的 slice 止於下一個 heading 前的換行）
  const progressEnd = sectionOf(noMemory, '## 進度').length;
  assert.ok(noMemory.slice(noMemory.indexOf('## 進度') + progressEnd).startsWith('\n## 任務'));
});

test('strategy：memory 非空時「## 記憶」段內容正確', () => {
  const user = buildStrategyMessages(MASON_CTX)[1].content;
  assert.ok(sectionOf(user, '## 記憶').includes('第 1 夜：不 CO，觀察健太。'));
});

// ---------- wolf vs mason 差異 ----------

test('strategy：mason 任務第一行與「要有」行', () => {
  const user = buildStrategyMessages(MASON_CTX)[1].content;
  const task = sectionOf(user, '## 任務');
  assert.ok(
    task.startsWith(
      '## 任務\n你需要擬定你與共有者夥伴於明日白天會議的行動策略，評估CO的利與弊，並推敲狼有可能的行動，試圖使己方陣營獲勝。',
    ),
  );
  const reply = sectionOf(user, '## 回覆內容要求');
  assert.ok(reply.includes('- 要有：明日目標、誰做什麼、對手兩種反應的應對。'));
});

test('strategy：wolf 任務第一行與「要有」行', () => {
  const user = buildStrategyMessages(WOLF_CTX)[1].content;
  const task = sectionOf(user, '## 任務');
  assert.ok(
    task.startsWith(
      '## 任務\n你需要與狼隊擬定今晚的刀人目標，評估各候選的利與弊，並推敲村方下一步可能的行動，試圖使己方陣營獲勝。',
    ),
  );
  const reply = sectionOf(user, '## 回覆內容要求');
  assert.ok(reply.includes('- 要有：今晚刀誰、票怎麼投、明天白天怎麼演。'));
});

test('strategy：wolf 進度含可刀目標與狂人句（全句逐字）', () => {
  const user = buildStrategyMessages(WOLF_CTX)[1].content;
  const progress = sectionOf(user, '## 進度');
  assert.ok(progress.includes('可刀目標：千尋、裕子、美咲（排除自己／狼隊／狂人）。'));
  assert.ok(progress.includes('狂人：佐雪（他不知道你們是誰，不可刀他）。'));
  assert.ok(progress.includes('對話紀錄：（無）'));
  assert.ok(!progress.includes('共有者會議'));
});

test('strategy：wolf 缺 madman 時省略狂人整句', () => {
  const user = buildStrategyMessages({ ...WOLF_CTX, madman: undefined })[1].content;
  const progress = sectionOf(user, '## 進度');
  assert.ok(!progress.includes('狂人：'));
  assert.ok(progress.includes('（排除自己／狼隊／狂人）。對話紀錄：'));
});

test('strategy：mason 進度沒有可刀目標／狂人句', () => {
  const user = buildStrategyMessages(MASON_CTX)[1].content;
  const progress = sectionOf(user, '## 進度');
  assert.ok(progress.includes('目前是第 2 夜的共有者會議。存活：千尋、裕子、健太、美咲。'));
  assert.ok(!progress.includes('可刀目標'));
  assert.ok(!progress.includes('狂人：'));
});

// ---------- 白板格式 ----------

test('formatBoard：空＝（無）；非空＝「第 N 句　{from}：「{text}」」逐句（句後全形空格）', () => {
  assert.equal(formatBoard([]), '（無）');
  assert.equal(
    formatBoard([
      { from: '千尋', text: '我先講。' },
      { from: '裕子', text: '我同意。' },
    ]),
    '第 1 句　千尋：「我先講。」\n第 2 句　裕子：「我同意。」',
  );
  // prompt 內嵌
  const user = buildStrategyMessages(MASON_CTX)[1].content;
  assert.ok(user.includes('對話紀錄：第 1 句　裕子：「明天我先拋話題。」'));
});

// ---------- 發言 prompt ----------

test('speech：段落順序＝規則→進度→策略→任務→回覆要求（不含戰術提點／記憶）', () => {
  const msgs = buildSpeechMessages(MASON_CTX, '策略：明天先聽健太怎麼說。');
  assert.equal(msgs.length, 2);
  const user = msgs[1].content;
  const pos = (h: string) => {
    const i = user.indexOf(h);
    assert.ok(i >= 0, `missing section: ${h}`);
    return i;
  };
  assert.ok(
    pos('## 遊戲規則') < pos('## 進度') &&
      pos('## 進度') < pos('## 你剛剛讀完最新發言後想的策略') &&
      pos('## 你剛剛讀完最新發言後想的策略') < pos('## 任務') &&
      pos('## 任務') < pos('## 回覆內容要求'),
  );
  assert.ok(user.includes('## 你剛剛讀完最新發言後想的策略\n策略：明天先聽健太怎麼說。'));
  assert.ok(!user.includes('## 戰術提點'));
  assert.ok(!user.includes('## 記憶'));
  // 發言版任務逐字
  const task = sectionOf(user, '## 任務');
  assert.ok(
    task.startsWith(
      '## 任務\n從你的策略裡挑出發言紀錄上還沒講過的新論點，或對舊論點的補充／修正，轉成一句接續目前局面的話。\n發言紀錄上已講過且無新角度的，不要再講，也不要替夥伴說完。',
    ),
  );
});

// ---------- judge ----------

test('judge：單一 user 訊息，N 篇策略 [1]..[N] 編號＋順序（不標作者、無身分段）', () => {
  const msgs = buildJudgeMessages(WOLF_CTX, ['策略甲', '策略乙', '策略丙']);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'user');
  const c = msgs[0].content;
  assert.ok(c.startsWith('以下是 3 篇策略（不標明作者）：\n[1]: 策略甲\n[2]: 策略乙\n[3]: 策略丙'));
  const pos = (h: string) => {
    const i = c.indexOf(h);
    assert.ok(i >= 0, `missing: ${h}`);
    return i;
  };
  assert.ok(
    pos('[3]: 策略丙') < pos('## 遊戲規則') &&
      pos('## 遊戲規則') < pos('## 進度') &&
      pos('## 進度') < pos('## 任務') &&
      pos('## 任務') < pos('## 回覆內容要求'),
  );
  assert.ok(c.includes('⑥ 有 rollout 推演'));
  assert.ok(c.includes('- 只回 JSON'));
  assert.ok(!c.includes('## 身分'));
  assert.ok(!c.includes('## 行事風格'));
});

// ---------- 記憶合併 ----------

test('merge：mason 標籤＝共有者、空舊記憶＝（無）；wolf 標籤＝人狼', () => {
  const masonMerge = buildMergeMessages('mason', '', '新策略X');
  assert.equal(masonMerge.length, 1);
  assert.equal(masonMerge[0].role, 'user');
  assert.ok(
    masonMerge[0].content.startsWith(
      '## 你既有的共有者夜間策略（記憶專區）\n（無）\n\n## 你剛擬的新策略（judge 已選中）\n新策略X',
    ),
  );
  assert.ok(
    masonMerge[0].content.includes(
      '## 任務\n把兩者整合成一份現行策略：保留仍成立的、更新被新策略推翻的、衝突只留一個並捨棄另一個。輸出整合版全文（條列，800 字內），不要解釋合併過程。',
    ),
  );

  const wolfMerge = buildMergeMessages('wolf', '舊狼策略', '新策略Y');
  assert.ok(
    wolfMerge[0].content.startsWith('## 你既有的人狼夜間策略（記憶專區）\n舊狼策略'),
  );
  assert.ok(wolfMerge[0].content.includes('## 你剛擬的新策略（judge 已選中）\n新策略Y'));
});

// ---------- extractStyle ----------

const SAMPLE_AGENTS = `# persona: chihiro

## 基本資料
- 中文名：千尋
- 年齡：50

## 性格與說話方式
說話有條理，先鋪過程、結論放最後。
語氣沉穩、不壓人。

## 說話範例
- 「例子一」
`;

test('extractStyle：只取「## 性格與說話方式」段（去 heading、trim，不含前後段）', () => {
  assert.equal(extractStyle(SAMPLE_AGENTS), '說話有條理，先鋪過程、結論放最後。\n語氣沉穩、不壓人。');
});

test('extractStyle：找不到 heading／空字串回 ""', () => {
  assert.equal(extractStyle('# persona: aoi\n\n## 基本資料\n- 中文名：葵\n'), '');
  assert.equal(extractStyle(''), '');
});

// ---------- withNoWait ----------

test('withNoWait：把 NO_WAIT_SUFFIX 附在最後一則 user 訊息（不修改原陣列）', () => {
  assert.equal(NO_WAIT_SUFFIX, '本輪不可 wait：請選 speak 或 ready。');
  const msgs = buildStrategyMessages(MASON_CTX);
  const before = msgs.map((m) => m.content);
  const noWait = withNoWait(msgs);
  assert.equal(noWait.length, msgs.length);
  assert.ok(noWait[1].content.endsWith(`\n${NO_WAIT_SUFFIX}`));
  assert.equal(msgs[1].content, before[1]); // 原訊息未被修改
  assert.equal(msgs[0].content, noWait[0].content);
});

// ---------- PREFECTURE ----------

test('PREFECTURE：15 個 character id 都有值，且已知值符合 docs 對照表', () => {
  const IDS = ['aoi', 'chihiro', 'futa', 'kenta', 'koharu', 'misaki', 'ren', 'rin', 'ryoko', 'sayuki', 'shinichi', 'shota', 'tatuya', 'yuko', 'yuma'];
  for (const id of IDS) assert.ok(PREFECTURE[id], `missing prefecture for ${id}`);
  assert.equal(PREFECTURE.chihiro, '長野縣');
  assert.equal(PREFECTURE.kenta, '福岡縣');
  assert.equal(PREFECTURE.misaki, '愛知縣');
  assert.equal(PREFECTURE.shota, '福岡縣');
});

// ---------- 與 docs 逐字一致 ----------

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC_PATH = join(REPO_ROOT, 'docs', 'strategy-prompt-variables.md');

/** 抓 doc 中 heading 之後的 code fence 內容（heading 行本身含在內，到下一個 ``` 為止）；
 *  fromHeading 可指定「在該 heading 之後找」以避免撞到同名標題。 */
function fenceLinesAfter(doc: string, heading: string, fromHeading: string | null): string[] {
  const lines = doc.split('\n');
  let base = 0;
  if (fromHeading !== null) {
    base = lines.findIndex((l) => l.trim() === fromHeading);
    assert.ok(base >= 0, `doc heading not found: ${fromHeading}`);
  }
  const idx = lines.findIndex((l, i) => i > base && l.trim() === heading);
  assert.ok(idx >= 0, `doc heading not found: ${heading}`);
  const out: string[] = [];
  for (let i = idx; i < lines.length; i++) {
    if (i > idx && lines[i].trimStart().startsWith('```')) break;
    out.push(lines[i]);
  }
  return out;
}

function assertEachLineVerbatim(constant: string, docLines: string[], label: string): void {
  const mine = constant.split('\n');
  for (const line of docLines) {
    assert.ok(mine.includes(line), `${label}: line not verbatim in constant: ${line}`);
  }
}

/** 抓 doc 中指定 section heading 之後的第一個 code fence 的完整行陣列（不含 ``` fence 行本身） */
function fenceBlockAfter(doc: string, sectionHeading: string): string[] {
  const lines = doc.split('\n');
  const base = lines.findIndex((l) => l.trim() === sectionHeading);
  assert.ok(base >= 0, `doc heading not found: ${sectionHeading}`);
  const fenceStart = lines.findIndex((l, i) => i > base && l.trimStart().startsWith('```'));
  assert.ok(fenceStart >= 0, `no code fence after doc heading: ${sectionHeading}`);
  const out: string[] = [];
  for (let i = fenceStart + 1; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('```')) break;
    out.push(lines[i]);
  }
  return out;
}

/** 在 fence 行陣列中，取指定 heading（含）到下一個 `## `／`### ` heading（不含）之間，並去掉尾端空白分隔行 */
function fenceSection(lines: string[], heading: string): string[] {
  const start = lines.findIndex((l) => l.trim() === heading);
  assert.ok(start >= 0, `fence section not found: ${heading}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith('## ') || t.startsWith('### ')) {
      end = i;
      break;
    }
  }
  const out = lines.slice(start, end);
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

/** 抓 doc 中 heading 之後、以 `prefix` 開頭的 bullet 行內 backtick 包住的文字（策略任務第一行在 docs 是 inline code bullet） */
function inlineCodeAfter(doc: string, heading: string, prefix: string): string {
  const lines = doc.split('\n');
  const base = lines.findIndex((l) => l.trim() === heading);
  assert.ok(base >= 0, `doc heading not found: ${heading}`);
  for (let i = base + 1; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith('## ') || t.startsWith('### ')) break; // 離開該 section
    if (t.startsWith(prefix)) {
      const m = lines[i].match(/^.*`(.*)`\s*$/);
      assert.ok(m !== null, `no inline code in doc line: ${lines[i]}`);
      if (m) return m[1];
    }
  }
  assert.fail(`doc line not found: ${prefix} (after ${heading})`);
}

test('verbatim：docs「## 戰術提點」fence 的每一行都逐字出現在 TACTICAL_TIPS', () => {
  const doc = readFileSync(DOC_PATH, 'utf8').replace(/\r\n/g, '\n');
  const lines = fenceLinesAfter(doc, '## 戰術提點', null);
  assert.ok(lines.length >= 20, `expected ≥20 lines, got ${lines.length}`);
  assertEachLineVerbatim(TACTICAL_TIPS, lines, 'TACTICAL_TIPS');
});

test('verbatim：docs 策略版「## 回覆內容要求」每一行都逐字出現在 STRATEGY_REPLY_COMMON', () => {
  const doc = readFileSync(DOC_PATH, 'utf8').replace(/\r\n/g, '\n');
  const lines = fenceLinesAfter(doc, '## 回覆內容要求', '## 策略 prompt');
  assert.ok(lines.length >= 8, `expected ≥8 lines, got ${lines.length}`);
  assertEachLineVerbatim(STRATEGY_REPLY_COMMON, lines, 'STRATEGY_REPLY_COMMON');
});

test('verbatim：docs 發言版「## 回覆內容要求」每一行都逐字出現在 SPEECH_REPLY', () => {
  const doc = readFileSync(DOC_PATH, 'utf8').replace(/\r\n/g, '\n');
  const lines = fenceLinesAfter(doc, '## 回覆內容要求', '## 發言 prompt');
  assert.ok(lines.length >= 20, `expected ≥20 lines, got ${lines.length}`);
  assertEachLineVerbatim(SPEECH_REPLY, lines, 'SPEECH_REPLY');
});

test('verbatim：docs「## 遊戲規則」fence 的每一行都逐字出現在 GAME_RULES', () => {
  const doc = readFileSync(DOC_PATH, 'utf8').replace(/\r\n/g, '\n');
  const lines = fenceLinesAfter(doc, '## 遊戲規則', null);
  assert.ok(lines.length === 12, `expected 12 lines, got ${lines.length}`);
  assertEachLineVerbatim(GAME_RULES, lines, 'GAME_RULES');
});

test('verbatim：docs 策略版「### 任務」共用行 fence 每一行都逐字出現在策略 prompt', () => {
  const doc = readFileSync(DOC_PATH, 'utf8').replace(/\r\n/g, '\n');
  const lines = fenceBlockAfter(doc, '### 任務');
  assert.ok(lines.length >= 5, `expected ≥5 lines, got ${lines.length}`);
  const masonUser = buildStrategyMessages(MASON_CTX)[1].content;
  const wolfUser = buildStrategyMessages(WOLF_CTX)[1].content;
  for (const line of lines) {
    assert.ok(masonUser.includes(line), `mason 策略共用行不逐字：${line}`);
    assert.ok(wolfUser.includes(line), `wolf 策略共用行不逐字：${line}`);
  }
});

test('verbatim：docs 策略版「### 任務」第一行（依會議，inline code）逐字出現在策略 prompt', () => {
  const doc = readFileSync(DOC_PATH, 'utf8').replace(/\r\n/g, '\n');
  const masonLine = inlineCodeAfter(doc, '### 任務', '- 共有者：');
  const wolfLine = inlineCodeAfter(doc, '### 任務', '- 狼：');
  assert.ok(buildStrategyMessages(MASON_CTX)[1].content.includes(masonLine), 'mason 任務第一行與 docs 不一致');
  assert.ok(buildStrategyMessages(WOLF_CTX)[1].content.includes(wolfLine), 'wolf 任務第一行與 docs 不一致');
});

test('verbatim：docs 發言 prompt「## 任務」段每一行都逐字出現在發言 prompt', () => {
  const doc = readFileSync(DOC_PATH, 'utf8').replace(/\r\n/g, '\n');
  const block = fenceBlockAfter(doc, '## 發言 prompt');
  const lines = fenceSection(block, '## 任務');
  assert.ok(lines.length >= 3, `expected ≥3 lines, got ${lines.length}`);
  const speechUser = buildSpeechMessages(MASON_CTX, '策略：明天先聽健太怎麼說。')[1].content;
  assertEachLineVerbatim(speechUser, lines, '發言任務段');
});

// 注意：docs judge「## 任務」段第 ④ 行與 code 不一致（docs「靈能只知道票死者的陣營」
// vs code「靈能只知道票死」），文案需先由 orchestrator 定奪，故只鎖「## 回覆內容要求」段。
test('verbatim：docs judge「## 回覆內容要求」fence 每一行都逐字出現在 judge prompt', () => {
  const doc = readFileSync(DOC_PATH, 'utf8').replace(/\r\n/g, '\n');
  const block = fenceBlockAfter(doc, '## judge prompt');
  const lines = fenceSection(block, '## 回覆內容要求');
  assert.ok(lines.length >= 4, `expected ≥4 lines, got ${lines.length}`);
  const judgeUser = buildJudgeMessages(WOLF_CTX, ['策略甲', '策略乙', '策略丙'])[0].content;
  assertEachLineVerbatim(judgeUser, lines, 'JUDGE_TAIL 回覆內容要求');
});

test('verbatim：docs「## 記憶合併 prompt」fence 替換佔位後 == buildMergeMessages 輸出（含合併標題與 MERGE_TASK）', () => {
  const doc = readFileSync(DOC_PATH, 'utf8').replace(/\r\n/g, '\n');
  const block = fenceBlockAfter(doc, '## 記憶合併 prompt');
  assert.ok(block.length >= 8, `expected ≥8 lines, got ${block.length}`);
  const cases: [Meeting, string, string][] = [
    ['mason', '', '新策略X'],
    ['wolf', '舊狼策略', '新策略Y'],
  ];
  for (const [meeting, oldMemory, strategy] of cases) {
    const expected = block
      .join('\n')
      .replace('{{meetingLabel}}', meeting === 'mason' ? '共有者' : '人狼')
      .replace('{{memory 或「（無）」}}', oldMemory || '（無）')
      .replace('{{strategy}}', strategy);
    const actual = buildMergeMessages(meeting, oldMemory, strategy)[0].content;
    assert.equal(actual, expected, `${meeting} merge prompt 與 docs 不一致`);
  }
});
