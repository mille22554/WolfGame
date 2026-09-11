/**
 * character-session.test.ts — buildPrompt / summarizeDay / 截斷測試
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, summarizeDay, buildPreSpeechPrompt, buildJudgePrompt, buildExpandPrompt, PRE_SPEECH_BUDGET, buildWolfPreSpeechPrompt, buildWolfExpandPrompt, summarizeWolfDiscussion } from './character-session.js';
import { createGameState, transition, getNightActors } from './game-state.js';
import { Role } from './types.js';
function joinAll(state, count) {
    for (let i = 0; i < count; i++)
        transition(state, { type: 'CLIENT_JOIN', name: `P${i + 1}` });
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
function discussionState(count = 9) {
    const s = createGameState(count);
    joinAll(s, count);
    transition(s, { type: 'START_GAME' });
    convergeWolfDiscussion(s);
    transition(s, { type: 'ACTION_TIMEOUT', gateId: 'night-1' });
    transition(s, { type: 'RESOLVE_NIGHT' });
    assert.equal(s.phase, 'DAY_DISCUSSION_OPEN');
    return s;
}
function aliveIds(s) {
    return s.players.filter((p) => p.alive).map((p) => p.id);
}
test('buildPrompt 含角色卡/規則/公開知識/私有知識/當天討論/摘要/任務指令', () => {
    const s = discussionState();
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    transition(s, { type: 'HUMAN_SPEAK', playerId: aliveIds(s)[0], text: '大家早安' });
    s.daySummaries.push('第0天摘要標記');
    const prompt = buildPrompt(s, wolf.id, 'speech');
    assert.ok(prompt.includes('人格設定'));
    assert.ok(prompt.includes('公開知識'));
    assert.ok(prompt.includes('你的編號'));
    assert.ok(prompt.includes('人狼同盟')); // 狼私有知識
    assert.ok(prompt.includes('大家早安')); // 當天討論
    assert.ok(prompt.includes('第0天摘要標記')); // 歷史摘要
    assert.ok(prompt.includes('任務')); // 任務指令
});
test('buildPrompt 私有知識依角色：seer 有查驗紀錄', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    convergeWolfDiscussion(s);
    const seer = s.players.find((p) => p.role === Role.SEER);
    for (const pid of getNightActors(s)) {
        transition(s, { type: 'AI_NIGHT_DONE', playerId: pid, targetId: aliveIds(s).filter((id) => id !== pid)[0] });
    }
    transition(s, { type: 'RESOLVE_NIGHT' });
    const prompt = buildPrompt(s, seer.id, 'night');
    assert.ok(prompt.includes('查驗紀錄'));
});
test('截斷：超長討論 → 先丟 daySummary 再丟當天最舊', () => {
    const s = discussionState();
    const speaker = aliveIds(s)[0];
    const filler = '填充'.repeat(25); // 每則約 50+ 字
    for (let i = 0; i < 60; i++) {
        transition(s, { type: 'HUMAN_SPEAK', playerId: speaker, text: `發言${i}${filler}` });
    }
    s.daySummaries.push('摘要標記應被先丟棄' + filler);
    const full = buildPrompt(s, speaker, 'speech', 1_000_000);
    assert.ok(full.includes('發言0'));
    assert.ok(full.includes('摘要標記應被先丟棄'));
    const budget = full.length - 2000;
    const truncated = buildPrompt(s, speaker, 'speech', budget);
    assert.ok(truncated.length < full.length);
    assert.ok(!truncated.includes('摘要標記應被先丟棄'), 'daySummary 應先被丟棄');
    assert.ok(!truncated.includes('發言0'), '當天最舊討論應被丟棄');
    assert.ok(truncated.includes('發言59'), '最新討論應保留');
});
test('跨日分隔線：多天討論以 === 第N天 === 分隔；單日時無分隔線', () => {
    const s = discussionState();
    const speaker = aliveIds(s)[0];
    transition(s, { type: 'HUMAN_SPEAK', playerId: speaker, text: '今天第一句' });
    // 單日：無分隔線（與舊輸出一致）
    const single = buildPrompt(s, speaker, 'speech', 1_000_000);
    assert.ok(single.includes('今天第一句'));
    assert.ok(!single.includes('=== 第'), '單日時不應有分隔線');
    // 跨日：直接塞前一天紀錄，prompt 應出現分隔線＋兩天內容
    const today = s.day;
    s.discussionLog.unshift({ playerId: speaker, text: '昨天說過的話', day: today - 1 });
    const multi = buildPrompt(s, speaker, 'speech', 1_000_000);
    assert.ok(multi.includes(`=== 第${today - 1}天 ===`), '應有前一天分隔線');
    assert.ok(multi.includes(`=== 第${today}天 ===`), '應有當天分隔線');
    assert.ok(multi.includes('昨天說過的話'), '應保留前一天內容');
    assert.ok(multi.includes('今天第一句'), '應保留當天內容');
    // 分隔線順序：舊天在前
    assert.ok(multi.indexOf(`=== 第${today - 1}天 ===`) < multi.indexOf(`=== 第${today}天 ===`), '天數應由舊到新');
});
test('跨日分隔線：狼討論跨日時同樣分隔', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    s.wolfDiscussionLog.push({ playerId: wolf.id, text: '昨晚說殺P3', day: s.day });
    // 推進一天（不清空狼紀錄）：直接改 day 模擬跨日
    const nextDay = s.day + 1;
    s.day = nextDay;
    s.wolfDiscussionLog.push({ playerId: wolf.id, text: '今晚改殺P5', day: nextDay });
    const prompt = buildPrompt(s, wolf.id, 'wolf_speech', 1_000_000);
    assert.ok(prompt.includes('=== 第1天 ==='), '應有前一晚分隔線');
    assert.ok(prompt.includes('=== 第2天 ==='), '應有今晚分隔線');
    assert.ok(prompt.includes('昨晚說殺P3'), '應保留前一晚內容');
    assert.ok(prompt.includes('今晚改殺P5'), '應保留今晚內容');
});
test('buildPrompt 預設預算 4000：超量輸入截到 ≤4000（daySummaries 機制保留）', () => {
    const s = discussionState();
    const speaker = aliveIds(s)[0];
    const filler = '填充'.repeat(50); // 每則約 100+ 字，60 則遠超預算
    for (let i = 0; i < 60; i++) {
        transition(s, { type: 'HUMAN_SPEAK', playerId: speaker, text: `發言${i}${filler}` });
    }
    s.daySummaries.push('摘要標記' + filler);
    const prompt = buildPrompt(s, speaker, 'speech');
    assert.ok(prompt.length <= 4000, `預設預算 prompt ${prompt.length} 字元應 ≤ 4000`);
    assert.ok(prompt.includes('發言59'), '最新討論應保留');
});
test('summarizeDay 格式：top3 指控 + 投票結果', () => {
    const s = discussionState();
    const ids = aliveIds(s);
    const [a, b, c] = ids;
    transition(s, { type: 'HUMAN_SPEAK', playerId: a, text: `我懷疑 P${b}，他很可疑` });
    transition(s, { type: 'HUMAN_SPEAK', playerId: c, text: `我也覺得 P${b} 有問題，票投 P${b}` });
    transition(s, { type: 'HUMAN_SPEAK', playerId: b, text: '我是好人' });
    const summary = summarizeDay(s, s.day);
    assert.ok(summary.includes(`第${s.day}天摘要`));
    assert.ok(summary.includes(`P${b}`));
});
test('buildPreSpeechPrompt：輕量段落齊全、≤ 2000 字元', () => {
    const s = discussionState();
    const speaker = aliveIds(s)[0];
    transition(s, { type: 'HUMAN_SPEAK', playerId: speaker, text: '大家早安，今天多聽聽' });
    s.daySummaries.push('第0天摘要標記');
    const prompt = buildPreSpeechPrompt(s, speaker);
    assert.ok(prompt.includes('人格設定'), '草稿帶人格：人格是決策依據');
    assert.ok(prompt.includes('persona:'), '草稿帶人格：含 agents.md 內容');
    assert.ok(prompt.includes('你的角色資訊'));
    assert.ok(prompt.includes('當天摘要'));
    assert.ok(prompt.includes('第0天摘要標記'));
    assert.ok(prompt.includes('最近討論'));
    assert.ok(prompt.includes('大家早安'));
    assert.ok(prompt.includes('預發言草稿'));
    assert.ok(prompt.includes('嚴禁任何簡體字'), '白天草稿應明令禁止簡體字');
    assert.ok(prompt.length <= PRE_SPEECH_BUDGET, `預發言 prompt ${prompt.length} 字元應 ≤ ${PRE_SPEECH_BUDGET}`);
});
test('buildJudgePrompt：全盲（打亂匿名、不含 P 編號）+ 評分指令', () => {
    const prompt = buildJudgePrompt('第1天摘要標記', [
        { slot: 1, text: '今天氣氛有點緊張' },
        { slot: 2, text: '多聽聽大家的說法' },
    ]);
    assert.ok(prompt.includes('第1天摘要標記'));
    assert.ok(prompt.includes('1. 今天氣氛有點緊張'));
    assert.ok(prompt.includes('2. 多聽聽大家的說法'));
    assert.ok(prompt.includes('裁判任務'));
    assert.ok(!/P\d+/.test(prompt), '裁判 prompt 不得含 P 編號');
});
test('buildExpandPrompt：標準 speech prompt + 草稿附加', () => {
    const s = discussionState();
    const speaker = aliveIds(s)[0];
    const draft = 'P9：「我比較在意沉默的人。」';
    const prompt = buildExpandPrompt(s, speaker, draft);
    assert.ok(prompt.includes('任務'), '應含標準 speech 任務指令');
    assert.ok(prompt.includes('你的預發言草稿'));
    assert.ok(prompt.includes(draft));
});
test('buildWolfPreSpeechPrompt：含襲擊/今晚語境 + 殺P 決策旗標指示', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    const prompt = buildWolfPreSpeechPrompt(s, wolf.id);
    assert.ok(prompt.includes('今晚') || prompt.includes('襲擊'));
    assert.ok(prompt.includes('殺P'));
    assert.ok(prompt.includes('資訊不足'));
});
test('狼 prompt：要求指名具體目標、禁止預測守衛動向、列舉合法目標（不含同盟）', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    const allies = s.players.filter((p) => p.role === Role.WEREWOLF && p.alive && p.id !== wolf.id);
    const pre = buildWolfPreSpeechPrompt(s, wolf.id);
    const expand = buildWolfExpandPrompt(s, wolf.id, 'P1：「今晚先襲擊P3。」');
    for (const prompt of [pre, expand]) {
        assert.ok(!prompt.includes('守衛可能保誰'), '不應引導討論無法得知的守衛動向');
        assert.ok(prompt.includes('指名'), '應要求指名具體目標');
        assert.ok(prompt.includes('襲擊同盟是規則上不可能的行為'), '應禁止殺同盟');
        assert.ok(prompt.includes('繁體中文'), '應要求繁體中文');
        assert.ok(prompt.includes('嚴禁任何簡體字'), '應明令禁止簡體字');
        assert.ok(prompt.includes('今晚可襲擊的存活玩家'), '應列舉合法目標');
        assert.ok(prompt.includes('不得以任何守衛相關猜測（無論「會保護P編號」或「沒有保護跡象」）作為選擇或排除目標的理由'), '應禁止以守衛猜測（雙向）為理由');
        const seg = prompt.split('今晚可襲擊的存活玩家')[1]?.split('（')[0] ?? '';
        for (const a of allies) {
            assert.ok(!seg.includes(`P${a.id}`), `合法目標清單不應含同盟 P${a.id}`);
        }
    }
});
test('summarizeWolfDiscussion：讀 wolfDiscussionLog 並統計襲擊目標提及', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    s.wolfDiscussionLog.push({ playerId: wolf.id, text: '我懷疑P3，今晚襲擊P3', day: s.day });
    s.wolfDiscussionLog.push({ playerId: wolf.id, text: 'P3威脅最大，投P3出去', day: s.day });
    const summary = summarizeWolfDiscussion(s, s.day);
    assert.ok(summary.includes('P3'));
    const empty = createGameState(9);
    joinAll(empty, 9);
    transition(empty, { type: 'START_GAME' });
    assert.ok(summarizeWolfDiscussion(empty, empty.day).includes('尚無明確目標'));
});
test('buildWolfExpandPrompt：狼 speech prompt + 草稿附加', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    const draft = 'P1：「今晚先襲擊P3。」';
    const prompt = buildWolfExpandPrompt(s, wolf.id, draft);
    assert.ok(prompt.includes('你的預發言草稿'));
    assert.ok(prompt.includes(draft));
    assert.ok(prompt.includes('襲擊') || prompt.includes('今晚'));
});
test('防幻覺觀察：無任何討論材料時，狼/白天 prompt 帶現實材料狀態聲明', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    assert.equal(s.discussionLog.length, 0);
    assert.equal(s.wolfDiscussionLog.length, 0);
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    const pre = buildWolfPreSpeechPrompt(s, wolf.id);
    const expand = buildWolfExpandPrompt(s, wolf.id, 'P1：「今晚先襲擊P3。」');
    for (const prompt of [pre, expand]) {
        assert.ok(prompt.includes('現實材料狀態'), '狼 prompt 應含材料狀態聲明');
        assert.ok(prompt.includes('禁止聲稱任何此類觀察'), '應明確禁止假觀察');
        assert.ok(prompt.includes('暗示你長期觀察過對方的詞'), '應禁止時間性觀察暗示詞');
        assert.ok(prompt.includes('沒有大小、遠近、邊緣或中央之分'), '應禁止編號位置聯想');
        assert.ok(prompt.includes('直覺、隨機嘗試'), '應許可直覺/隨機作為無材料理由');
    }
    // 白天 pre_speech：材料全空（第一天且狼密談也無紀錄）時同樣帶聲明
    const dayPre = buildPreSpeechPrompt(s, aliveIds(s)[0]);
    assert.ok(dayPre.includes('現實材料狀態'), '白天 pre_speech 應含材料狀態聲明');
});
test('防幻覺觀察：有討論材料後，prompt 不帶材料狀態聲明', () => {
    const s = discussionState();
    transition(s, { type: 'HUMAN_SPEAK', playerId: aliveIds(s)[0], text: '大家早安' });
    assert.ok(s.discussionLog.length > 0);
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    const pre = buildWolfPreSpeechPrompt(s, wolf.id);
    assert.ok(!pre.includes('現實材料狀態'), '有材料時不應帶空板聲明');
    const dayPre = buildPreSpeechPrompt(s, aliveIds(s)[0]);
    assert.ok(!dayPre.includes('現實材料狀態'), '白天 pre_speech 有材料時不應帶空板聲明');
});
test('非空板討論紀錄使用規則：狼 prompt 有材料時帶延續版禁令（防第2輪起幻覺回歸）', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    // 第1輪後白板非空：第2輪 prompt 仍須有禁令（不能只靠空板聲明）
    s.wolfDiscussionLog.push({ playerId: wolf.id, text: '先殺P5，直覺', day: s.day });
    const pre = buildWolfPreSpeechPrompt(s, wolf.id);
    assert.ok(!pre.includes('現實材料狀態'), '非空板不應帶空板聲明');
    assert.ok(pre.includes('【討論紀錄使用規則】'), '非空板應帶延續版規則');
    assert.ok(pre.includes('理由只能基於白板上確實存在的發言'), '應要求理由基於實際發言');
    assert.ok(pre.includes('不要寫「XXX說得對」除非他真的在白板上說過'), '應禁 phantom speaker（引用沒發言的人）');
    assert.ok(pre.includes('講完你的判斷就停筆'), '應要求短句收尾、禁散文式自言自語');
    const expand = buildWolfExpandPrompt(s, wolf.id, 'P1：「先殺P5，直覺。」');
    assert.ok(expand.includes('【討論紀錄使用規則】'), 'expand 非空板亦應帶延續版規則');
});
test('wolf_speech 任務指令：行為理由僅限有觀察時，無材料時取消理由要求', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    const prompt = buildPrompt(s, wolf.id, 'wolf_speech');
    assert.ok(prompt.includes('僅當討論紀錄中真有此觀察時才可用行為理由'), '示例應條件化行為理由');
    assert.ok(prompt.includes('誠實說直覺或隨機即可'), '無材料時應引導誠實理由');
    assert.ok(!prompt.includes('外圍編號'), '不應再提供編號位置類示例');
    // 首夜極簡：三句固定措辭
    const pre = buildWolfPreSpeechPrompt(s, wolf.id);
    assert.ok(pre.includes('只准談你自己的狀態'), '首夜應含只談自己');
    assert.ok(pre.includes('不准描述對方'), '首夜應禁述對方');
    // 有材料：後夜兩句固定措辭＋跟隨共識
    s.wolfDiscussionLog.push({ playerId: wolf.id, text: '我覺得P5可疑', day: s.day });
    const pre2 = buildWolfPreSpeechPrompt(s, wolf.id);
    assert.ok(pre2.includes('實際出現的發言'), '後夜理由只准引用實發言');
    assert.ok(pre2.includes('直接跟進該目標並標已決定'), '有材料應含跟隨共識規則（孤狼猶豫時合法化跟進）');
});
test('expand 潤飾約束：狼/白天 expand 均鎖定草稿目標與理由，只准調整語氣', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    const wolfExpand = buildWolfExpandPrompt(s, wolf.id, 'P1：「今晚先襲擊P3，直覺。」');
    assert.ok(wolfExpand.includes('草稿指名的目標（P編號）與理由不得改變'), '狼 expand 應鎖定目標與理由');
    assert.ok(wolfExpand.includes('不得新增草稿中沒有的理由'), '狼 expand 應禁止新增理由');
    assert.ok(wolfExpand.includes('改寫成自然的口語發言'), '狼 expand 應要求口語化改寫');
    assert.ok(!wolfExpand.includes('說不上為什麼'), '狼 expand 不應含固定句式示例（防照搬）');
    const dayExpand = buildExpandPrompt(s, aliveIds(s)[0], 'P1：「我比較在意P3的說法。」');
    assert.ok(dayExpand.includes('草稿的核心論點不得改變'), '白天 expand 應鎖定核心論點');
    assert.ok(dayExpand.includes('不得新增草稿中沒有的理由或觀察'), '白天 expand 應禁止新增理由');
    assert.ok(dayExpand.includes('改寫成自然的口語發言'), '白天 expand 應要求口語化改寫');
});
test('狼首夜極簡：三句固定措辭＋預算', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    const pre = buildWolfPreSpeechPrompt(s, wolf.id);
    assert.ok(pre.includes('只准談你自己的狀態'), '首夜應含只談自己');
    assert.ok(pre.includes('不准描述對方'), '首夜應禁述對方');
    assert.ok(pre.includes('拿不定就標[決定:資訊不足]'), '首夜應含資訊不足旗標指引');
    assert.ok(pre.length <= PRE_SPEECH_BUDGET, `首夜 prompt ${pre.length} 字元應 ≤ ${PRE_SPEECH_BUDGET}`);
});
test('狼後夜極簡：兩句固定措辭＋白天討論段', () => {
    const s = createGameState(9);
    joinAll(s, 9);
    transition(s, { type: 'START_GAME' });
    const wolf = s.players.find((p) => p.role === Role.WEREWOLF && p.alive);
    s.wolfDiscussionLog.push({ playerId: wolf.id, text: '先殺P5，直覺', day: s.day });
    const preEmpty = buildWolfPreSpeechPrompt(s, wolf.id);
    assert.ok(preEmpty.includes('【白天討論】'), '後夜應含白天討論段');
    assert.ok(preEmpty.includes('（今日尚無白天發言）'), '無白天發言時應填佔位');
    assert.ok(preEmpty.includes('實際出現的發言'), '後夜理由只准引用實發言');
    const speaker = aliveIds(s)[0];
    s.discussionLog.push({ playerId: speaker, text: '我帶票投P5', day: s.day });
    const preFull = buildWolfPreSpeechPrompt(s, wolf.id);
    assert.ok(preFull.includes('我帶票投P5'), '白天段應含當天實際發言文本');
    assert.ok(preFull.includes('實際出現的發言'), '後夜應要求引用實發言');
    assert.ok(preFull.length <= 4000, '後夜 prompt 應保持可控長度');
});
//# sourceMappingURL=character-session.test.js.map