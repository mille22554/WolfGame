/**
 * ai-scheduler.ts — SpeechScheduler（白板更新驅動迴圈＋AI 決策 flag 收斂）
 *
 * 迴圈（用戶定案）：
 * - 白板更新 → 開工生產（未就緒 AI 除上輪發言者外全員草稿；已就緒者不再草稿）＋ CD 重啟。
 * - 生產完成 → 暫存，不直接播。
 * - CD 到有貨 → 播出（播出即白板更新，迴圈回去）。
 * - CD 到沒貨 → 等做好馬上播。
 * - 中間白板又更新 → 暫存作廢＋生產用新白板重跑＋CD 重啟（版本作廢沿用）。
 * - 同一時間只有一條生產線＋一個暫存位，不會疊跑。
 * - 生產失敗 → N 秒後重試（預設 60s，env SPEECH_RETRY_MS 可調）；重試前不播出、不推進掛機計數。
 * - 純 AI 局：CD=0，做好就播（計時器保留，只是 0ms）。
 * - quiet 整組拔除；跳過按鈕（HUMAN_SKIP／allAliveHumansSkipped）保留但 scheduler 不再依賴。
 *
 * 收斂（第 2 項）：
 * - 每輪未就緒 AI 除上輪發言者外寫草稿；候選為空不生產，等真人講話；唯一候選不斷線。
 * - 草稿結尾 flag 兩層解析（正規＋寬鬆決策語境關鍵字，不用 LLM）；剝離統一在收草稿回傳前，
 *   broadcast 前再洗一次 expand 輸出；flag 永不進白板。
 * - 安全閥：單一 AI 連續 maxUncertainRounds（預設 50）次資訊不足 → 強制 decided:abstain。
 * - AI decided 且其發言成功播出後 → enqueue AI_READY_VOTE（不帶版本；單向不退；標的可變覆蓋）；
 *   transition 統一檢查全員 ready → 直進投票（無 CLOSING）。
 */

import type { AIScheduler } from './engine.js';
import type { FlagStats, GameState, SchedulerContext } from './types.js';
import { Role } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import { getAlivePlayers, getAliveWerewolves } from './assignment.js';
import { stripSpeechPrefix } from './game-state.js';
import {
  buildPreSpeechPrompt, buildJudgePrompt, buildExpandPrompt, summarizeDay,
  buildWolfPreSpeechPrompt, buildWolfExpandPrompt, summarizeWolfDiscussion,
} from './character-session.js';
import { noveltyPenalty } from './novelty.js';
import { shuffleArray, getDataDir } from './utils.js';

// ============================================
// 決策 flag（兩層解析）
// ============================================

export type AIDecision =
  | { status: 'decided'; target: number | 'abstain' }
  | { status: 'uncertain' };

/** 安全閥：單一 AI 連續資訊不足次數上限（防卡死底線；只計真正資訊不足） */
export const MAX_UNCERTAIN_ROUNDS = 50;

/** 正規 flag：[決定:投P3]／[決定:殺P3]／[決定:棄票]／[決定:資訊不足]（方括號跳脫、全形/半形冒號、全域匹配） */
export const DECISION_FLAG_RE = /\[決定[:：](投P\s*\d+|殺P\s*\d+|棄票|資訊不足)\]/g;
const DECISION_TARGET_RE = /(?:投|殺)P\s*(\d+)/;
/** 狼目標正則（文本掃描＋漂移＋救回共用；group1 動詞+P、group2 對P下手/動手） */
const WOLF_TARGET_RE = /(?:殺|殺掉|攻擊|襲擊|針對|目標是|鎖定|盯住|盯著|盯上|盯緊|優先處理|先處理)\s*P\s*(\d+)|對\s*P\s*(\d+)\s*(?:下手|動手)/g;

/** 寬鬆層：決策語境的投 Pn（動詞＋編號才認，避免討論提及誤判） */
const LOOSE_VOTE_RES: RegExp[] = [
  /我投\s*P?\s*(\d+)/,
  /決定投\s*P?\s*(\d+)/,
  /要投\s*P?\s*(\d+)/,
  /打算投\s*P?\s*(\d+)/,
  /想要投\s*P?\s*(\d+)/,
  /會投\s*P?\s*(\d+)/,
  /準備投\s*P?\s*(\d+)/,
  /投票給\s*P?\s*(\d+)/,
  /決定殺\s*P?\s*(\d+)/,
  /要殺\s*P?\s*(\d+)/,
  /該殺\s*P?\s*(\d+)/,
  /先殺\s*P?\s*(\d+)/,
  /襲擊\s*P?\s*(\d+)/,
  /決定\s*[:：]?\s*殺\s*P?\s*(\d+)/,
];
const LOOSE_ABSTAIN_RE = /棄票|放棄投票|不投票|投棄權/;
const LOOSE_UNCERTAIN_RE = /資訊不足|無法決定|還不能決定|不能決定|不確定|還不確定|再觀察|多聽|還要聽|再聽聽|觀望|難以判斷|沒有想法|沒想法|還沒想法/;

/** 無方括號裸 flag 行尾（如模型漏寫括號的「…。決定:資訊不足」）：白板/草稿清洗用。
 *  行尾即剝離（整行是行尾特例）；句中提及（如「我決定投P3出去」）保留，避免誤傷正常發言。 */
const BARE_FLAG_LINE_RE = /決定\s*[:：]\s*(投P\s*\d+|殺P\s*\d+|棄票|資訊不足)\s*$/;

/**
 * 簡轉繁正規化：Qwen 訓練語料簡體主導，遊戲討論高頻詞（杀/说/对…）易混入簡體。
 * prompt 禁令只能降低頻率，殘留以確定性映射清洗（冪等，對繁體無操作）。
 * 映射表僅收遊戲語境無歧義字（如 只/面/里 在繁體有多種寫法，不收）。
 */
