/**
 * ai-scheduler.test.ts — SpeechScheduler 管線測試（fake timers + mock LLM）
 * 白板更新驅動迴圈＋決策 flag 收斂（第 1、2 項新語義）
 */
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SpeechScheduler, parseDecisionFlag, stripDecisionFlags, normalizeTraditional, MAX_UNCERTAIN_ROUNDS, GROUNDING_VIOLATION_SEEDS, findGroundingViolation, buildViolationRetryNote, buildFormatRetryNote, isEnglishHeavy, illegalWolfTarget, checkWolfDraft, buildLangRetryNote, buildTargetRetryNote, findFirstNightFabrication, simplifiedRejection, findEnglishWord, checkExpandViolation, readPrecedents, appendPrecedents, findCrossGamePrecedent, buildCrossGameNote, PRECEDENTS_CAP, } from './ai-scheduler.js';
import { createGameState, transition, getNightActors, stripSpeechPrefix } from './game-state.js';
import { noveltyPenalty, bigramJaccard, pNumberOverlap } from './novelty.js';
import { Role } from './types.js';
// ---------- novelty 純函式 ----------
test('novelty：bigramJaccard（相同→1、無關→低、空→0）', () => {
    assert.equal(bigramJaccard('今天要投P3出去', '今天要投P3出去'), 1);
    assert.ok(bigramJaccard('abcdefgh', 'ijklmnop') < 0.3);
    assert.equal(bigramJaccard('', 'abc'), 0);
    assert.equal(bigramJaccard('abc', ''), 0);
    assert.equal(bigramJaccard('a', 'a'), 0); // 單字無 bigram
});
test('novelty：pNumberOverlap（重疊率、皆無→0）', () => {
    assert.equal(pNumberOverlap('懷疑P1和P2', 'P2跟P3很可疑'), 1 / 3);
    assert.equal(pNumberOverlap('P1是好人', 'P1是好人'), 1);
    assert.equal(pNumberOverlap('今天天氣真好', '大家多發言'), 0);
});
test('novelty：penalty 範圍 [0,3]、無歷史→0', () => {
    assert.equal(noveltyPenalty('任何內容', []), 0);
    const dup = noveltyPenalty('P3是狼快投P3出去', ['P3是狼快投P3出去']);
    assert.ok(dup > 0 && dup <= 3);
    assert.equal(noveltyPenalty('今天天氣真好適合散步', ['P3是狼快投P3出去']), 0);
    for (const t of ['a', '完全不同的一句話', 'P1 P2 P3 P4 P5']) {
        const p = noveltyPenalty(t, ['P3是狼', '我覺得P5很可疑']);
        assert.ok(p >= 0 && p <= 3);
    }
});
class MockLLM {
    fn;
    calls = [];
    constructor(fn) {
        this.fn = fn;
    }
    async generate(prompt, config) {
        const kind = prompt.includes('【裁判任務】')
            ? 'judge'
            : prompt.includes('【你的預發言草稿】')
                ? 'expand'
                : 'pre_speech';
        this.calls.push({ kind, prompt, config });
        return this.fn(prompt);
    }
    async requestSpeech() {
        throw new Error('scheduler 只用 generate');
    }
    async requestVote() {
        throw new Error('scheduler 只用 generate');
    }
    async requestNightAction() {
        throw new Error('scheduler 只用 generate');
    }
    kinds() {
        return this.calls.map((c) => c.kind);
    }
}
/** 狼密談收斂：全存活狼 ready → NIGHT_COLLECTING（新流程：START_GAME/ADVANCE_DAY 先進 NIGHT_DISCUSSION_OPEN） */
function convergeWolfDiscussion(s) {
    for (const p of s.players) {
        if (p.alive && p.role === Role.WEREWOLF) {
            const r = transition(s, p.controlledBy === 'human'
                ? { type: 'HUMAN_WOLF_READY', playerId: p.id }
                : { type: 'AI_WOLF_READY', playerId: p.id });
            assert.equal(r.accepted, true);
        }
    }
    assert.equal(s.phase, 'NIGHT_COLLECTING');
}
function discussionState(playerCount = 9) {
    const s = createGameState(playerCount);
    for (let i = 0; i < playerCount; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    convergeWolfDiscussion(s);
    for (const pid of getNightActors(s)) {
        transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: s.players.filter((p) => p.alive && p.id !== pid)[0].id });
    }
    transition(s, { type: 'RESOLVE_NIGHT' });
    assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
    return s;
}
function makeCtx(state, llm) {
    const events = [];
    return {
        events,
        ctx: {
            // 模擬 engine 行為：發言被接受 → log 落子＋boardVersion++；ready → voteReady
            // （engine 另會呼叫 onBoardUpdated，測試內手動呼叫以保確定性）
            // 保真要點：production 的 transition 會 stripSpeechPrefix，這裡同樣剝離，
            // 否則播出確認比對（lastEntry.text === s.text）永遠成功，測不到前綴相關 bug
            enqueue: (e) => {
                events.push(e);
                if (e.type === 'AI_SPEECH_DONE') {
                    state.discussionLog.push({ playerId: e.playerId, text: stripSpeechPrefix(e.text), day: state.day });
                    state.boardVersion++;
                }
                if (e.type === 'AI_READY_VOTE' && !state.voteReady.includes(e.playerId)) {
                    state.voteReady.push(e.playerId);
                }
                if (e.type === 'AI_WOLF_SPEECH_DONE') {
                    state.wolfDiscussionLog.push({ playerId: e.playerId, text: stripSpeechPrefix(e.text), day: state.day });
                    state.boardVersion++;
                }
                if (e.type === 'AI_WOLF_READY' && !state.wolfReady.includes(e.playerId)) {
                    state.wolfReady.push(e.playerId);
                }
                if (e.type === 'HUMAN_SPEAK')
                    state.boardVersion++;
            },
            getState: () => state,
            llm,
        },
    };
}
function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}
async function flushN(n) {
    for (let i = 0; i < n; i++)
        await flush();
}
beforeEach(() => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
});
afterEach(() => {
    mock.timers.reset();
});
// 預設確定性 mock：預發言帶正規 decided flag、裁判按 slot 降序給分、展開固定文本
function judgeBySlotDesc(prompt) {
    const slots = [];
    for (const m of prompt.matchAll(/^(\d+)\.\s/gm))
        slots.push(parseInt(m[1], 10));
    return slots.map((s, i) => `${s}: ${9 - i}`).join('\n');
}
function defaultMock() {
    return new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】'))
            return 'P0：「沿用草稿，展開成完整發言。」';
        const m = prompt.match(/你是 P(\d+)/);
        const id = m ? m[1] : '1';
        return `P${id}：「我比較在意 P${id} 以外的發言。」\n[決定:棄票]`;
    });
}
// 不確定 mock：預發言無 flag（僅不確定語氣）→ 走安全閥路徑
function uncertainMock() {
    return new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】'))
            return 'P0：「還在觀察，展開成完整發言。」';
        const m = prompt.match(/你是 P(\d+)/);
        const id = m ? m[1] : '1';
        return `P${id}：「資訊還不足，我無法決定，想再聽聽大家的說法。」`;
    });
}
// ---------- flag 兩層解析 ----------
test('flag 正規解析：投Pn／棄票／資訊不足（全形冒號亦收）', () => {
    assert.deepEqual(parseDecisionFlag('草稿內容\n[決定:投P3]'), { status: 'decided', target: 3 });
    assert.deepEqual(parseDecisionFlag('草稿內容\n[決定：投P12]'), { status: 'decided', target: 12 });
    assert.deepEqual(parseDecisionFlag('草稿\n[決定:棄票]'), { status: 'decided', target: 'abstain' });
    assert.deepEqual(parseDecisionFlag('草稿\n[決定:資訊不足]'), { status: 'uncertain' });
    assert.deepEqual(parseDecisionFlag('草稿\n[決定:殺P3]'), { status: 'decided', target: 3 });
});
test('flag 寬鬆解析：決策語境關鍵字認 decided；不確定類詞認 uncertain；都不中才 uncertain', () => {
    assert.deepEqual(parseDecisionFlag('我想了很久，我投P2'), { status: 'decided', target: 2 });
    assert.deepEqual(parseDecisionFlag('我決定投 P5 吧'), { status: 'decided', target: 5 });
    assert.deepEqual(parseDecisionFlag('這一票要投P7'), { status: 'decided', target: 7 });
    assert.deepEqual(parseDecisionFlag('我決定殺P5'), { status: 'decided', target: 5 });
    assert.deepEqual(parseDecisionFlag('我決定棄票好了'), { status: 'decided', target: 'abstain' });
    assert.deepEqual(parseDecisionFlag('資訊不足，還想再觀察'), { status: 'uncertain' });
    assert.deepEqual(parseDecisionFlag('今天天氣真好'), { status: 'uncertain' });
    // 討論提及（無決策動詞）不誤判為 decided
    assert.deepEqual(parseDecisionFlag('P3 很可疑，大家怎麼看'), { status: 'uncertain' });
});
test('flag 剝離：全域匹配（中置殘留亦清）；解析取最後一個', () => {
    assert.equal(stripDecisionFlags('A[決定:投P3]B\n[決定:棄票]C'), 'AB\nC');
    assert.deepEqual(parseDecisionFlag('前言[決定:投P3]結論[決定:棄票]'), { status: 'decided', target: 'abstain' });
    assert.ok(!stripDecisionFlags('發言\n[決定:投P3]').includes('[決定'));
    // 無方括號裸旗標行尾亦剝離（模型漏寫括號時防白板污染；行尾旗標前段文本保留）
    assert.equal(stripDecisionFlags('發言\n決定:資訊不足\n下一句'), '發言\n\n下一句');
    assert.equal(stripDecisionFlags('發言\n決定：殺P5  \n下一句'), '發言\n\n下一句');
    assert.equal(stripDecisionFlags('草稿文本。決定:殺P5'), '草稿文本。');
    assert.equal(stripDecisionFlags('我決定投P3出去'), '我決定投P3出去');
});
test('flag 寬鬆解析：該殺／先殺亦認 decided（首夜常見說法）', () => {
    assert.deepEqual(parseDecisionFlag('我覺得今晚該殺P12'), { status: 'decided', target: 12 });
    assert.deepEqual(parseDecisionFlag('今晚先殺P5吧'), { status: 'decided', target: 5 });
    // 冒號版缺口：決定:殺P（句中、非行尾）走寬鬆層亦認
    assert.deepEqual(parseDecisionFlag('決定:殺P5，然後再看看'), { status: 'decided', target: 5 });
});
test('parser 行尾旗標：同行亦接受；白卷靠空文本下遊重試', () => {
    assert.deepEqual(parseDecisionFlag('我隨便指一個，P5吧。\n決定:殺P5'), { status: 'decided', target: 5 });
    assert.deepEqual(parseDecisionFlag('你們先定，我跟票。\n決定：資訊不足'), { status: 'uncertain' });
    // 同行裸旗標（行尾版）：前段即文本，直接採信
    assert.deepEqual(parseDecisionFlag('我認為P3可疑。決定:殺P3'), { status: 'decided', target: 3 });
    assert.deepEqual(parseDecisionFlag('決定:殺P5，然後再看看'), { status: 'decided', target: 5 });
    // 白卷（僅裸旗標）：解析或可命中，但剝離後空文本，下遊照舊重試
    assert.equal(stripDecisionFlags('決定:殺P5'), '');
    assert.deepEqual(parseDecisionFlag('決定:資訊不足'), { status: 'uncertain' });
});
test('黑名單：命中回傳種子、未命中回空字串', () => {
    for (const seed of GROUNDING_VIOLATION_SEEDS) {
        assert.equal(findGroundingViolation(`我覺得P3${seed}，先殺他`), seed);
    }
    assert.equal(findGroundingViolation('我沒想法，跟票。'), '');
    assert.equal(findGroundingViolation('第一晚沒資訊，我隨便指一個，P5吧。'), '');
    // 正規化後命中：说谎 → 說謊（谎→謊已補表）
    assert.equal(findGroundingViolation(normalizeTraditional('我認為P3可能在说谎')), '說謊');
});
test('黑名單擴詞至 34：嫌疑／疑慮／異常／懷疑／觀察其行為／特別的表現／藏了一些事情／暗中觀察／沉默／舉動／不像村人／可能是村人／不太像村人／關鍵人物／行動比較獨立／都不說話／單薄／有點孤獨／藏有疑點／異動／孤僻命中', () => {
    assert.equal(findGroundingViolation('P5和P12可能有嫌疑'), '嫌疑');
    assert.equal(findGroundingViolation('他的行動引起我的疑慮'), '疑慮');
    assert.equal(findGroundingViolation('他昨晚的行動好像有點異常'), '異常');
    assert.equal(findGroundingViolation('我懷疑P3在藏陰謀'), '藏陰謀');
    assert.equal(findGroundingViolation('我懷疑他是狼'), '懷疑');
    assert.equal(findGroundingViolation('需進一步觀察其行為'), '觀察其行為');
    assert.equal(findGroundingViolation('這個人沒有什麼特別的表現'), '特別的表現');
    assert.equal(findGroundingViolation('他可能藏了一些事情'), '藏了一些事情');
    assert.equal(findGroundingViolation('可能有人在暗中觀察'), '暗中觀察');
    assert.equal(findGroundingViolation('他可能藏了一些什麼'), '藏了一些什麼');
    assert.equal(findGroundingViolation('這個人一直表現得不太穩定'), '不太穩定');
    assert.equal(findGroundingViolation('他有些奇怪'), '奇怪');
    assert.equal(findGroundingViolation('我會觀察其他人的動向'), '動向');
    assert.equal(findGroundingViolation('這個人在白天總是比較沉默'), '沉默');
    assert.equal(findGroundingViolation('行動也沒有太大舉動'), '舉動');
    assert.equal(findGroundingViolation('他看起來不像村人'), '不像村人');
    assert.equal(findGroundingViolation('看看誰比較有可能是村人'), '可能是村人');
    assert.equal(findGroundingViolation('他看起來不太像村人'), '不太像村人');
    assert.equal(findGroundingViolation('他可能是關鍵人物'), '關鍵人物');
    assert.equal(findGroundingViolation('他最近行動比較獨立'), '行動比較獨立');
    assert.equal(findGroundingViolation('今天大家都不說話'), '都不說話');
    assert.equal(findGroundingViolation('他看起來比較單薄'), '單薄');
    assert.equal(findGroundingViolation('這個人看起來有點孤獨'), '有點孤獨');
    assert.equal(findGroundingViolation('我很孤獨'), '');
    assert.equal(findGroundingViolation('可能藏有疑點'), '藏有疑點');
    assert.equal(findGroundingViolation('稍有異動'), '異動');
    assert.equal(findGroundingViolation('這個人看起來比較孤僻'), '孤僻');
    assert.equal(GROUNDING_VIOLATION_SEEDS.length, 34);
});
test('首夜捏造檢查：首夜攔、後夜放', () => {
    assert.equal(findFirstNightFabrication('他昨晚的行動引起我的注意'), '昨晚的行動');
    assert.equal(findFirstNightFabrication('他昨晚的行為很奇怪'), '昨晚的行為');
    assert.equal(findFirstNightFabrication('沒見過他昨晚的發言'), '昨晚的發言');
    assert.equal(findFirstNightFabrication('這個人在白天總是比較沉默'), '白天總是');
    assert.equal(findFirstNightFabrication('他白天一直很安靜'), '白天一直');
    assert.equal(findFirstNightFabrication('白天從來不發言'), '白天從來');
    assert.equal(findFirstNightFabrication('明天白天投票再說'), '');
    assert.equal(findFirstNightFabrication('我會在白天跟票'), '');
    assert.equal(findFirstNightFabrication('我沒想法，跟票。'), '');
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    const wolf = s.players.find((p) => p.alive && p.role === Role.WEREWOLF);
    const first = checkWolfDraft('他昨晚的行動值得注意。\n[決定:資訊不足]', s, wolf.id);
    assert.equal(first.kind, 'grounding');
    assert.equal(first.hit, '昨晚的行動');
    s.wolfDiscussionLog.push({ playerId: wolf.id, text: '先殺P5，直覺', day: s.day });
    assert.equal(checkWolfDraft('他昨晚的行動值得注意。\n[決定:資訊不足]', s, wolf.id), null);
});
test('簡體攔截：原文含簡體即拒（映射＋前科句）', () => {
    assert.equal(normalizeTraditional('选择P5'), '選擇P5');
    assert.equal(normalizeTraditional('我需要谨慎一点'), '我需要謹慎一點');
    assert.ok(simplifiedRejection('我需要谨慎一点').includes('簡體字'));
    assert.equal(simplifiedRejection('我需要謹慎一點'), '');
    assert.equal(simplifiedRejection(''), '');
});
test('簡體映射補字：决动无体击优处围变', () => {
    assert.equal(normalizeTraditional('决定'), '決定');
    assert.equal(normalizeTraditional('行动'), '行動');
    assert.equal(normalizeTraditional('无法'), '無法');
    assert.equal(normalizeTraditional('具体'), '具體');
    assert.equal(normalizeTraditional('出击'), '出擊');
    assert.equal(normalizeTraditional('优先'), '優先');
    assert.equal(normalizeTraditional('处理'), '處理');
    assert.equal(normalizeTraditional('周围'), '周圍');
    assert.equal(normalizeTraditional('变化'), '變化');
});
test('文本目標掃描：同盟／自指拒收、合法放行', () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    const wolves = s.players.filter((p) => p.alive && p.role === Role.WEREWOLF);
    const wolf = wolves[0];
    const ally = wolves[1] ?? wolves[0];
    const legal = s.players.find((p) => p.alive && p.role !== Role.WEREWOLF).id;
    const allyRej = checkWolfDraft(`今晚目標是P${ally.id}。\n[決定:資訊不足]`, s, wolf.id);
    assert.equal(allyRej.kind, 'target');
    assert.ok(allyRej.note.includes('也不可是同盟'));
    const selfRej = checkWolfDraft(`襲擊P${wolf.id}吧。\n[決定:資訊不足]`, s, wolf.id);
    assert.equal(selfRej.kind, 'target');
    assert.ok(selfRej.hit.startsWith('自指P'));
    assert.ok(selfRej.note.includes(`不能是你自己（P${wolf.id}）`));
    assert.equal(checkWolfDraft(`今晚目標是P${legal}。\n[決定:資訊不足]`, s, wolf.id), null);
});
test('WOLF_TARGET_RE 新動詞三分支＋lastIndex 重置', () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    const wolves = s.players.filter((p) => p.alive && p.role === Role.WEREWOLF);
    const wolf = wolves[0];
    const ally = wolves[1] ?? wolves[0];
    const legal = s.players.find((p) => p.alive && p.role !== Role.WEREWOLF).id;
    const stalk = checkWolfDraft(`今晚盯住P${ally.id}吧。\n[決定:資訊不足]`, s, wolf.id);
    assert.equal(stalk.kind, 'target');
    const duel = checkWolfDraft(`對P${ally.id}下手吧。\n[決定:資訊不足]`, s, wolf.id);
    assert.equal(duel.kind, 'target');
    assert.equal(checkWolfDraft(`針對P${legal}吧。\n[決定:資訊不足]`, s, wolf.id), null);
    const again = checkWolfDraft(`今晚盯住P${ally.id}吧。\n[決定:資訊不足]`, s, wolf.id);
    assert.equal(again.kind, 'target');
    assert.equal(again.hit, stalk.hit);
    // 盯著族（盯著／盯上／盯緊）＋對P動手同走 group
    const gaze = checkWolfDraft(`先盯著P${ally.id}吧。\n[決定:資訊不足]`, s, wolf.id);
    assert.equal(gaze.kind, 'target');
    const gazeUp = checkWolfDraft(`先盯上P${ally.id}吧。\n[決定:資訊不足]`, s, wolf.id);
    assert.equal(gazeUp.kind, 'target');
    const gazeTight = checkWolfDraft(`盯緊P${ally.id}。\n[決定:資訊不足]`, s, wolf.id);
    assert.equal(gazeTight.kind, 'target');
    const duel2 = checkWolfDraft(`對P${ally.id}動手吧。\n[決定:資訊不足]`, s, wolf.id);
    assert.equal(duel2.kind, 'target');
    // 殺掉分支（13 動詞；「殺掉P編號」同走 group1）
    const killOff = checkWolfDraft(`今晚的目標是殺掉P${ally.id}。\n[決定:資訊不足]`, s, wolf.id);
    assert.equal(killOff.kind, 'target');
    assert.equal(checkWolfDraft(`今晚的目標是殺掉P${legal}。\n[決定:資訊不足]`, s, wolf.id), null);
});
test('跨局 t 排序：不依文件序，取 t 最新', () => {
    const file = tmpLedger();
    const row = (t, who, kind, hit, text) => ({
        t, game: 'g', meeting: 'wolf', phase: 'first_pre', kind, hit, who, text, fixed: false,
    });
    appendPrecedents([
        row(300, 'P9/yuko', 'format', '缺旗標', '新句'),
        row(100, 'P1/rin', 'grounding', '有問題', '舊句rin'),
        row(200, 'P2/ren', 'lang', '英文超標', '舊句ren'),
    ], file);
    assert.equal(findCrossGamePrecedent('wolf', 'first_pre', 'yuko', file)?.text, '新句');
    assert.equal(findCrossGamePrecedent('wolf', 'first_pre', 'rin', file)?.text, '舊句rin');
    assert.equal(findCrossGamePrecedent('wolf', 'first_pre', 'nobody', file)?.text, '新句');
});
test('expand 兜底：兩次違規→回傳空→退回草稿文本＋沿草稿決策', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const file = tmpLedger();
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】'))
            return '草稿沒問題，但P5有問題。';
        const m = prompt.match(/今晚可襲擊：([^。\n]+)/);
        const ids = m ? [...m[1].matchAll(/P(\d+)/g)].map((x) => parseInt(x[1], 10)) : [5];
        return `先殺P${ids[0]}。\n[決定:殺P${ids[0]}]`;
    });
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000, ledgerFile: file });
    try {
        sch.onPhaseEntered(s);
        await flushN(5);
        assert.equal(llm.calls.filter((c) => c.kind === 'expand').length, 2, 'expand 違規應重試一次');
        const stash = sch.stashForTest();
        assert.ok(stash, '兜底應有暫存（草稿退回）');
        assert.ok(/^先殺P\d+。$/.test(stash.text), `應退回草稿文本，實得：${stash.text}`);
        assert.equal(stash.decision.status, 'decided');
        const rows = readPrecedents(file);
        assert.equal(rows.length, 2);
        assert.ok(rows.every((r) => r.phase === 'expand' && r.fixed === false));
        assert.ok(!rows.some((r) => r.text === stash.text), '兜底退回的乾淨草稿不應再記逃逸');
    }
    finally {
        sch.stop();
    }
});
test('簡體前科迴圈：原文簡體→lang 拒收重試→改過 fixed=true', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const file = tmpLedger();
    let first = true;
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】'))
            return 'P0：「沿用。」';
        if (first) {
            first = false;
            return '我需要谨慎一點。\n[決定:資訊不足]';
        }
        return '我沒想法。\n[決定:資訊不足]';
    });
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000, ledgerFile: file });
    try {
        sch.onPhaseEntered(s);
        await flushN(5);
        const retries = llm.calls.filter((c) => c.kind === 'pre_speech' && c.prompt.includes('被退回的草稿'));
        assert.equal(retries.length, 1);
        assert.ok(retries[0].prompt.includes('不得使用英文或簡體字'), '簡體版前科照抄');
        const rows = readPrecedents(file);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, 'lang');
        assert.equal(rows[0].hit, '簡體混入');
        assert.equal(rows[0].fixed, true);
    }
    finally {
        sch.stop();
    }
});
test('英文表命中：整詞才拒', () => {
    assert.equal(findEnglishWord('隨便指一個 anyone 吧'), 'anyone');
    assert.equal(findEnglishWord('Maybe 先殺P5'), 'maybe');
    assert.equal(findEnglishWord('保護同盟 members'), 'members');
    assert.equal(findEnglishWord('say no more'), 'no');
    assert.equal(findEnglishWord('behaviour 有些奇怪'), 'behaviour');
    assert.equal(findEnglishWord('behavior 有些奇怪'), 'behavior');
    assert.equal(findEnglishWord('tonight 的目標'), 'tonight');
    assert.equal(findEnglishWord('我覺得P5不錯'), '');
    assert.equal(findEnglishWord('沒有英文'), '');
    assert.equal(findEnglishWord('大家安靜點'), '');
});
test('expand 三層：seed／fab／eng 命中與放行', () => {
    assert.deepEqual(checkExpandViolation('P5有問題，先殺他', true), { kind: 'grounding', hit: '有問題' });
    assert.deepEqual(checkExpandViolation('他昨晚的行動值得注意', true), { kind: 'grounding', hit: '昨晚的行動' });
    assert.deepEqual(checkExpandViolation('maybe 去殺P5', true), { kind: 'lang', hit: '英文短詞(maybe)' });
    assert.equal(checkExpandViolation('我覺得今晚殺P5吧', true), null);
    assert.equal(checkExpandViolation('他昨晚的行動值得注意', false), null);
});
test('熔斷 a 漂移：expand 文本異數→整份退回草稿', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const file = tmpLedger();
    const legalIds = (prompt) => {
        const m = prompt.match(/今晚可襲擊：([^。\n]+)/) ?? prompt.match(/【今晚可襲擊的存活玩家】([^（\n]+)/);
        return m ? [...m[1].matchAll(/P(\d+)/g)].map((x) => parseInt(x[1], 10)) : [];
    };
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】')) {
            const ids = legalIds(prompt);
            return `我覺得今晚殺P${ids[1] ?? ids[0]}吧。`;
        }
        const ids = legalIds(prompt);
        const t = ids[0] ?? 5;
        return `先殺P${t}。\n[決定:殺P${t}]`;
    });
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000, ledgerFile: file });
    try {
        sch.onPhaseEntered(s);
        await flushN(5);
        const stash = sch.stashForTest();
        assert.ok(stash, '應有暫存');
        assert.ok(/^先殺P\d+。$/.test(stash.text), `漂移應退回草稿文本，實得：${stash.text}`);
        assert.equal(stash.decision.status, 'decided');
        assert.ok(sch.flagStats().decided > 0, '決策沿草稿保留 decided');
    }
    finally {
        sch.stop();
    }
});
test('熔斷 a 一致：expand 文本旗標皆合草稿→採信 expand', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const file = tmpLedger();
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】')) {
            const d = prompt.match(/殺P(\d+)/);
            const t = d ? d[1] : '5';
            return `我覺得今晚殺P${t}吧。\n[決定:殺P${t}]`;
        }
        const m = prompt.match(/今晚可襲擊：([^。\n]+)/);
        const ids = m ? [...m[1].matchAll(/P(\d+)/g)].map((x) => parseInt(x[1], 10)) : [5];
        return `先殺P${ids[0]}。\n[決定:殺P${ids[0]}]`;
    });
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000, ledgerFile: file });
    try {
        sch.onPhaseEntered(s);
        await flushN(5);
        const stash = sch.stashForTest();
        assert.ok(stash, '應有暫存');
        assert.ok(stash.text.includes('我覺得今晚'), `一致應採信 expand 文本，實得：${stash.text}`);
        assert.equal(stash.decision.status, 'decided');
    }
    finally {
        sch.stop();
    }
});
test('文旗救回：expand 無旗標但文本提名合法→轉 decided', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const file = tmpLedger();
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】')) {
            const m = prompt.match(/【今晚可襲擊的存活玩家】([^（\n]+)/);
            const ids = m ? [...m[1].matchAll(/P(\d+)/g)].map((x) => parseInt(x[1], 10)) : [5];
            return `我覺得殺P${ids[0]}吧。`;
        }
        return '沒想法。\n[決定:資訊不足]';
    });
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000, ledgerFile: file });
    try {
        sch.onPhaseEntered(s);
        await flushN(5);
        const stash = sch.stashForTest();
        assert.ok(stash, '應有暫存');
        const hit = /殺P(\d+)/.exec(stash.text);
        assert.ok(hit, `播出文本應含提名，實得：${stash.text}`);
        assert.deepEqual(stash.decision, { status: 'decided', target: parseInt(hit[1], 10) });
        assert.equal(readPrecedents(file).length, 0, '全程乾淨不應記賬');
    }
    finally {
        sch.stop();
    }
});
test('文旗救回：文本提名同盟→validate 擋回 abstain', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const file = tmpLedger();
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】')) {
            const m = prompt.match(/你的人狼同盟：(P\d+)/);
            const ally = m ? m[1].slice(1) : '1';
            return `我覺得殺P${ally}吧。`;
        }
        return '沒想法。\n[決定:資訊不足]';
    });
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000, ledgerFile: file });
    try {
        sch.onPhaseEntered(s);
        await flushN(5);
        const stash = sch.stashForTest();
        assert.ok(stash, '應有暫存（abstain 亦播出）');
        assert.deepEqual(stash.decision, { status: 'decided', target: 'abstain' });
    }
    finally {
        sch.stop();
    }
});
test('expand 英文：eng 重試→改過 fixed=true（kind=lang）', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const file = tmpLedger();
    let expandFirst = true;
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】')) {
            if (expandFirst) {
                expandFirst = false;
                return '我覺得maybe今晚殺P5。';
            }
            return '我覺得今晚殺P5。';
        }
        const m = prompt.match(/今晚可襲擊：([^。\n]+)/);
        const ids = m ? [...m[1].matchAll(/P(\d+)/g)].map((x) => parseInt(x[1], 10)) : [5];
        return `指一個，P${ids[0]}吧。\n[決定:殺P${ids[0]}]`;
    });
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000, ledgerFile: file });
    try {
        sch.onPhaseEntered(s);
        await flushN(5);
        assert.equal(llm.calls.filter((c) => c.kind === 'expand').length, 2, 'eng 應觸發 expand 重試');
        const rows = readPrecedents(file);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].phase, 'expand');
        assert.equal(rows[0].kind, 'lang');
        assert.equal(rows[0].hit, '英文短詞(maybe)');
        assert.equal(rows[0].fixed, true);
    }
    finally {
        sch.stop();
    }
});
test('expand 簡體：源頭攔截重試→改過 fixed=true（kind=lang）', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const file = tmpLedger();
    let expandFirst = true;
    const pickTarget = (prompt) => {
        const m = prompt.match(/今晚可襲擊：([^。\n]+)/);
        const ids = m ? [...m[1].matchAll(/P(\d+)/g)].map((x) => parseInt(x[1], 10)) : [5];
        return ids[0];
    };
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】')) {
            const t = pickTarget(prompt);
            if (expandFirst) {
                expandFirst = false;
                return `我觉得今晚杀P${t}。`;
            }
            return `我覺得今晚殺P${t}。`;
        }
        const t = pickTarget(prompt);
        return `先殺P${t}。\n[決定:殺P${t}]`;
    });
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000, ledgerFile: file });
    try {
        sch.onPhaseEntered(s);
        await flushN(5);
        const expands = llm.calls.filter((c) => c.kind === 'expand');
        assert.equal(expands.length, 2, '簡體應觸發 expand 源頭重試');
        assert.ok(expands[1].prompt.includes('不得使用英文或簡體字'), '簡體版前科照抄');
        const stash = sch.stashForTest();
        assert.ok(stash, '改過後應有暫存');
        assert.equal(simplifiedRejection(stash.text), '', '播出文本不應殘留簡體');
        const rows = readPrecedents(file);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].phase, 'expand');
        assert.equal(rows[0].kind, 'lang');
        assert.equal(rows[0].hit, '簡體混入');
        assert.equal(rows[0].fixed, true);
    }
    finally {
        sch.stop();
    }
});
test('loop2 門檻：賬本含乾淨 6 筆 loop1 真實＋回填（按 game 過濾，容測試污染）', () => {
    const rows = readPrecedents().filter((r) => r.game === 'gmtxnnias');
    assert.equal(rows.length, 6);
    assert.ok(rows.every((r) => r.fixed === false), '回填修正後全為 false');
    const hits = rows.map((r) => r.hit);
    for (const h of ['缺旗標', '可疑', '嫌疑', '疑慮', '異常'])
        assert.ok(hits.includes(h));
    assert.ok(rows.some((r) => r.phase === 'expand'), '應含 expand 筆');
    assert.ok(rows.some((r) => r.who === 'P7/tatuya'), '應含 P7 回填筆');
});
test('前科回寫兩版：違規版（首夜／後夜情境）＋格式版存在性', () => {
    const first = buildViolationRetryNote('我覺得P3有問題', '有問題', true);
    assert.ok(first.includes('被退回的草稿：「我覺得P3有問題」'), '應帶被退原文');
    assert.ok(first.includes('含「有問題」'), '應帶命中詞');
    assert.ok(first.includes('今晚沒有任何公開發言，你不可能知道任何人的事'), '首夜情境說明照抄');
    assert.ok(first.includes('不得重複被退句中的任何指控，也不得以換皮說法（如疑慮、嫌疑、異常、昨晚的行動等）重述同一指控。只談你自己的狀態：沒想法、隨便指一個目標、跟票、或交棒。'), '違規版強化指令照抄');
    const later = buildViolationRetryNote('P3沒表達觀點', '沒表達', false);
    assert.ok(later.includes('只能引用討論中實際出現的發言'), '後夜情境說明照抄');
    const format = buildFormatRetryNote('隨便指一個，P5吧。');
    assert.ok(format.includes('被退回的草稿：「隨便指一個，P5吧。」'), '格式版應帶被退原文');
    assert.ok(format.includes('[決定:殺P編號]') && format.includes('[決定:資訊不足]'), '格式版旗標二選一照抄');
    assert.ok(format.includes('方括號不可少'), '格式版括號要求照抄');
    assert.ok(format.includes('正確範例：我支持攻擊P3。\n[決定:殺P3]'), '格式版正例照抄');
    assert.ok(format.includes('文本與旗標一起重寫。'), '格式版重寫指令照抄');
    assert.ok(!format.includes('另：決定旗標'), '格式版已有正例，不另加提醒');
    assert.ok(buildLangRetryNote('vote P5').includes('另：決定旗標必須另起一行'), '英文版附格式提醒');
    assert.ok(!buildLangRetryNote('vote P5').includes('只談你自己的狀態'), '預設不帶自狀態指引（expand 用）');
    assert.ok(buildLangRetryNote('vote P5', true).includes('只談你自己的狀態：沒想法、隨便指一個目標、跟票、或交棒。'), 'pre 版帶自狀態指引');
    assert.ok(buildTargetRetryNote('殺P1', 1).includes('另：決定旗標必須另起一行'), '自指版附格式提醒');
    assert.ok(!first.includes('另：決定旗標'), '違規版不動（觀察對照）');
    for (const note of [first, later, format]) {
        assert.ok(!note.includes('上一句'), '不得用相對指代');
    }
});
// ---------- 外部積累賬本 ----------
/** 測試用賬本檔（系統暫存下獨立目錄，不污染 repo） */
function tmpLedger() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-ledger-'));
    return path.join(dir, 'precedents.jsonl');
}
test('賬本：寫讀往返＋上限 500 砍最舊＋壞行容錯', () => {
    const file = tmpLedger();
    assert.deepEqual(readPrecedents(file), []);
    const mk = (i) => ({
        t: i, game: 'g1', meeting: 'wolf', phase: 'first_pre', kind: 'grounding',
        hit: '有問題', who: `P${i}/rin`, text: `第${i}句`, fixed: i % 2 === 0,
    });
    appendPrecedents([mk(1), mk(2)], file);
    const two = readPrecedents(file);
    assert.equal(two.length, 2);
    assert.equal(two[0].text, '第1句');
    assert.equal(two[1].fixed, true);
    const many = Array.from({ length: PRECEDENTS_CAP + 1 }, (_, i) => mk(100 + i));
    appendPrecedents(many, file);
    const all = readPrecedents(file);
    assert.equal(all.length, PRECEDENTS_CAP);
    assert.equal(all[0].text, '第101句');
    fs.appendFileSync(file, 'not json\n', 'utf-8');
    assert.equal(readPrecedents(file).length, PRECEDENTS_CAP);
});
test('跨局讀取：同 persona 最新優先 → 同 phase 任一 → 無則 null；跨局句存在性', () => {
    const file = tmpLedger();
    const row = (t, phase, who, kind, hit, text) => ({
        t, game: 'g0', meeting: 'wolf', phase, kind, hit, who, text, fixed: false,
    });
    appendPrecedents([
        row(1, 'first_pre', 'P1/rin', 'grounding', '有問題', '舊句rin'),
        row(2, 'first_pre', 'P2/ren', 'format', '缺旗標', '舊句ren'),
        row(3, 'later_pre', 'P3/rin', 'lang', '英文超標', 'old words'),
    ], file);
    assert.equal(findCrossGamePrecedent('wolf', 'first_pre', 'rin', file)?.text, '舊句rin');
    assert.equal(findCrossGamePrecedent('wolf', 'first_pre', 'yuko', file)?.text, '舊句ren');
    assert.equal(findCrossGamePrecedent('wolf', 'expand', 'rin', file), null);
    assert.equal(findCrossGamePrecedent('day', 'first_pre', 'rin', file), null);
    const note = buildCrossGameNote(findCrossGamePrecedent('wolf', 'first_pre', 'rin', file));
    assert.equal(note, '過去同情境曾因含「有問題」的無源指控被退，不要重蹈（也不得以換皮說法重述同一指控）。');
    assert.ok(!note.includes('舊句rin'), '改版不再引前句全文');
    const fmtNote = buildCrossGameNote(findCrossGamePrecedent('wolf', 'first_pre', 'yuko', file));
    assert.equal(fmtNote, '過去同情境曾有format問題（缺旗標）被退，不要重蹈。');
    const targetNote = buildCrossGameNote({ t: 9, game: 'g0', meeting: 'wolf', phase: 'first_pre', kind: 'target', hit: '同盟P1', who: 'P2/ren', text: '殺P1吧', fixed: false });
    assert.equal(targetNote, '過去同情境曾因點名同盟為襲擊目標被退，不要重蹈（也不得以「同盟P編號」等字樣在發言中提及同盟）。');
});
test('三檢測：lang 邊界／target 三類／checkWolfDraft 命中放行', () => {
    assert.equal(isEnglishHeavy('tonight we should vote on P5'), true);
    assert.equal(isEnglishHeavy('我覺得P5不錯'), false);
    assert.equal(isEnglishHeavy('AB中文'), false);
    assert.equal(isEnglishHeavy('ABC中文'), true);
    assert.equal(isEnglishHeavy(''), false);
    assert.ok(buildLangRetryNote('vote P5').includes('必須使用繁體中文，不得使用英文或簡體字。重寫。'));
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    const wolves = s.players.filter((p) => p.alive && p.role === Role.WEREWOLF);
    const wolf = wolves[0];
    const ally = wolves[1] ?? wolves[0];
    const legal = s.players.find((p) => p.alive && p.role !== Role.WEREWOLF).id;
    assert.equal(illegalWolfTarget(s, wolf.id, wolf.id), `自指P${wolf.id}`);
    assert.equal(illegalWolfTarget(s, wolf.id, ally.id), wolf.id === ally.id ? `自指P${wolf.id}` : `同盟P${ally.id}`);
    assert.equal(illegalWolfTarget(s, wolf.id, 999), '非法P999');
    assert.equal(illegalWolfTarget(s, wolf.id, legal), '');
    const langRej = checkWolfDraft('tonight we vote P5\n決定:殺P5', s, wolf.id);
    assert.equal(langRej.kind, 'lang');
    assert.ok(langRej.note.includes('只談你自己的狀態'), 'pre lang 拒帶自狀態指引');
    const selfRej = checkWolfDraft(`先殺P${wolf.id}吧。\n[決定:殺P${wolf.id}]`, s, wolf.id);
    assert.equal(selfRej.kind, 'target');
    assert.ok(selfRej.note.includes(`不能是你自己（P${wolf.id}）`));
    assert.ok(buildTargetRetryNote('殺P1', wolf.id).includes('也不可是同盟'));
    const fmtRej = checkWolfDraft('我沒想法，再看看。', s, wolf.id);
    assert.equal(fmtRej.kind, 'format');
    assert.equal(checkWolfDraft(`隨便指一個，P${legal}吧。\n[決定:殺P${legal}]`, s, wolf.id), null);
    assert.equal(checkWolfDraft('我沒想法。\n[決定:資訊不足]', s, wolf.id), null);
});
test('簡轉繁正規化：遊戲高頻簡體字映射＋冪等', () => {
    assert.equal(normalizeTraditional('直覺說杀P5'), '直覺說殺P5');
    assert.equal(normalizeTraditional('P5不太对劲，先观察'), 'P5不太對勁，先觀察');
    assert.equal(normalizeTraditional('但還不确定是不是真的'), '但還不確定是不是真的');
    assert.equal(normalizeTraditional('我懷疑他，有证据吗？派他去臥底保护我方'), '我懷疑他，有證據嗎？派他去臥底保護我方');
    assert.equal(normalizeTraditional('已經是繁體：殺P5、對話'), '已經是繁體：殺P5、對話');
    assert.equal(normalizeTraditional(''), '');
    assert.equal(normalizeTraditional('我認為P3可能在说谎'), '我認為P3可能在說謊');
    // 只收無歧義字：只/面/里等多音多義字不動
    assert.equal(normalizeTraditional('只有裡面有只貓'), '只有裡面有只貓');
});
test('安全閥常數：MAX_UNCERTAIN_ROUNDS = 50', () => {
    assert.equal(MAX_UNCERTAIN_ROUNDS, 50);
});
// ---------- 白板更新驅動迴圈 ----------
test('迴圈：進場即開工；生產完成暫存（CD 內不播）；CD 到有貨播出＋decided 發言成功後 enqueue ready', async () => {
    const s = discussionState(9);
    const llm = defaultMock();
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        assert.ok(llm.calls.some((c) => c.kind === 'pre_speech'), '進場即開工生產');
        assert.ok(llm.calls.some((c) => c.kind === 'judge'), '應進入裁判');
        assert.ok(llm.calls.some((c) => c.kind === 'expand'), '應進入展開');
        assert.ok(sch.stashForTest(), '生產完成應暫存');
        assert.equal(events.length, 0, 'CD 內不廣播');
        const bvBefore = s.boardVersion;
        mock.timers.tick(60000);
        await flush();
        assert.equal(events.length, 2);
        assert.equal(events[0].type, 'AI_SPEECH_DONE');
        assert.equal(events[1].type, 'AI_READY_VOTE');
        if (events[0].type === 'AI_SPEECH_DONE') {
            assert.equal(events[0].boardVersion, bvBefore);
            assert.ok(events[0].text.length > 0);
            assert.ok(!events[0].text.includes('[決定'), 'flag 永不進白板');
        }
        if (events[1].type === 'AI_READY_VOTE') {
            assert.ok(!('boardVersion' in events[1]), 'AI_READY_VOTE 不帶版本');
        }
    }
    finally {
        sch.stop();
    }
});
test('純 AI 局 CD=0：做好就播（計時器保留）', async () => {
    const s = discussionState(9); // CLIENT_JOIN 全員 AI
    assert.ok(!s.players.some((p) => p.controlledBy === 'human'));
    const llm = defaultMock();
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        assert.ok(sch.stashForTest(), '生產完成暫存');
        assert.equal(events.length, 0);
        mock.timers.tick(1); // CD=0，滴答即到
        await flush();
        assert.equal(events[0].type, 'AI_SPEECH_DONE');
    }
    finally {
        sch.stop();
    }
});
test('中間更新→暫存作廢＋重跑＋CD 重啟：PRE_SPEECH 完成前版本變更 → 舊生產作廢，新生產用新白板跑完播出', async () => {
    const s = discussionState(9);
    let releasePre;
    const gate = new Promise((resolve) => { releasePre = resolve; });
    let preCount = 0;
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】'))
            return '展開文本';
        preCount++;
        if (preCount === 1)
            return gate;
        const m = prompt.match(/你是 P(\d+)/);
        return `P${m ? m[1] : '9'}：「草稿。」\n[決定:棄票]`;
    });
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000, preSpeechBatch: 9 });
    try {
        sch.onPhaseEntered(s);
        await flush();
        assert.ok(preCount >= 1, '管線應已啟動');
        // 中間白板更新（模擬 engine：log 落子＋版本++，再通知 scheduler）
        s.discussionLog.push({ playerId: 1, text: '真人發言', day: s.day });
        s.boardVersion++;
        const newVersion = s.boardVersion;
        sch.onBoardUpdated(s);
        await flush();
        assert.ok(preCount > 1, '應以新白板重跑生產');
        releasePre('P1：「第一則草稿。」\n[決定:棄票]');
        await flushN(3);
        // 舊生產作廢：暫存應為新一輪產物；CD 已重啟 → tick 滿才播
        assert.ok(sch.stashForTest(), '新一輪應完成暫存');
        assert.equal(events.length, 0, 'CD 重啟後未滿不播');
        mock.timers.tick(60000);
        await flush();
        assert.ok(events.some((e) => e.type === 'AI_SPEECH_DONE'), 'CD 到有貨播出');
        const speech = events.find((e) => e.type === 'AI_SPEECH_DONE');
        if (speech.type === 'AI_SPEECH_DONE') {
            assert.equal(speech.boardVersion, newVersion, '新一輪帶新版本');
        }
    }
    finally {
        sch.stop();
    }
});
test('版本作廢：JUDGE 完成前 boardVersion 變更 → 舊生產作廢，新生產用新白板跑完播出', async () => {
    const s = discussionState(9);
    let releaseJudge;
    const gate = new Promise((resolve) => { releaseJudge = resolve; });
    let judgeCalls = 0;
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】')) {
            judgeCalls++;
            return judgeCalls === 1 ? gate : judgeBySlotDesc(prompt);
        }
        if (prompt.includes('【你的預發言草稿】'))
            return '展開文本';
        const m = prompt.match(/你是 P(\d+)/);
        return `P${m ? m[1] : '1'}：「草稿。」\n[決定:棄票]`;
    });
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(2);
        assert.ok(llm.kinds().includes('judge'), '應已進入裁判');
        s.boardVersion++;
        const newVersion = s.boardVersion;
        sch.onBoardUpdated(s);
        releaseJudge('1: 9');
        await flushN(4);
        // 舊生產作廢；新生產跑完 → 暫存帶新版本；CD 未滿不播
        const stash = sch.stashForTest();
        assert.ok(stash, '新一輪應完成暫存');
        assert.equal(stash.boardVersion, newVersion);
        assert.equal(events.length, 0);
        mock.timers.tick(1000);
        await flush();
        const speech = events.find((e) => e.type === 'AI_SPEECH_DONE');
        assert.equal(speech.type, 'AI_SPEECH_DONE');
        if (speech.type === 'AI_SPEECH_DONE') {
            assert.equal(speech.boardVersion, newVersion, '播出帶新版本');
        }
    }
    finally {
        sch.stop();
    }
});
test('版本作廢：EXPAND 期間版本變更 → 作廢不播出（中間更新即重跑，無 commit 後不中斷）', async () => {
    const s = discussionState(9);
    let releaseExpand;
    const gate = new Promise((resolve) => { releaseExpand = resolve; });
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】'))
            return gate;
        return 'P1：「草稿。」\n[決定:棄票]';
    });
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        assert.ok(llm.kinds().includes('expand'), '應已進入展開');
        s.boardVersion++;
        sch.onBoardUpdated(s);
        releaseExpand('P1：「最終發言。」');
        await flushN(3);
        assert.ok(!events.some((e) => e.type === 'AI_SPEECH_DONE'), '舊展開作廢不播出');
    }
    finally {
        sch.stop();
    }
});
test('CD 到沒貨 → 等做好馬上播（無需再等一個 CD）', async () => {
    const s = discussionState(9);
    let releaseExpand;
    const gate = new Promise((resolve) => { releaseExpand = resolve; });
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】'))
            return gate;
        const m = prompt.match(/你是 P(\d+)/);
        return `P${m ? m[1] : '1'}：「草稿。」\n[決定:棄票]`;
    });
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        assert.ok(llm.kinds().includes('expand'), '生產卡在展開');
        mock.timers.tick(1500); // CD 到但沒貨
        await flush();
        assert.equal(events.length, 0, '沒貨不播');
        releaseExpand('P1：「最終發言。」');
        await flushN(2);
        assert.ok(events.some((e) => e.type === 'AI_SPEECH_DONE'), '做好馬上播');
    }
    finally {
        sch.stop();
    }
});
test('SELECT 價值制：有價值草稿勝出（decided+指名加分，不抽籤）', async () => {
    const s = discussionState(9);
    const aliveAI = s.players.filter((p) => p.alive && p.controlledBy === 'ai').map((p) => p.id);
    const star = Math.max(...aliveAI); // 刻意取最大 id：證明靠價值勝出而非 id 排序
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】')) {
            const slots = [];
            for (const m of prompt.matchAll(/^(\d+)\.\s/gm))
                slots.push(parseInt(m[1], 10));
            return slots.map((sl) => `${sl}: 5`).join('\n'); // 全同分 → 由價值制決勝
        }
        if (prompt.includes('【你的預發言草稿】'))
            return '展開文本';
        const m = prompt.match(/你是 P(\d+)/);
        const id = m ? parseInt(m[1], 10) : 1;
        if (id === star)
            return `P${id}：「我覺得 P5 很可疑，投他。」\n[決定:投P5]`;
        return `P${id}：「資訊還不足，想再聽聽大家的說法。」\n[決定:資訊不足]`;
    });
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        mock.timers.tick(1000); // CD 到有貨播出
        await flush();
        assert.equal(events.length, 2, 'decided 勝出 → 播出＋ready 共兩事件');
        assert.equal(events[0].type, 'AI_SPEECH_DONE');
        if (events[0].type === 'AI_SPEECH_DONE') {
            assert.equal(events[0].playerId, star, 'decided+指名草稿應以價值勝出');
        }
        assert.equal(events[1].type, 'AI_READY_VOTE');
        if (events[1].type === 'AI_READY_VOTE') {
            assert.equal(events[1].playerId, star);
        }
    }
    finally {
        sch.stop();
    }
});
test('SELECT 同分取 playerId 最小（全同分無價值差時確定性決勝）', async () => {
    const s = discussionState(9);
    const aliveAI = s.players.filter((p) => p.alive && p.controlledBy === 'ai').map((p) => p.id);
    const expect = Math.min(...aliveAI);
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】')) {
            const slots = [];
            for (const m of prompt.matchAll(/^(\d+)\.\s/gm))
                slots.push(parseInt(m[1], 10));
            return slots.map((sl) => `${sl}: 5`).join('\n'); // 全同分＋皆無價值 → 取 playerId 最小
        }
        if (prompt.includes('【你的預發言草稿】'))
            return '展開文本';
        const m = prompt.match(/你是 P(\d+)/);
        return `P${m ? m[1] : '1'}：「資訊還不足，想再聽聽大家的說法。」\n[決定:資訊不足]`;
    });
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        mock.timers.tick(1000);
        await flush();
        assert.equal(events[0].type, 'AI_SPEECH_DONE');
        if (events[0].type === 'AI_SPEECH_DONE') {
            assert.equal(events[0].playerId, expect, '全同分時 playerId 最小者勝出');
        }
    }
    finally {
        sch.stop();
    }
});
test('新穎性懲罰：重複內容被降分（墊底者不被選中）', async () => {
    const s = discussionState(6);
    // 當天討論先放一則與 A 相同的訊息
    const repeated = 'P3就是人狼大家快把票投給P3';
    s.discussionLog.push({ playerId: 2, text: repeated, day: s.day });
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】')) {
            const slots = [];
            for (const m of prompt.matchAll(/^(\d+)\.\s/gm))
                slots.push(parseInt(m[1], 10));
            return slots.map((sl) => `${sl}: 6`).join('\n'); // 全同分 → 靠新穎性決勝
        }
        if (prompt.includes('【你的預發言草稿】'))
            return '展開文本';
        if (prompt.includes('你是 P1'))
            return `P1：「${repeated}」`; // 與歷史重複
        if (prompt.includes('你是 P2'))
            return 'P2：「櫻花季的京都人潮洶湧」';
        if (prompt.includes('你是 P3'))
            return 'P3：「量子位元的同調時間延長」';
        if (prompt.includes('你是 P4'))
            return 'P4：「深海熱泉生態系很獨特」';
        return 'P9：「中立觀察中」';
    });
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        mock.timers.tick(1000);
        await flush();
        // 重複者被懲罰墊底 → 價值制下不應被選中（一律完整管線）
        const aliveAI = s.players.filter((p) => p.alive && p.controlledBy === 'ai').length;
        assert.ok(aliveAI > 2, '本案例需多候選人管線');
        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'AI_SPEECH_DONE');
        if (events[0].type === 'AI_SPEECH_DONE') {
            assert.notEqual(events[0].playerId, 1, '重複發言者應被新穎性懲罰壓到墊底而不被選中');
        }
    }
    finally {
        sch.stop();
    }
});
test('管線裁剪：草稿 ≤3 跳過 judge（直接展開照播）；4 草稿以上仍跑裁判', async () => {
    // 2 候選人 → 跳過 judge
    const s = discussionState(6);
    let kept = 0;
    for (const p of s.players) {
        if (p.controlledBy === 'ai' && p.alive && kept < 2) {
            kept++;
            continue;
        }
        if (p.controlledBy === 'ai')
            p.alive = false;
    }
    assert.equal(s.players.filter((p) => p.alive && p.controlledBy === 'ai').length, 2);
    const llm = defaultMock();
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        mock.timers.tick(1000);
        await flush();
        assert.ok(!llm.kinds().includes('judge'), '2 草稿應跳過裁判');
        assert.ok(llm.kinds().includes('expand'), '仍應展開');
        assert.equal(events[0].type, 'AI_SPEECH_DONE');
        assert.equal(events[1].type, 'AI_READY_VOTE');
    }
    finally {
        sch.stop();
    }
    // 4 候選人 → 跑裁判
    const s2 = discussionState(6);
    let kept2 = 0;
    for (const p of s2.players) {
        if (p.controlledBy === 'ai' && p.alive && kept2 < 4) {
            kept2++;
            continue;
        }
        if (p.controlledBy === 'ai')
            p.alive = false;
    }
    assert.equal(s2.players.filter((p) => p.alive && p.controlledBy === 'ai').length, 4);
    const llm2 = defaultMock();
    const { ctx: ctx2, events: events2 } = makeCtx(s2, llm2);
    const sch2 = new SpeechScheduler(ctx2, { cdMs: 1000 });
    try {
        sch2.onPhaseEntered(s2);
        await flushN(3);
        mock.timers.tick(1000);
        await flush();
        assert.ok(llm2.kinds().includes('judge'), '4 草稿應跑裁判');
        assert.equal(events2[0].type, 'AI_SPEECH_DONE');
    }
    finally {
        sch2.stop();
    }
});
test('管線裁剪：maxTokens judge=200、expand=100、pre_speech=100', async () => {
    const s = discussionState(9);
    const llm = defaultMock();
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        mock.timers.tick(1000);
        await flush();
        const cfgs = new Map(llm.calls.map((c) => [c.kind, c.config?.maxTokens]));
        assert.equal(cfgs.get('pre_speech'), 100);
        assert.equal(cfgs.get('judge'), 200);
        assert.equal(cfgs.get('expand'), 100);
    }
    finally {
        sch.stop();
    }
});
test('完整管線：mock 全確定性 → 最終 enqueue 正確 AI_SPEECH_DONE', async () => {
    const s = discussionState(9);
    const llm = defaultMock();
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 1000, preSpeechBatch: 3 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        mock.timers.tick(1000);
        await flush();
        const ev = events[0];
        assert.equal(ev.type, 'AI_SPEECH_DONE');
        if (ev.type === 'AI_SPEECH_DONE') {
            const speaker = s.players.find((p) => p.id === ev.playerId);
            assert.ok(speaker.alive && speaker.controlledBy === 'ai');
            assert.ok(ev.text.trim().length > 0);
            assert.equal(typeof ev.boardVersion, 'number');
        }
        // 發言皆經管線：預發言數 == 存活 AI 數（首輪無上輪發言者，全員草稿）
        const aliveAI = s.players.filter((p) => p.alive && p.controlledBy === 'ai').length;
        assert.equal(llm.kinds().filter((k) => k === 'pre_speech').length, aliveAI);
    }
    finally {
        sch.stop();
    }
});
test('onPhaseEntered 非討論 phase → 取消管線（不播出、不暫存）', async () => {
    const s = discussionState(9);
    const llm = defaultMock();
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
    try {
        sch.onPhaseEntered(s);
        await flush();
        assert.ok(llm.calls.length > 0, '管線應已啟動');
        s.phase = 'DAY_VOTING_COLLECTING';
        sch.onPhaseEntered(s);
        mock.timers.tick(120000);
        await flushN(2);
        assert.equal(events.length, 0, '離開討論後不應廣播');
        assert.equal(sch.stashForTest(), null);
    }
    finally {
        sch.stop();
    }
});
test('除上輪發言者外全員草稿：上輪發言者不列入候選；真人不寫草稿', async () => {
    const s = mixedDiscussionState();
    const aliveAI = s.players.filter((p) => p.alive && p.controlledBy === 'ai').map((p) => p.id);
    // 上輪發言者為某 AI
    const lastAI = aliveAI[0];
    s.discussionLog.push({ playerId: lastAI, text: '上一輪發言', day: s.day });
    const llm = defaultMock();
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        const pres = llm.calls.filter((c) => c.kind === 'pre_speech').map((c) => {
            const m = c.prompt.match(/你是 P(\d+)/);
            return m ? parseInt(m[1], 10) : -1;
        });
        assert.ok(!pres.includes(lastAI), '上輪發言者不應寫草稿');
        for (const id of aliveAI) {
            if (id === lastAI)
                continue;
            assert.ok(pres.includes(id), `存活 AI P${id} 應寫草稿`);
        }
        // 真人座位絕不出現於草稿 prompt
        for (const h of s.players.filter((p) => p.alive && p.controlledBy === 'human').map((p) => p.id)) {
            assert.ok(!pres.includes(h), `真人 P${h} 不寫草稿`);
        }
    }
    finally {
        sch.stop();
    }
});
test('唯一候選不斷線：僅剩一人時即使是上輪發言者也繼續（防僵局）', async () => {
    const s = discussionState(6);
    const lone = s.players.filter((p) => p.alive && p.controlledBy === 'ai')[0].id;
    for (const p of s.players) {
        if (p.id !== lone)
            p.alive = false;
    }
    s.discussionLog.push({ playerId: lone, text: '只剩我一人', day: s.day });
    const llm = defaultMock();
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(2);
        mock.timers.tick(5000);
        await flush();
        // 唯一候選不斷線：即使是上輪發言者也繼續生產（否則無人能推進白板，永久僵局；
        // 實戰中此態極少見，且 decided 草稿播出後即 ready 離場，不會無限自言自語）
        assert.ok(llm.calls.some((c) => c.kind === 'pre_speech'), '唯一候選應繼續生產');
    }
    finally {
        sch.stop();
    }
});
test('已就緒者排除候選：ready 的 AI 不再寫草稿（降噪加速收斂）', async () => {
    const s = discussionState(9);
    const readyAI = s.players.filter((p) => p.alive && p.controlledBy === 'ai')[0].id;
    transition(s, { type: 'AI_READY_VOTE', playerId: readyAI });
    assert.ok(s.voteReady.includes(readyAI));
    const llm = defaultMock();
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        const pres = llm.calls.filter((c) => c.kind === 'pre_speech').map((c) => {
            const m = c.prompt.match(/你是 P(\d+)/);
            return m ? parseInt(m[1], 10) : -1;
        });
        assert.ok(!pres.includes(readyAI), '已 ready 的 AI 不應寫草稿');
        assert.ok(pres.length > 0, '未 ready 者應繼續生產');
    }
    finally {
        sch.stop();
    }
});
test('跳過按鈕保留但不驅動迴圈：HUMAN_SKIP 不重啟 CD、不另開生產', async () => {
    const s = mixedDiscussionState();
    const humans = s.players.filter((p) => p.alive && p.controlledBy === 'human').map((p) => p.id);
    assert.ok(humans.length >= 1);
    const llm = defaultMock();
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        const preBefore = llm.kinds().filter((k) => k === 'pre_speech').length;
        assert.ok(preBefore > 0, '首輪生產應已啟動');
        // 真人跳過（transition 不 bump 版本；scheduler 未被通知 → 不重跑）
        for (const h of humans)
            transition(s, { type: 'HUMAN_SKIP', playerId: h });
        await flush();
        const preAfter = llm.kinds().filter((k) => k === 'pre_speech').length;
        assert.equal(preAfter, preBefore, '跳過不應另開生產');
        assert.ok(sch.stashForTest(), '原暫存保留');
        mock.timers.tick(60000);
        await flush();
        const speeches = events.filter((e) => e.type === 'AI_SPEECH_DONE');
        assert.equal(speeches.length, 1, '原 CD 到點播出一次');
    }
    finally {
        sch.stop();
    }
});
test('expand 輸出清洗：模型自帶 flag 亦剝離才播出', async () => {
    const s = discussionState(9);
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】'))
            return 'P0：「展開文本」\n[決定:投P3]';
        const m = prompt.match(/你是 P(\d+)/);
        return `P${m ? m[1] : '1'}：「草稿。」\n[決定:棄票]`;
    });
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        mock.timers.tick(1000);
        await flush();
        const speech = events.find((e) => e.type === 'AI_SPEECH_DONE');
        assert.equal(speech.type, 'AI_SPEECH_DONE');
        if (speech.type === 'AI_SPEECH_DONE') {
            assert.ok(!speech.text.includes('[決定'), 'broadcast 前應清洗 expand 輸出');
            assert.equal(speech.text, '「展開文本」', 'broadcast 前應剝離 Px：前綴');
        }
    }
    finally {
        sch.stop();
    }
});
test('生產失敗 → 預設 60 秒後重試（重試前不播出）', async () => {
    const s = discussionState(9);
    let calls = 0;
    const llm = new MockLLM(() => {
        calls++;
        throw new Error('llm down');
    });
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(2);
        const c1 = calls;
        assert.ok(c1 > 0, '首輪生產應已嘗試');
        assert.equal(events.length, 0);
        mock.timers.tick(59999);
        await flush();
        assert.equal(calls, c1, '60 秒未滿不重試');
        mock.timers.tick(1);
        await flushN(2);
        assert.ok(calls > c1, '60 秒到重試生產');
        assert.equal(events.length, 0, '重試前不播出');
    }
    finally {
        sch.stop();
    }
});
test('重試間隔 env 可調（SPEECH_RETRY_MS）', async () => {
    const prev = process.env.SPEECH_RETRY_MS;
    process.env.SPEECH_RETRY_MS = '5000';
    try {
        const s = discussionState(9);
        let calls = 0;
        const llm = new MockLLM(() => {
            calls++;
            throw new Error('llm down');
        });
        const { ctx } = makeCtx(s, llm);
        const sch = new SpeechScheduler(ctx, { cdMs: 1000 });
        try {
            sch.onPhaseEntered(s);
            await flushN(2);
            const c1 = calls;
            mock.timers.tick(4999);
            await flush();
            assert.equal(calls, c1, '5 秒未滿不重試');
            mock.timers.tick(1);
            await flushN(2);
            assert.ok(calls > c1, 'env 指定 5 秒到重試');
        }
        finally {
            sch.stop();
        }
    }
    finally {
        if (prev === undefined)
            delete process.env.SPEECH_RETRY_MS;
        else
            process.env.SPEECH_RETRY_MS = prev;
    }
});
test('安全閥：連續資訊不足達上限 → 強制 decided，發言成功後 enqueue ready；decided 重置計數', async () => {
    const s = discussionState(6);
    const llm = uncertainMock();
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 100, maxUncertainRounds: 3 });
    try {
        // 第 1 輪（首輪無上輪發言者，全員草稿）：計數皆 1，無 ready
        sch.onPhaseEntered(s);
        await flushN(3);
        mock.timers.tick(100);
        await flush();
        const round1AI = s.players.filter((p) => p.alive && p.controlledBy === 'ai').map((p) => p.id);
        for (const id of round1AI)
            assert.equal(sch.uncertainCountForTest(id), 1);
        assert.ok(!events.some((e) => e.type === 'AI_READY_VOTE'), '未達安全閥不 enqueue ready');
        // 後續輪（每輪播出即版本推進）：草稿達 3 次上限 → 強制 decided → 播出後 enqueue ready
        // （同分取 playerId 最小＋連播懲罰輪轉，收斂本身有界）
        let readyPid = -1;
        for (let r = 0; r < 12 && readyPid < 0; r++) {
            sch.onBoardUpdated(s);
            await flushN(3);
            mock.timers.tick(100);
            await flush();
            const ready = events.find((e) => e.type === 'AI_READY_VOTE');
            if (ready && ready.type === 'AI_READY_VOTE')
                readyPid = ready.playerId;
        }
        assert.ok(readyPid >= 0, '安全閥強制 decided 後應 enqueue ready');
        assert.equal(sch.uncertainCountForTest(readyPid), 0, 'decided 後計數重置');
    }
    finally {
        sch.stop();
    }
});
test('flagStats：decided／棄票／資訊不足計數＋隔天歸零', async () => {
    const s = discussionState(6);
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】'))
            return '展開文本';
        const m = prompt.match(/你是 P(\d+)/);
        const id = m ? parseInt(m[1], 10) : 1;
        if (id % 3 === 1)
            return `P${id}：投P2。\n[決定:投P2]`;
        if (id % 3 === 2)
            return `P${id}：棄票。\n[決定:棄票]`;
        return `P${id}：資訊還不足，想再聽聽大家的說法。`;
    });
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 600000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        const exp = { decided: 0, abstain: 0, uncertain: 0 };
        for (const p of s.players) {
            if (!p.alive || p.controlledBy !== 'ai')
                continue;
            if (p.id % 3 === 1)
                exp.decided++;
            else if (p.id % 3 === 2)
                exp.abstain++;
            else
                exp.uncertain++;
        }
        assert.deepEqual(sch.flagStats(), exp);
        // 隔天進場 → 同步歸零（後續非同步生產尚未跑，不影響斷言）
        sch.onPhaseEntered({ ...s, day: s.day + 1 });
        assert.deepEqual(sch.flagStats(), { decided: 0, abstain: 0, uncertain: 0 });
    }
    finally {
        sch.stop();
    }
});
test('flagStats：安全閥強制 abstain 計入棄票', async () => {
    const s = discussionState(6);
    const { ctx } = makeCtx(s, uncertainMock());
    const sch = new SpeechScheduler(ctx, { cdMs: 600000, maxUncertainRounds: 1 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        const aliveAi = s.players.filter((p) => p.alive && p.controlledBy === 'ai').length;
        assert.deepEqual(sch.flagStats(), { decided: 0, abstain: aliveAi, uncertain: 0 });
    }
    finally {
        sch.stop();
    }
});
// ---------- Phase 2：全真人跳過 → 立即管線 ----------
function mixedDiscussionState() {
    const s = createGameState(9);
    transition(s, { type: 'HUMAN_JOIN', playerId: 3, name: 'H1' });
    transition(s, { type: 'HUMAN_JOIN', playerId: 7, name: 'H2' });
    for (let id = 1; id <= 9; id++) {
        if (!s.players.some((p) => p.id === id))
            transition(s, { type: 'AI_JOIN', playerId: id });
    }
    transition(s, { type: 'START_GAME' });
    convergeWolfDiscussion(s);
    const keep = [3, 7];
    const alive = s.players.filter((p) => p.alive).map((p) => p.id);
    for (const pid of getNightActors(s)) {
        const me = s.players.find((p) => p.id === pid);
        let pool = alive.filter((id) => id !== pid && !keep.includes(id));
        if (me.role === Role.WEREWOLF) {
            pool = pool.filter((id) => s.players.find((p) => p.id === id).team !== 'werewolf');
        }
        if (pool.length === 0)
            pool = alive.filter((id) => id !== pid);
        transition(s, me.controlledBy === 'human'
            ? { type: 'HUMAN_NIGHT_ACTION', playerId: pid, targetId: pool[0] }
            : { type: 'AI_NIGHT_DONE', playerId: pid, targetId: pool[0] });
    }
    transition(s, { type: 'RESOLVE_NIGHT' });
    assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
    return s;
}
test('混合局：進場即全員草稿開工（不等任何門檻；quiet 已拔除）', async () => {
    const s = mixedDiscussionState();
    const humans = s.players.filter((p) => p.alive && p.controlledBy === 'human').map((p) => p.id);
    assert.ok(humans.length >= 1);
    const llm = defaultMock();
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 600000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        assert.ok(llm.calls.some((c) => c.kind === 'pre_speech'), '進場即開工，不等 quiet／跳過');
        assert.ok(sch.stashForTest(), '生產完成暫存');
        void events;
    }
    finally {
        sch.stop();
    }
});
test('狼模式：進場即狼草稿開工；CD 到播 AI_WOLF_SPEECH_DONE + decided 後 AI_WOLF_READY', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const llm = defaultMock();
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        const pres = llm.calls.filter((c) => c.kind === 'pre_speech');
        assert.ok(pres.length > 0, '狼模式應生產預發言');
        for (const c of pres) {
            assert.ok(c.prompt.includes('今晚') || c.prompt.includes('襲擊'), '狼預發言應為狼 prompt');
        }
        assert.ok(sch.stashForTest(), '生產完成應暫存');
        assert.equal(events.length, 0, 'CD 內不廣播');
        const bvBefore = s.boardVersion;
        mock.timers.tick(60000);
        await flush();
        assert.ok(events.length >= 1);
        assert.equal(events[0].type, 'AI_WOLF_SPEECH_DONE');
        if (events[0].type === 'AI_WOLF_SPEECH_DONE') {
            assert.equal(events[0].boardVersion, bvBefore);
            assert.ok(!events[0].text.includes('[決定'), 'flag 永不進白板');
        }
        assert.ok(events.some((e) => e.type === 'AI_WOLF_READY'), 'decided 發言後應 enqueue AI_WOLF_READY');
    }
    finally {
        sch.stop();
    }
});
test('狼模式候選：僅存活 AI 狼（不含 seer/guard/真人）', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const llm = defaultMock();
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        const pres = llm.calls.filter((c) => c.kind === 'pre_speech').map((c) => {
            const m = c.prompt.match(/你是 P(\d+)/);
            return m ? parseInt(m[1], 10) : -1;
        });
        const expectWolves = s.players.filter((p) => p.alive && p.controlledBy === 'ai' && p.role === Role.WEREWOLF).map((p) => p.id);
        assert.ok(expectWolves.length >= 1);
        assert.deepEqual([...pres].sort((a, b) => a - b), [...expectWolves].sort((a, b) => a - b));
        const seer = s.players.find((p) => p.role === Role.SEER);
        assert.ok(!pres.includes(seer.id), 'seer 不應列入狼候選');
    }
    finally {
        sch.stop();
    }
});
test('狼模式：決策目標是同盟/自己 → 拒收重試，耗盡判資訊不足（不計 decided、不播出）', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const wolves = s.players.filter((p) => p.alive && p.role === Role.WEREWOLF);
    const allyId = wolves[0].id;
    const file = tmpLedger();
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】'))
            return 'P0：「展開。」';
        const m = prompt.match(/你是 P(\d+)/);
        const id = m ? m[1] : '1';
        return `P${id}：「建議襲擊P${allyId}。」\n[決定:殺P${allyId}]`;
    });
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000, ledgerFile: file });
    try {
        sch.onPhaseEntered(s);
        await flushN(5);
        assert.equal(sch.flagStats().decided, 0, '同盟目標不應計為 decided');
        assert.equal(sch.flagStats().uncertain, wolves.length, '耗盡應兜底資訊不足');
        assert.ok(!events.some((e) => e.type === 'AI_WOLF_SPEECH_DONE'), '拒收耗盡不應播出');
        const retries = llm.calls.filter((c) => c.kind === 'pre_speech' && c.prompt.includes('被退回的草稿'));
        assert.ok(retries.length > 0, '應帶自指版前科重試');
        assert.ok(retries[0].prompt.includes('也不可是同盟'), '自指版前科照抄');
        const rows = readPrecedents(file);
        assert.ok(rows.length > 0 && rows.every((r) => r.kind === 'target' && r.fixed === false), '賬本記 target 且 fixed=false');
    }
    finally {
        sch.stop();
    }
});
test('前科迴圈：違規→重試帶前科→改過自新記 fixed=true', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const file = tmpLedger();
    let first = true;
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】'))
            return 'P0：「沿用。」';
        if (first) {
            first = false;
            return '我覺得P5有問題，先殺他。';
        }
        return '我沒想法。\n[決定:資訊不足]';
    });
    const { ctx } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000, ledgerFile: file });
    try {
        sch.onPhaseEntered(s);
        await flushN(5);
        const retries = llm.calls.filter((c) => c.kind === 'pre_speech' && c.prompt.includes('被退回的草稿'));
        assert.equal(retries.length, 1);
        assert.ok(retries[0].prompt.includes('含「有問題」'), '違規版前科帶命中詞');
        const rows = readPrecedents(file);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, 'grounding');
        assert.equal(rows[0].fixed, true);
        assert.ok(rows[0].who.startsWith('P'));
    }
    finally {
        sch.stop();
    }
});
test('兜底：2 attempt 仍犯→棄權（資訊不足、不播出）＋賬本 fixed=false', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const wolves = s.players.filter((p) => p.alive && p.role === Role.WEREWOLF);
    const file = tmpLedger();
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】'))
            return 'P0：「沿用。」';
        return '我覺得P5有問題，先殺他。';
    });
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000, ledgerFile: file });
    try {
        sch.onPhaseEntered(s);
        await flushN(5);
        const pres = llm.calls.filter((c) => c.kind === 'pre_speech');
        assert.equal(pres.length, wolves.length * 2, '每候選皆用滿 2 attempt');
        assert.ok(pres.some((c) => c.prompt.includes('被退回的草稿')), '第二輪帶前科');
        assert.equal(sch.stashForTest(), null, '全棄權則無暫存');
        assert.ok(!events.some((e) => e.type === 'AI_WOLF_SPEECH_DONE'), '不播錯');
        assert.deepEqual(sch.flagStats(), { decided: 0, abstain: 0, uncertain: wolves.length });
        const rows = readPrecedents(file);
        assert.equal(rows.length, wolves.length * 2);
        assert.ok(rows.every((r) => r.fixed === false && r.kind === 'grounding'));
    }
    finally {
        sch.stop();
    }
});
test('狼模式：expand 決策優先 — pre_speech 資訊不足但 expand 殺P → 計 decided 且播出後 AI_WOLF_READY', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const target = s.players.find((p) => p.alive && p.role !== Role.WEREWOLF).id;
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        if (prompt.includes('【你的預發言草稿】'))
            return `P0：「我決定襲擊P${target}。」\n[決定:殺P${target}]`;
        const m = prompt.match(/你是 P(\d+)/);
        const id = m ? m[1] : '1';
        return `P${id}：「資訊還不足，我無法決定，想再聽聽大家的說法。」\n[決定:資訊不足]`;
    });
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        assert.equal(sch.flagStats().decided, 1, 'expand 已決定 → 應計為 decided');
        mock.timers.tick(60000);
        await flush();
        assert.ok(events.some((e) => e.type === 'AI_WOLF_READY'), 'expand 已決定 → 播出後應 enqueue AI_WOLF_READY');
    }
    finally {
        sch.stop();
    }
});
test('狼模式：expand 旗標與草稿決策矛盾 → 沿用草稿決策（旗標失誤不採信）', async () => {
    const s = createGameState(9);
    for (let i = 0; i < 9; i++)
        transition(s, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
    transition(s, { type: 'START_GAME' });
    assert.equal(s.phase, 'NIGHT_DISCUSSION_OPEN');
    const wolves = s.players.filter((p) => p.alive && p.role === Role.WEREWOLF);
    const ally = wolves[1]; // 旗標誤填的同盟（無效目標）
    const draftTarget = s.players.find((p) => p.alive && p.role !== Role.WEREWOLF).id; // 草稿決策目標
    const llm = new MockLLM((prompt) => {
        if (prompt.includes('【裁判任務】'))
            return judgeBySlotDesc(prompt);
        // expand：正文沿用草稿目標，旗標卻誤填同盟（模擬 v5 觀察到的旗標失誤）
        if (prompt.includes('【你的預發言草稿】'))
            return `P0：「我覺得今晚殺P${draftTarget}比較順便。」\n[決定:殺P${ally.id}]`;
        const m = prompt.match(/你是 P(\d+)/);
        const id = m ? m[1] : '1';
        return `P${id}：「直覺上P${draftTarget}，沒什麼特別依據。」\n[決定:殺P${draftTarget}]`;
    });
    const { ctx, events } = makeCtx(s, llm);
    const sch = new SpeechScheduler(ctx, { cdMs: 60000 });
    try {
        sch.onPhaseEntered(s);
        await flushN(3);
        // 防護生效：expand 誤填旗標（同盟）不採信 → 沿用草稿 decided；若採信旗標會被 validateWolfTarget 轉棄票
        assert.equal(sch.flagStats().abstain, 0, '矛盾回退草稿 → 不應產生棄票');
        assert.equal(sch.flagStats().decided, wolves.length, '兩狼草稿決策皆應保留為 decided');
        mock.timers.tick(60000);
        await flush();
        // 勝出者由 judge 決定（slot 降序），ready 事件應存在且屬於某匹存活狼
        const wolfIds = new Set(wolves.map((w) => w.id));
        assert.ok(events.some((e) => e.type === 'AI_WOLF_READY' && wolfIds.has(e.playerId)), '草稿 decided → 播出後應 ready');
    }
    finally {
        sch.stop();
    }
});
void Role;
//# sourceMappingURL=ai-scheduler.test.js.map