const SIMP_TO_TRAD: Record<string, string> = {
  杀: '殺', 发: '發', 对: '對', 个: '個', 说: '說', 话: '話',
  认: '認', 让: '讓', 过: '過', 这: '這', 进: '進', 远: '遠',
  运: '運', 时: '時', 实: '實', 现: '現', 务: '務', 汉: '漢',
  买: '買', 读: '讀', 听: '聽', 观: '觀', 觉: '覺', 见: '見',
  问: '問', 门: '門', 开: '開', 关: '關', 会: '會', 万: '萬',
  与: '與', 为: '為', 么: '麼', 来: '來', 点: '點', 边: '邊',
  还: '還', 选: '選', 惊: '驚', 险: '險', 队: '隊', 后: '後',
  劲: '勁', 怀: '懷', 证: '證', 确: '確', 据: '據', 辩: '辯', 护: '護',
  态: '態', 伪: '偽', 装: '裝', 潜: '潛', 吗: '嗎', 谎: '謊', 谨: '謹', 择: '擇',
  决: '決', 动: '動', 无: '無', 体: '體', 击: '擊', 别: '別', 着: '著', 优: '優', 处: '處', 围: '圍', 变: '變',
};
const SIMP_RE = new RegExp(`[${Object.keys(SIMP_TO_TRAD).join('')}]`, 'g');

export function normalizeTraditional(text: string): string {
  return text.replace(SIMP_RE, (ch) => SIMP_TO_TRAD[ch] ?? ch);
}

/** 剝離 flag（全域，一律在收草稿回傳前＋broadcast 前各洗一次；含無方括號裸 flag 行尾） */
export function stripDecisionFlags(text: string): string {
  return text
    .replace(DECISION_FLAG_RE, '')
    .split('\n')
    .map((line) => line.replace(BARE_FLAG_LINE_RE, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 兩層解析：先正規，失敗走寬鬆關鍵字；都抓不到 → uncertain（計入安全閥） */
export function parseDecisionFlag(text: string): AIDecision {
  DECISION_FLAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = DECISION_FLAG_RE.exec(text)) !== null) last = m;
  if (last) {
    const body = last[1];
    if (body === '棄票') return { status: 'decided', target: 'abstain' };
    if (body === '資訊不足') return { status: 'uncertain' };
    const tm = DECISION_TARGET_RE.exec(body);
    if (tm) return { status: 'decided', target: parseInt(tm[1], 10) };
    return { status: 'uncertain' };
  }
  // 裸旗標行尾版：同行前段文字即文本；整行獨佔且無他文才是白卷（交上游重試）
  const flagLines = text.split('\n').map((line) => line.trim());
  const bareHit = flagLines.find((line) => BARE_FLAG_LINE_RE.test(line));
  if (bareHit) {
    const inlineText = bareHit.replace(BARE_FLAG_LINE_RE, '').trim();
    const hasText = inlineText !== '' || flagLines.some((line) => line !== '' && line !== bareHit && !BARE_FLAG_LINE_RE.test(line));
    if (hasText) {
      const m = BARE_FLAG_LINE_RE.exec(bareHit);
      const body = m ? m[1] : '';
      if (body === '棄票') return { status: 'decided', target: 'abstain' };
      if (body === '資訊不足') return { status: 'uncertain' };
      const tm = DECISION_TARGET_RE.exec(body);
      if (tm) return { status: 'decided', target: parseInt(tm[1], 10) };
    }
  }
  for (const re of LOOSE_VOTE_RES) {
    const lm = re.exec(text);
    if (lm) return { status: 'decided', target: parseInt(lm[1], 10) };
  }
  if (LOOSE_ABSTAIN_RE.test(text)) return { status: 'decided', target: 'abstain' };
  if (LOOSE_UNCERTAIN_RE.test(text)) return { status: 'uncertain' };
  return { status: 'uncertain' };
}

/** grounding 黑名單種子：命中草稿文本即判違規（拒收＋重試；重試上限沿用既有；哲學：首夜保護優先，後夜誤傷接受） */
export const GROUNDING_VIOLATION_SEEDS = [
  '說謊', '藏陰謀', '有問題', '可疑', '不對勁', '怪怪的', '沒表達', '容易被忽略', '氣氛緊張',
  '嫌疑', '疑慮', '異常', '懷疑', '觀察其行為', '特別的表現', '藏了一些事情', '暗中觀察',
  '藏了一些什麼', '不太穩定', '奇怪', '動向', '沉默', '舉動', '不像村人', '可能是村人',
  '不太像村人', '關鍵人物', '行動比較獨立', '都不說話', '單薄', '有點孤獨', '藏有疑點', '異動', '孤僻',
];

/** 黑名單命中：回傳命中的種子，未命中回傳空字串（比對已正規化文本） */
export function findGroundingViolation(text: string): string {
  for (const seed of GROUNDING_VIOLATION_SEEDS) {
    if (text.includes(seed)) return seed;
  }
  return '';
}

/** 前科回寫：違規版（只帶最近一次被退；禁換皮重述） */
export function buildViolationRetryNote(prevDraft: string, hitSeed: string, isFirstNight: boolean): string {
  const context = isFirstNight
    ? '今晚沒有任何公開發言，你不可能知道任何人的事'
    : '只能引用討論中實際出現的發言';
  return `被退回的草稿：「${prevDraft}」／退回原因：含「${hitSeed}」——${context}。不得重複被退句中的任何指控，也不得以換皮說法（如疑慮、嫌疑、異常、昨晚的行動等）重述同一指控。只談你自己的狀態：沒想法、隨便指一個目標、跟票、或交棒。`;
}

/** 前科回寫：格式版（旗標解析 miss／缺旗標的重試；附正確範例） */
export function buildFormatRetryNote(prevDraft: string): string {
  return `被退回的草稿：「${prevDraft}」／退回原因：決定旗標必須是另起一行的 \`[決定:殺P編號]\` 或 \`[決定:資訊不足]\`（方括號不可少）。正確範例：我支持攻擊P3。\n[決定:殺P3]。文本與旗標一起重寫。`;
}

/** 明示旗標：方括號旗標或行尾裸旗標（重試觸發判斷用） */
function hasExplicitFlag(text: string): boolean {
  DECISION_FLAG_RE.lastIndex = 0;
  if (DECISION_FLAG_RE.test(text)) return true;
  return text.split('\n').some((line) => BARE_FLAG_LINE_RE.test(line));
}

/** 狼草稿拒收檢查結果 */
export interface WolfRejection { kind: 'grounding' | 'format' | 'lang' | 'target'; hit: string; note: string; }

/** 英文超標：ASCII 字母占比過半即拒（全英文拒、中英夾雜不過半放行） */
export function isEnglishHeavy(text: string): boolean {
  if (text.length === 0) return false;
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  return letters * 2 > text.length;
}

/** 前科回寫：英文版（英文超標／簡體混入共用；附格式提醒；pre 加自狀態指引，expand 不帶） */
export function buildLangRetryNote(prevDraft: string, selfState = false): string {
  const base = `被退回的草稿：「${prevDraft}」／退回原因：必須使用繁體中文，不得使用英文或簡體字。重寫。另：決定旗標必須另起一行（[決定:殺P編號]／[決定:資訊不足]），不得與文本同行。`;
  return selfState ? `${base}只談你自己的狀態：沒想法、隨便指一個目標、跟票、或交棒。` : base;
}

/** 前科回寫：自指版（附格式提醒） */
export function buildTargetRetryNote(prevDraft: string, playerId: number): string {
  return `被退回的草稿：「${prevDraft}」／退回原因：襲擊目標不能是你自己（P${playerId}），也不可是同盟。換個合法目標重寫。另：決定旗標必須另起一行（[決定:殺P編號]／[決定:資訊不足]），不得與文本同行。`;
}

/** 非法狼目標：自己／同盟／不存在或死亡 → 回傳 hit 說明，通過回傳空字串 */
export function illegalWolfTarget(st: GameState, playerId: number, targetId: number): string {
  if (targetId === playerId) return `自指P${playerId}`;
  const target = st.players.find((p) => p.id === targetId);
  if (!target || !target.alive) return `非法P${targetId}`;
  const allies = getAliveWerewolves(st.players).map((w) => w.id);
  if (allies.includes(targetId)) return `同盟P${targetId}`;
  return '';
}

/** 首夜捏造檢查：首夜出現昨晚的行動／行為／表現／發言、或白天持續行為描述即判虛構（後夜有公開紀錄不攔） */
export function findFirstNightFabrication(text: string): string { const m = /昨晚的(行動|行為|表現|發言)|白天(總是|一直|比較|從來|向來)/.exec(text); return m ? m[0] : ''; }

/** 簡體攔截：原文與正規化後不同即拒（回傳前科 note，空字串表通過） */
export function simplifiedRejection(rawRaw: string): string {
  if (rawRaw === normalizeTraditional(rawRaw)) return '';
  return buildLangRetryNote(rawRaw);
}

/** 英文短詞：ASCII 字母占比啟發式漏網的英文殘留，整詞命中即拒 */
const ENGLISH_WORDS = ['anyone', 'maybe', 'members', 'everyone', 'someone', 'ok', 'yes', 'no', 'please', 'thanks', 'targeting', 'behaviour', 'behavior', 'tonight'];

/** 英文短詞檢查：整詞命中回傳該詞，未命中回傳空字串 */
export function findEnglishWord(text: string): string {
  for (const w of ENGLISH_WORDS) {
    if (new RegExp(`\\b${w}\\b`, 'i').test(text)) return w;
  }
  return '';
}

/** 狼草稿拒收檢查：回傳前科回寫（含 kind/hit 供賬本），null 表通過 */
export function checkWolfDraft(raw: string, st: GameState, pid: number): WolfRejection | null {
  const firstNight = st.wolfDiscussionLog.length === 0 && st.discussionLog.length === 0;
  if (isEnglishHeavy(raw)) return { kind: 'lang', hit: '英文超標', note: buildLangRetryNote(raw, true) };
  const engWord = findEnglishWord(raw);
  if (engWord) return { kind: 'lang', hit: `英文短詞(${engWord})`, note: buildLangRetryNote(raw, true) };
  const hitSeed = findGroundingViolation(raw);
  if (hitSeed) {
    return { kind: 'grounding', hit: hitSeed, note: buildViolationRetryNote(raw, hitSeed, firstNight) };
  }
  if (firstNight) {
    const fab = findFirstNightFabrication(raw);
    if (fab) return { kind: 'grounding', hit: fab, note: buildViolationRetryNote(raw, fab, true) };
  }
  // 文本層目標掃描：文本點名即驗合法性（旗標之外第二道門；否定修飾低機率誤傷可接受）
  WOLF_TARGET_RE.lastIndex = 0;
  const textTarget = WOLF_TARGET_RE.exec(raw);
  if (textTarget) {
    const mentioned = parseInt(textTarget[1] ?? textTarget[2], 10);
    const badMention = illegalWolfTarget(st, pid, mentioned);
    if (badMention) return { kind: 'target', hit: badMention, note: buildTargetRetryNote(raw, pid) };
  }
  const parsed = parseDecisionFlag(raw);
  if (parsed.status === 'decided' && parsed.target !== 'abstain') {
    const badTarget = illegalWolfTarget(st, pid, parsed.target);
    if (badTarget) return { kind: 'target', hit: badTarget, note: buildTargetRetryNote(raw, pid) };
  }
  if (parsed.status === 'uncertain' && !hasExplicitFlag(raw)) {
    return { kind: 'format', hit: '缺旗標', note: buildFormatRetryNote(raw) };
  }
  return null;
}

/** expand 違規檢查：seed→fab（僅首夜）→eng 三層；回傳 kind/hit，null 表通過 */
export function checkExpandViolation(raw: string, firstNight: boolean): { kind: 'grounding' | 'lang'; hit: string } | null {
  const seed = findGroundingViolation(raw);
  if (seed) return { kind: 'grounding', hit: seed };
  if (firstNight) {
    const fab = findFirstNightFabrication(raw);
    if (fab) return { kind: 'grounding', hit: fab };
  }
  const eng = findEnglishWord(raw);
  if (eng) return { kind: 'lang', hit: `英文短詞(${eng})` };
  return null;
}

// ============================================
// 外部積累賬本 precedents.jsonl（跨局前科；append-only，上限 500 行砍最舊）
// ============================================

/** 賬本一行：拒收確定後記一筆；fixed 表重試是否改過自新 */
export interface PrecedentEntry {
  t: number; game: string; meeting: string; phase: string;
  kind: string; hit: string; who: string; text: string; fixed: boolean;
}

/** 賬本上限行數（超了砍最舊） */
export const PRECEDENTS_CAP = 500;
/** 賬本檔名（<dataDir> 下；已 gitignore） */
export const PRECEDENTS_FILE = 'precedents.jsonl';

/** 賬本路徑（可注入；預設 <dataDir>/precedents.jsonl） */
export function precedentsFile(dataDir?: string): string {
  return path.join(dataDir ?? getDataDir(), PRECEDENTS_FILE);
}

/** 賬本讀取（缺檔／壞行容錯） */
export function readPrecedents(file?: string): PrecedentEntry[] {
  const out: PrecedentEntry[] = [];
  let content: string;
  try {
    content = fs.readFileSync(file ?? precedentsFile(), 'utf-8');
  } catch { return out; }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as PrecedentEntry;
      if (obj && typeof obj === 'object') out.push(obj);
    } catch { /* 壞行跳過 */ }
  }
  return out;
}

/** 賬本寫入（append-only 語義；超上限砍最舊） */
export function appendPrecedents(entries: PrecedentEntry[], file?: string): void {
  if (entries.length === 0) return;
  const target = file ?? precedentsFile();
  const kept = [...readPrecedents(target), ...entries].slice(-PRECEDENTS_CAP);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${kept.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf-8');
}

/** 跨局 top-1：同 meeting＋同 phase 按 t 降冪（寫入序，不依賴文件序），own 優先、否則取最新 */
export function findCrossGamePrecedent(meeting: string, phase: string, persona: string, file?: string): PrecedentEntry | null {
  let all: PrecedentEntry[] = [];
  try {
    all = readPrecedents(file);
  } catch { return null; }
  const samePhase = all
    .filter((e) => e.meeting === meeting && e.phase === phase)
    .sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  for (const entry of samePhase) {
    if ((entry.who ?? '').split('/')[1] === persona) return entry;
  }
  return samePhase.length > 0 ? samePhase[0] : null;
}

/** 跨局句（改版：不再引前句全文，防模板抄襲；target 分支抽象化） */
export function buildCrossGameNote(entry: PrecedentEntry): string {
  if (entry.kind === 'grounding') return `過去同情境曾因含「${entry.hit}」的無源指控被退，不要重蹈（也不得以換皮說法重述同一指控）。`;
  if (entry.kind === 'target') return `過去同情境曾因點名同盟為襲擊目標被退，不要重蹈（也不得以「同盟P編號」等字樣在發言中提及同盟）。`;
  return `過去同情境曾有${entry.kind}問題（${entry.hit}）被退，不要重蹈。`;
}

// ============================================
// Scheduler
// ============================================

export interface SpeechSchedulerOptions {
  cdMs?: number;               // 預設 60000（真人節奏）；純 AI 局實際以 0 執行
  retryMs?: number;            // 生產失敗重試間隔，預設 60000（env SPEECH_RETRY_MS）
  preSpeechBatch?: number;     // 預設 3（平行預發言數，≤ worker contextCount）
  preSpeechTemp?: number;      // 預設 0.7
  judgeTemp?: number;          // 預設 0.3
  expandTemp?: number;         // 預設 0.8
  topK?: number;               // 已廢棄：SELECT 改價值制確定性取最高，不再抽籤（保留欄位免壞外部呼叫，實際未用）
  recentCompareCount?: number; // 預設 3（新穎性比較的最近訊息數）
  maxUncertainRounds?: number; // 安全閥，預設 50（測試可調小加速收斂）
  ledgerFile?: string;         // 賬本路徑覆寫（測試注入；預設 <dataDir>/precedents.jsonl）
}

interface Stash {
  playerId: number;
  text: string;
  boardVersion: number;
  decision: AIDecision;
}

interface Draft {
  slot: number;
  playerId: number;
  text: string;
  decision: AIDecision;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

// ============================================
// SELECT 價值制（確定性，不抽籤）
// ============================================

/** 指名正規式：內文含 P編號即算指名（發言人前綴已先剝離，不計入） */
const MENTION_RE = /P\d+/;

/** 草稿價值加分：decided＋具體數字目標 +3；內文含 P編號指名 +1（可疊加）；棄票／資訊不足 +0 */
export function draftValueBonus(draft: Draft): number {
  let bonus = 0;
  if (draft.decision.status === 'decided' && typeof draft.decision.target === 'number') bonus += 3;
  if (MENTION_RE.test(stripSpeechPrefix(draft.text))) bonus += 1;
  return bonus;
}

/** 連播懲罰：當天白板近 N 則內該玩家每播出一次 −1（狼模式餵 wolfDiscussionLog 切片） */
export function repeatPenalty(playerId: number, recentSpeakerIds: number[]): number {
  let n = 0;
  for (const id of recentSpeakerIds) if (id === playerId) n++;
  return n;
}

export class SpeechScheduler implements AIScheduler {
  private readonly ctx: SchedulerContext;
  private readonly options: Required<SpeechSchedulerOptions>;
  private stopped = false;
  private lastSeenBoardVersion = -1;
  private lastDay = -1;
  private prodToken = 0;
  private producing = false;
  private stash: Stash | null = null;
  private cdReady = false;
  private cdTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private uncertainCounts = new Map<number, number>();
  private decisions = new Map<number, AIDecision>();   // 每玩家最新有效決策（含安全閥強制 abstain）
  private readonly gameId: string = `g${Date.now().toString(36)}`;   // 賬本 game 欄（同局同號）
  // 熔斷軌：白板污染連計（只計播出逃逸；拒收清零；熔斷史：loop3 expand 連三違規已升級，軌重置為 0；達閾處置待 oracle 下一單）
  private groundingStreak = 0;

  constructor(ctx: SchedulerContext, options?: SpeechSchedulerOptions) {
    this.ctx = ctx;
    this.options = {
      cdMs: options?.cdMs ?? envInt('SPEECH_CD_MS', 60000),
      retryMs: options?.retryMs ?? envInt('SPEECH_RETRY_MS', 60000),
      preSpeechBatch: options?.preSpeechBatch ?? 3,
      preSpeechTemp: options?.preSpeechTemp ?? 0.7,
      judgeTemp: options?.judgeTemp ?? 0.3,
      expandTemp: options?.expandTemp ?? 0.8,
      topK: options?.topK ?? 3,   // 未用（SELECT 價值制已取消隨機；保留讀取免壞外部呼叫）
      recentCompareCount: options?.recentCompareCount ?? 3,
      maxUncertainRounds: options?.maxUncertainRounds ?? MAX_UNCERTAIN_ROUNDS,
      ledgerFile: options?.ledgerFile ?? precedentsFile(),
    };
  }

  onPhaseEntered(state: GameState): void {
    if (this.stopped) return;
    if (state.phase === 'DAY_DISCUSSION_OPEN' || state.phase === 'NIGHT_DISCUSSION_OPEN') {
      // 模式一律由 state.phase 推導（NIGHT_DISCUSSION_OPEN = 狼），不另存可過期的 mode 欄位
      if (state.day !== this.lastDay) {
        this.lastDay = state.day;
        this.uncertainCounts.clear();
        this.decisions.clear();
      }
      this.lastSeenBoardVersion = state.boardVersion;
      this.resetCycle();
      this.restartCd(state);
      this.startProduction();
    } else {
      this.resetCycle();
      if (state.phase === 'GAME_OVER_FINAL') this.stop();
    }
  }

  onBoardUpdated(state: GameState): void {
    if (this.stopped) return;
    if (state.phase !== 'DAY_DISCUSSION_OPEN' && state.phase !== 'NIGHT_DISCUSSION_OPEN') return;
    if (state.boardVersion === this.lastSeenBoardVersion) return;
    // 中間白板又更新 → 暫存作廢＋生產用新白板重跑＋CD 重啟
    this.lastSeenBoardVersion = state.boardVersion;
    this.resetCycle();
    this.restartCd(state);
    this.startProduction();
  }

  /** 清除 timer（server 關閉時） */
  stop(): void {
    this.stopped = true;
    this.resetCycle();
  }

  /** 供測試：目前暫存（有貨／無貨） */
  stashForTest(): Stash | null {
    return this.stash ? { ...this.stash } : null;
  }

  /** 供測試：單一 AI 連續資訊不足次數 */
  uncertainCountForTest(playerId: number): number {
    return this.uncertainCounts.get(playerId) ?? 0;
  }

  /** 供測試：熔斷軌 grounding 連計 */
  groundingStreakForTest(): number {
    return this.groundingStreak;
  }

  private resetCycle(): void {
    this.prodToken++;
    this.producing = false;
    this.stash = null;
    this.cdReady = false;
    if (this.cdTimer) {
      clearTimeout(this.cdTimer);
      this.cdTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private effectiveCdMs(state: GameState): number {
    const humans = getAlivePlayers(state.players).filter((p) => p.controlledBy === 'human').length;
    return humans > 0 ? this.options.cdMs : 0;
  }

  private restartCd(state: GameState): void {
    if (this.cdTimer) {
      clearTimeout(this.cdTimer);
      this.cdTimer = null;
    }
    this.cdReady = false;
    const ms = this.effectiveCdMs(state);
    this.cdTimer = setTimeout(() => {
      this.cdTimer = null;
      this.onCdFired();
    }, ms);
    const t = this.cdTimer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  private onCdFired(): void {
    if (this.stopped) return;
    let state: GameState;
    try {
      state = this.ctx.getState();
    } catch {
      return;
    }
    if (state.phase !== 'DAY_DISCUSSION_OPEN' && state.phase !== 'NIGHT_DISCUSSION_OPEN') return;
    this.cdReady = true;
    if (this.stash) void this.broadcastStash();
    // 無貨 → 等做好馬上播（生產完成時見 cdReady 直接播）
  }

  /** 草稿候選：存活 AI 除上輪發言者外全員（狼模式僅存活狼 AI）；為空 → 不生產（等真人）。
   *  已就緒（voteReady/wolfReady）者排除：已表態者不再草稿，降噪＋省算力＋加速收斂；
   *  收回就緒（人類）會重回候選。唯一候選時不斷線（避免單人僵局）。 */
  private candidateIds(state: GameState): number[] {
    const isWolf = state.phase === 'NIGHT_DISCUSSION_OPEN';
    const readySet = isWolf ? state.wolfReady : state.voteReady;
    const aliveAI = getAlivePlayers(state.players)
      .filter((p) => p.controlledBy === 'ai' && (!isWolf || p.role === Role.WEREWOLF))
      .filter((p) => !readySet.includes(p.id));
    if (aliveAI.length === 0) return [];
    const aliveIds = aliveAI.map((p) => p.id);
    if (aliveIds.length === 1) return aliveIds;
    const log = isWolf ? state.wolfDiscussionLog : state.discussionLog;
    const today = log.filter((d) => d.day === state.day);
    const last = today[today.length - 1];
    if (!last) return [...aliveIds];
    const cands = aliveIds.filter((id) => id !== last.playerId);
    return cands.length > 0 ? cands : aliveIds;
  }

  private startProduction(): void {
    if (this.stopped || this.producing) return;
    let state: GameState;
    try {
      state = this.ctx.getState();
    } catch {
      return;
    }
    if (state.phase !== 'DAY_DISCUSSION_OPEN' && state.phase !== 'NIGHT_DISCUSSION_OPEN') return;
    const ids = this.candidateIds(state);
    if (ids.length === 0) return;   // 候選為空不生產，等真人講話（掛機計數自然凍結）
    const token = ++this.prodToken;
    this.producing = true;
    void this.runProduction(token, state.boardVersion, ids);
  }

  private async runProduction(token: number, startVersion: number, ids: number[]): Promise<void> {
    try {
      // ---- PRE_SPEECH：全員草稿（分批平行；剝離＋決策更新在 collect 內） ----
      const drafts = await this.collectPreSpeeches(token, ids);
      if (token !== this.prodToken) return;
      const cur1 = this.ctx.getState();
      if (cur1.phase !== 'DAY_DISCUSSION_OPEN' && cur1.phase !== 'NIGHT_DISCUSSION_OPEN') return;
      if (cur1.boardVersion !== startVersion) return;   // 作廢（新一輪已接手）
      if (drafts.length === 0) {
        this.scheduleRetry();
        return;
      }

      // ---- JUDGE：全盲裁判（草稿 ≤3 直接跳過給同分，改由 SELECT 價值制決勝） ----
      const scores = drafts.length <= 3
        ? new Map(drafts.map((d) => [d.slot, 5]))
        : await this.judge(token, cur1, drafts);
      if (token !== this.prodToken) return;
      const cur2 = this.ctx.getState();
      if (cur2.phase !== 'DAY_DISCUSSION_OPEN' && cur2.phase !== 'NIGHT_DISCUSSION_OPEN') return;
      if (cur2.boardVersion !== startVersion) return;   // 作廢

      // ---- SELECT：價值制確定性（final＝judge分－新穎性＋價值－連播；取最高，同分取 playerId 最小；不抽籤） ----
      const isWolfMode = cur2.phase === 'NIGHT_DISCUSSION_OPEN';
      const winner = this.selectWinner(cur2, drafts, scores);
      const commitVersion = this.ctx.getState().boardVersion;

      // ---- EXPAND：產出後清洗 flag（廉價保險），再暫存 ----
      const expandPrompt = isWolfMode
        ? buildWolfExpandPrompt(cur2, winner.playerId, winner.text)
        : buildExpandPrompt(cur2, winner.playerId, winner.text);
      let full: string;
      let decision: AIDecision = winner.decision;
      try {
        const rawExpand = await this.fetchExpandText(expandPrompt, isWolfMode, winner.playerId, cur2);
        if (isWolfMode && rawExpand === '') {
          // expand 兜底：兩次違規→退回草稿（草稿已通過驗證；防 scheduleRetry 無限重試）
          decision = this.updateDecision(winner.playerId, winner.decision);
          full = stripSpeechPrefix(winner.text);
        } else {
          const expandDecision = parseDecisionFlag(rawExpand);
          full = stripSpeechPrefix(stripDecisionFlags(rawExpand));
          // 狼模式：expand 是對外最終承諾，其決策優先（無效目標→棄票）；expand 未決定→沿用草稿決策。
          // 熔斷 a：expand 文本目標對齊——草稿有目標時文本出現異數即漂移，整份退回草稿（文本恐已漂移）。
          // 矛盾防護：expand 旗標目標與草稿決策目標不一致 → 退回草稿文本＋草稿決策（草稿已通過驗證）
          if (isWolfMode) {
            const draft = winner.decision;
            const draftTarget = draft.status === 'decided' && draft.target !== 'abstain' ? draft.target : null;
          let drift = false;
          if (draftTarget !== null) {
            WOLF_TARGET_RE.lastIndex = 0;
            let tm: RegExpExecArray | null;
            while ((tm = WOLF_TARGET_RE.exec(rawExpand)) !== null) {
              if (parseInt(tm[1] ?? tm[2], 10) !== draftTarget) { drift = true; break; }
            }
          }
            if (drift) {
              decision = this.updateDecision(winner.playerId, winner.decision);
              // 退回草稿文本時同樣要剝 P 前綴（與正常路徑一致），否則播出確認比對失敗會誤判為拒絕
              full = stripSpeechPrefix(winner.text);
            } else if (expandDecision.status === 'decided' && expandDecision.target !== 'abstain') {
              if (draftTarget === null || expandDecision.target === draftTarget) {
                decision = this.updateDecision(winner.playerId, this.validateWolfTarget(cur2, winner.playerId, expandDecision));
              } else {
                decision = this.updateDecision(winner.playerId, winner.decision);
                full = stripSpeechPrefix(winner.text);
              }
            }
            // 文旗分歧救回（選 A）：expand 無旗標但文本提名→轉 decided（兌現「中控自行判讀」；非法 validate 擋回 abstain）
            if (decision.status === 'uncertain' && !hasExplicitFlag(rawExpand)) {
              WOLF_TARGET_RE.lastIndex = 0;
              const nominate = WOLF_TARGET_RE.exec(rawExpand);
              if (nominate) {
                decision = this.updateDecision(winner.playerId, this.validateWolfTarget(cur2, winner.playerId, { status: 'decided', target: parseInt(nominate[1] ?? nominate[2], 10) }));
              }
            }
          }
        }
      } catch {
        this.scheduleRetry();
        return;
      }
      if (token !== this.prodToken) return;
      if (this.ctx.getState().phase !== 'DAY_DISCUSSION_OPEN' && this.ctx.getState().phase !== 'NIGHT_DISCUSSION_OPEN') return;
      if (!full) {
        this.scheduleRetry();
        return;
      }
      // 播出逃逸檢查：狼 expand 終稿再查 seed/fab（首夜）/eng；命中只計 streak＋記賬，不擋播出（防無限重試）
      if (isWolfMode) {
        const escapeNight = cur2.wolfDiscussionLog.length === 0 && cur2.discussionLog.length === 0;
        const escapeHit = checkExpandViolation(full, escapeNight);
        if (escapeHit) {
          this.groundingStreak++;
          const persona = cur2.players.find((p) => p.id === winner.playerId)?.personality ?? `p${winner.playerId}`;
          this.recordPrecedents([{
            meeting: 'wolf', phase: 'expand', kind: escapeHit.kind, hit: escapeHit.hit,
            who: `P${winner.playerId}/${persona}`, text: full,
          }], false);
        }
      }
      this.stash = {
        playerId: winner.playerId, text: full, boardVersion: commitVersion, decision,
      };
      if (this.cdReady) void this.broadcastStash();
    } catch {
      if (token !== this.prodToken) return;
      this.scheduleRetry();
    } finally {
      if (token === this.prodToken) this.producing = false;
    }
  }

  /** 價值制選子：final＝judge分－新穎性＋價值－連播；取最高分，同分取 playerId 最小（不抽籤） */
  private selectWinner(state: GameState, drafts: Draft[], scores: Map<number, number>): Draft {
    const log = state.phase === 'NIGHT_DISCUSSION_OPEN' ? state.wolfDiscussionLog : state.discussionLog;
    const window = log.filter((d) => d.day === state.day).slice(-this.options.recentCompareCount);
    const recentTexts = window.map((d) => d.text);
    const recentIds = window.map((d) => d.playerId);
    const ranked = drafts.map((d) => ({
      ...d,
      final: (scores.get(d.slot) ?? 5) - noveltyPenalty(d.text, recentTexts)
        + draftValueBonus(d) - repeatPenalty(d.playerId, recentIds),
    })).sort((a, b) => b.final - a.final || a.playerId - b.playerId);
    return ranked[0];
  }

  /** 生產失敗 → N 秒後重試；重試前不播出（無暫存）、不推進掛機計數（transition 只在發言成功時計數） */
  private scheduleRetry(): void {
    if (this.stopped) return;
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.startProduction();
    }, this.options.retryMs);
    const t = this.retryTimer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  private async collectPreSpeeches(token: number, ids: number[]): Promise<Draft[]> {
    const results: Draft[] = [];
    const batch = Math.max(1, this.options.preSpeechBatch);
    for (let i = 0; i < ids.length; i += batch) {
      if (token !== this.prodToken) return [];
      const chunk = ids.slice(i, i + batch);
      const settled = await Promise.all(chunk.map((pid) => this.runPreSpeechCandidate(token, pid)));
      for (const r of settled) {
        if (r) results.push({ slot: 0, ...r });
      }
    }
    // slot 編號依完成順序指派（與裁判看到的順序一致；映射前先打亂）
    const shuffled = shuffleArray(results);
    shuffled.forEach((r, idx) => { r.slot = idx + 1; });
    return shuffled;
  }

  /** 單候選 pre_speech（含狼拒收重試＋賬本＋兜底棄權；白天沿用舊流程） */
  private async runPreSpeechCandidate(token: number, pid: number): Promise<Omit<Draft, 'slot'> | null> {
    const st = this.ctx.getState();
    const isWolf = st.phase === 'NIGHT_DISCUSSION_OPEN';
    let basePrompt = isWolf ? buildWolfPreSpeechPrompt(st, pid) : buildPreSpeechPrompt(st, pid);
    const firstNight = st.wolfDiscussionLog.length === 0 && st.discussionLog.length === 0;
    const persona = st.players.find((p) => p.id === pid)?.personality ?? `p${pid}`;
    const who = `P${pid}/${persona}`;
    const phase = firstNight ? 'first_pre' : 'later_pre';
    if (isWolf) {
      // 跨局注入 top-1（讀不到賬本照舊跑）
      try {
        const cross = findCrossGamePrecedent('wolf', phase, persona, this.options.ledgerFile);
        if (cross) basePrompt = `${basePrompt}\n\n${buildCrossGameNote(cross)}`;
      } catch { /* 無賬本照舊 */ }
    }
    let retryNote = '';
    const pending: { kind: string; hit: string; text: string }[] = [];
    const logRejects = (fixed: boolean): void => {
      if (isWolf && pending.length > 0) {
        this.recordPrecedents(pending.map((p) => ({ meeting: 'wolf', phase, kind: p.kind, hit: p.hit, who, text: p.text })), fixed);
      }
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (token !== this.prodToken) return null;
      try {
        // 先取原文再正規化：原文含簡體即 lang 拒收（expand 只洗不攔）
        const prompt = retryNote ? `${basePrompt}\n\n${retryNote}` : basePrompt;
        const rawRaw = (await this.ctx.llm.generate(prompt, {
          temperature: this.options.preSpeechTemp,
          maxTokens: 100,
        })).trim();
        if (!rawRaw) continue;
        if (isWolf) {
          const simpNote = simplifiedRejection(rawRaw);
          if (simpNote) { pending.push({ kind: 'lang', hit: '簡體混入', text: rawRaw }); retryNote = buildLangRetryNote(rawRaw, true); continue; }
        }
        const raw = normalizeTraditional(rawRaw);
        if (isWolf) {
          const rej = checkWolfDraft(raw, st, pid);
          if (rej) {
            this.groundingStreak = 0;   // 熔斷看逃逸連計：拒收即清零
            pending.push({ kind: rej.kind, hit: rej.hit, text: raw }); retryNote = rej.note; continue;
          }
        }
        const parsed = parseDecisionFlag(raw);
        const decision = this.updateDecision(pid, isWolf ? this.validateWolfTarget(st, pid, parsed) : parsed);
        const text = stripDecisionFlags(raw);
        if (!text) continue;   // 僅剩 flag 無內容 → 不列入候選
        logRejects(true);   // 改過自新
        return { playerId: pid, text, decision };
      } catch { /* 重試 1 次 */ }
    }
    if (isWolf) {
      // 兜底：2 attempt 仍犯→棄權（資訊不足、不播出）
      logRejects(false);
      this.updateDecision(pid, { status: 'uncertain' });
    }
    return null;
  }

  /** 賬本寫入（IO 失敗吞掉，不影響生產） */
  private recordPrecedents(base: Omit<PrecedentEntry, 't' | 'game' | 'fixed'>[], fixed: boolean): void {
    if (base.length === 0) return;
    try {
      const t = Date.now();
      appendPrecedents(base.map((e) => ({ ...e, t, game: this.gameId, fixed })), this.options.ledgerFile);
    } catch { /* 賬本 best-effort */ }
  }

  /** expand 取文（狼黑名單重試：簡體源頭攔／seed/fab/eng 命中→前科再取，上限另計 2 次；日間單發舊流程） */
  private async fetchExpandText(expandPrompt: string, isWolfMode: boolean, pid: number, st: GameState): Promise<string> {
    let note = '';
    let raw = '';
    let lastClean = true;   // 當次 attempt 通過全部檢查才 true；簡體／seed／fab／eng 任一被拒即 false
    const pending: { kind: 'grounding' | 'lang'; hit: string; text: string }[] = [];
    const firstNight = st.wolfDiscussionLog.length === 0 && st.discussionLog.length === 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ep = note ? `${expandPrompt}\n\n${note}` : expandPrompt;
      const rawRaw = (await this.ctx.llm.generate(ep, {
        temperature: this.options.expandTemp,
        maxTokens: 100,
      })).trim();
      if (isWolfMode) {
        const simpNote = simplifiedRejection(rawRaw);
        if (simpNote) { pending.push({ kind: 'lang', hit: '簡體混入', text: rawRaw }); note = simpNote; lastClean = false; continue; }
      }
      raw = normalizeTraditional(rawRaw);
      if (!isWolfMode) break;
      const v = checkExpandViolation(raw, firstNight);
      if (!v) { lastClean = true; break; }
      pending.push({ kind: v.kind, hit: v.hit, text: raw });
      note = v.kind === 'lang' ? buildLangRetryNote(raw) : buildViolationRetryNote(raw, v.hit, firstNight);
      lastClean = false;
    }
    if (isWolfMode && pending.length > 0) {
      // 改過自新＝末次 attempt 通過全部檢查（lastClean；防簡體被拒時 raw 殘留上一次值誤判）
      const fixed = lastClean;
      const persona = st.players.find((p) => p.id === pid)?.personality ?? `p${pid}`;
      this.recordPrecedents(pending.map((p) => ({
        meeting: 'wolf', phase: 'expand', kind: p.kind, hit: p.hit,
        who: `P${pid}/${persona}`, text: p.text,
      })), fixed);
      if (!fixed) return '';   // 狼支兩次違規未改過 → 空字串（上游退回草稿，不播錯）
    }
    return raw;
  }

  /** 驗證狼襲擊目標合法性：存活、非自己、非狼同盟；不合法 → 視為棄票（狼放棄這票，不擋會議；夜晚結算另有過濾） */
  private validateWolfTarget(state: GameState, playerId: number, d: AIDecision): AIDecision {
    if (d.status === 'decided' && d.target !== 'abstain') {
      const target = state.players.find((p) => p.id === d.target);
      const allies = getAliveWerewolves(state.players).map((w) => w.id);
      if (!target || !target.alive || target.id === playerId || allies.includes(target.id)) {
        return { status: 'decided', target: 'abstain' };
      }
    }
    return d;
  }

  /** 決策更新：decided 覆蓋標的＋清空計數；資訊不足累計，達安全閥強制 decided:abstain */
  private updateDecision(playerId: number, d: AIDecision): AIDecision {
    if (d.status === 'decided') {
      this.uncertainCounts.delete(playerId);
      this.decisions.set(playerId, d);
      return d;
    }
    const n = (this.uncertainCounts.get(playerId) ?? 0) + 1;
    if (n >= this.options.maxUncertainRounds) {
      this.uncertainCounts.delete(playerId);
      const forced: AIDecision = { status: 'decided', target: 'abstain' };
      this.decisions.set(playerId, forced);
      return forced;
    }
    this.uncertainCounts.set(playerId, n);
    this.decisions.set(playerId, d);
    return d;
  }

  /** GM 除錯用：每輪 AI 決策 flag 統計（每玩家最新決策，非累計筆數；決定投誰／棄票／資訊不足各幾筆） */
  flagStats(): FlagStats {
    let decided = 0;
    let abstain = 0;
    let uncertain = 0;
    for (const d of this.decisions.values()) {
      if (d.status === 'uncertain') uncertain++;
      else if (d.target === 'abstain') abstain++;
      else decided++;
    }
    return { decided, abstain, uncertain };
  }

  private async judge(
    token: number,
    state: GameState,
    drafts: Draft[],
  ): Promise<Map<number, number>> {
    const summary = state.phase === 'NIGHT_DISCUSSION_OPEN'
      ? summarizeWolfDiscussion(state, state.day)
      : summarizeDay(state, state.day);
    const prompt = buildJudgePrompt(summary, drafts.map((d) => ({ slot: d.slot, text: d.text })));
    let raw = '';
    try {
      raw = await this.ctx.llm.generate(prompt, {
        temperature: this.options.judgeTemp,
        maxTokens: 200,
      });
    } catch {
      return new Map(drafts.map((d) => [d.slot, 5]));
    }
    if (token !== this.prodToken) return new Map();
    const scores = new Map<number, number>();
    const re = /^(\d+)\s*[:：]\s*(\d+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      scores.set(parseInt(m[1], 10), parseInt(m[2], 10));
    }
    const parsed = drafts.filter((d) => scores.has(d.slot)).length;
    if (parsed / drafts.length < 0.5) {
      // 解析率 < 50% → 放棄評分，全部同分（改由 SELECT 價值制決勝）
      return new Map(drafts.map((d) => [d.slot, 5]));
    }
    for (const d of drafts) {
      if (!scores.has(d.slot)) scores.set(d.slot, 5);
    }
    return scores;
  }

  /** CD 到有貨 → 播出；播出成功且 decided → enqueue AI_READY_VOTE（統一檢查由 transition 執行） */
  private async broadcastStash(): Promise<void> {
    const s = this.stash;
    if (!s) return;
    this.stash = null;   // 消費暫存
    let state: GameState;
    try {
      state = this.ctx.getState();
    } catch {
      return;
    }
    if (state.phase !== 'DAY_DISCUSSION_OPEN' && state.phase !== 'NIGHT_DISCUSSION_OPEN') return;
    if (state.boardVersion !== s.boardVersion) return;   // 版本已動：作廢（新一輪接手）
    const isWolf = state.phase === 'NIGHT_DISCUSSION_OPEN';
    this.ctx.enqueue(isWolf
      ? { type: 'AI_WOLF_SPEECH_DONE', playerId: s.playerId, text: s.text, boardVersion: s.boardVersion }
      : { type: 'AI_SPEECH_DONE', playerId: s.playerId, text: s.text, boardVersion: s.boardVersion });
    // 發言成功確認：log 落子即成功（engine 同步處理；含版本檢查）
    let cur: GameState;
    try {
      cur = this.ctx.getState();
    } catch {
      return;
    }
    const log = isWolf ? cur.wolfDiscussionLog : cur.discussionLog;
    const today = log.filter((d) => d.day === cur.day);
    const lastEntry = today[today.length - 1];
    const ok = !!lastEntry && lastEntry.playerId === s.playerId && lastEntry.text === s.text;
    if (!ok) {
      // 被拒（版本競態）→ 視為白板活動：重啟 CD＋重跑
      if (cur.phase !== 'DAY_DISCUSSION_OPEN' && cur.phase !== 'NIGHT_DISCUSSION_OPEN') return;
      this.lastSeenBoardVersion = cur.boardVersion;
      this.restartCd(cur);
      this.startProduction();
      return;
    }
    // 發言成功後 enqueue 新 decided（不帶版本；已在 ready 則免）
    if (s.decision.status === 'decided') {
      if (isWolf) {
        if (!cur.wolfReady.includes(s.playerId)) {
          this.ctx.enqueue({ type: 'AI_WOLF_READY', playerId: s.playerId });
        }
      } else if (!cur.voteReady.includes(s.playerId)) {
        this.ctx.enqueue({ type: 'AI_READY_VOTE', playerId: s.playerId });
      }
    }
    // 收斂直進投票由 transition 統一檢查完成；播出本身即白板更新，迴圈經 onBoardUpdated 回去。
  }
}
