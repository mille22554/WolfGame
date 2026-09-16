/**
 * AI Player — prompt builder + SpeechScheduler 管線
 *
 * 從 character/ 目錄載入 persona，組裝 prompt，呼叫 LLM，parse 回應。
 * 管線：PRE_SPEECH（分批）→ JUDGE → SELECT → EXPAND → BROADCAST
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat } from './llm.js';
/** 取得 character/ 目錄的絕對路徑（以模組位置定位） */
function getCharacterRoot() {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/lobby-server/ → 上兩層到 repo root
    return resolve(here, '../../character');
}
export function loadCharacterProfile(id) {
    const dir = resolve(getCharacterRoot(), id);
    const agentsPath = resolve(dir, 'agents.md');
    const memoryPath = resolve(dir, 'memory.md');
    if (!existsSync(agentsPath))
        return null;
    const persona = readFileSync(agentsPath, 'utf-8');
    const memory = existsSync(memoryPath) ? readFileSync(memoryPath, 'utf-8').trim() : '';
    return { id, persona, memory };
}
// ============================================
// Prompt Builders
// ============================================
/** 從 persona 提取關鍵欄位（簡化版，取前幾行基本資料） */
function extractPersonaSummary(profile) {
    // 取「基本資料」和「語言風格」段落
    const lines = profile.persona.split('\n');
    const summary = [];
    let section = '';
    for (const line of lines) {
        if (line.startsWith('## ')) {
            section = line.replace('## ', '').trim();
            if (section === '基本資料' || section === '性格與說話方式' || section === '說話範例')
                summary.push(line);
            continue;
        }
        if (section === '基本資料' || section === '性格與說話方式' || section === '說話範例') {
            summary.push(line);
        }
    }
    return summary.join('\n');
}
function buildSystemPrompt(profile, role, extraContext) {
    const personaSummary = extractPersonaSummary(profile);
    return [
        `你是「${profile.id}」，在狼人殺遊戲中扮演「${role}」。`,
        personaSummary,
        profile.memory ? `\n你的記憶：\n${profile.memory}` : '',
        extraContext,
        ``,
        `硬規則：`,
        `- 使用繁體中文。禁止簡體字。禁止英文單詞。`,
        `- 只能引用已公開的遊戲事實。禁止編造不存在的遊戲術語、機制或事件。`,
        `- 禁止使用「站位」「位置」「編號大小」等概念。玩家名字就是名字，沒有位置意義。`,
        `- 你只能回覆 JSON，不要多餘文字。不要 markdown。`,
    ].filter(Boolean).join('\n');
}
/** PRE_SPEECH：生成草稿（≤100 token） */
export function buildPreSpeechPrompt(player, profile, gameState) {
    const aliveList = gameState.players
        .filter(p => p.alive)
        .map(p => `P${p.id}(${p.name})`)
        .join('、');
    const wolfContext = [
        '你是人狼陣營。',
        `你的狼隊同夥：${gameState.privateInfo?.includes('同夥') ? gameState.privateInfo.split('同夥：')[1]?.split('。')[0] ?? '（見下方）' : '（見下方）'}。`,
        '現在是狼會議（私頻），只有人狼能看到。',
        '你必須提出刀人目標並說服同夥。',
    ].join('\n');
    const system = buildSystemPrompt(profile, '人狼', wolfContext);
    // 可刀目標：排除自己、同夥、狂人（只用名字，不給編號——避免 AI 把數字當「位置」）
    const wolfIdSet = new Set(gameState.wolfIds ?? []);
    const eligibleTargets = gameState.players
        .filter(p => p.alive && p.id !== player.id && !wolfIdSet.has(p.id) && p.id !== gameState.madmanId)
        .map(p => p.name)
        .join('、');
    const user = [
        `當前：第 ${gameState.day} 夜，狼會議（私頻，只有人狼能看到）。`,
        `你的情報：${gameState.privateInfo ?? '你是人狼'}`,
        `可刀目標（只能從以下選）：${eligibleTargets}`,
        ``,
        `任務：提出一個刀人目標並簡述理由（≤50字）。`,
        `提醒：理由只能基於你實際擁有的資訊。若沒有足夠資訊，說「直覺」或「隨機」就好，不要硬編觀察。禁止使用「站位」「位置」「編號」等概念。用你的角色語氣說話。`,
        `回覆格式：{"speech": "..."}`,
    ].join('\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}
/** JUDGE：全盲評分所有草稿 */
export function buildJudgePrompt(drafts) {
    const system = [
        '你是狼人殺狼會議的裁判。',
        '你的任務：評估以下各段草稿的策略品質，給出 1-10 分。',
        '評分標準：(1) 刀人目標的策略價值 (2) 說服力（能否讓同夥信服） (3) 資訊量（是否提供有價值的觀察）',
        '注意：你不知道哪段是誰寫的，請純以內容評分。',
        '你只能回覆 JSON，不要多餘文字。',
    ].join('\n');
    const numbered = drafts.map((d, i) => `[${i + 1}]: ${d}`).join('\n');
    const user = [
        `以下是 ${drafts.length} 段狼會議草稿：`,
        numbered,
        `請為每段打分（1-10 整數）。`,
        `回覆格式：{"scores": [n, n, ...]}`,
    ].join('\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}
/** EXPAND：將選中的草稿展開為完整發言 */
export function buildExpandPrompt(player, profile, draft, gameState) {
    const aliveList = gameState.players
        .filter(p => p.alive)
        .map(p => `P${p.id}(${p.name})`)
        .join('、');
    const wolfContext = [
        '你是人狼陣營。現在是狼會議（私頻）。',
        '你要把之前的草稿意見展開為一段完整的發言，說服狼隊同夥接受你的刀人目標。',
    ].join('\n');
    const system = buildSystemPrompt(profile, '人狼', wolfContext);
    const user = [
        `當前：第 ${gameState.day} 夜，狼會議（私頻）。`,
        `你的情報：${gameState.privateInfo ?? '你是人狼'}`,
        `你之前的草稿：「${draft}」`,
        ``,
        `任務：將草稿展開為完整發言（≤150字）。要有說服力、符合你的角色語氣。`,
        `提醒：只引用你有把握的觀察，不要編造。`,
        `回覆格式：{"speech": "..."}`,
    ].join('\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}
// ============================================
// JSON Response Parser
// ============================================
export function parseJsonResponse(text) {
    if (!text)
        return null;
    try {
        // 嘗試直接 parse
        return JSON.parse(text);
    }
    catch {
        // 嘗試提取 JSON 子串（AI 可能包了多餘文字）
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                return JSON.parse(match[0]);
            }
            catch { /* ignore */ }
        }
        return null;
    }
}
/**
 * 執行狼會議管線：
 * 1. PRE_SPEECH：分批（每批 2 個）平行生成草稿，等全部完成
 * 2. JUDGE：全部草稿到齊後，一次性評分
 * 3. SELECT：選最高分（同分取先）
 * 4. EXPAND：被選中的 wolf 展開完整句
 */
export async function runWolfMeetingPipeline(wolves, profiles, gameState, onStep) {
    const steps = [];
    // --- PRE_SPEECH（分批，每批 2 個） ---
    const drafts = [];
    const batchSize = 2;
    for (let i = 0; i < wolves.length; i += batchSize) {
        const batch = wolves.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(async (wolf) => {
            const profile = profiles.get(wolf.personality);
            if (!profile)
                return { wolf, prompts: [], response: null, parsed: null };
            const prompts = buildPreSpeechPrompt(wolf, profile, gameState);
            const response = await chat(prompts, { temperature: 1.0 });
            const parsed = parseJsonResponse(response);
            return { wolf, prompts, response, parsed };
        }));
        for (const r of batchResults) {
            const speech = r.parsed?.speech ?? r.response ?? '';
            drafts.push(speech);
            const step = {
                name: `PRE_SPEECH[${r.wolf.name}]`,
                prompts: r.prompts,
                response: r.response,
                parsed: r.parsed,
            };
            steps.push(step);
            onStep?.(step);
        }
    }
    // --- JUDGE（全部草稿到齊後） ---
    const judgePrompts = buildJudgePrompt(drafts);
    const judgeResponse = await chat(judgePrompts, { temperature: 0.7 });
    const judgeParsed = parseJsonResponse(judgeResponse);
    const judgeStep = {
        name: 'JUDGE',
        prompts: judgePrompts,
        response: judgeResponse,
        parsed: judgeParsed,
    };
    steps.push(judgeStep);
    onStep?.(judgeStep);
    // --- SELECT（最高分，同分取先） ---
    const scores = judgeParsed?.scores ?? drafts.map(() => 5);
    let selectedDraftIndex = 0;
    let maxScore = -1;
    for (let i = 0; i < scores.length; i++) {
        if ((scores[i] ?? 0) > maxScore) {
            maxScore = scores[i] ?? 0;
            selectedDraftIndex = i;
        }
    }
    // --- EXPAND ---
    const selectedWolf = wolves[selectedDraftIndex];
    const selectedProfile = profiles.get(selectedWolf.personality);
    let finalSpeech = drafts[selectedDraftIndex];
    if (selectedProfile) {
        const expandPrompts = buildExpandPrompt(selectedWolf, selectedProfile, drafts[selectedDraftIndex], gameState);
        const expandResponse = await chat(expandPrompts, { temperature: 1.0 });
        const expandParsed = parseJsonResponse(expandResponse);
        const expandStep = {
            name: `EXPAND[${selectedWolf.name}]`,
            prompts: expandPrompts,
            response: expandResponse,
            parsed: expandParsed,
        };
        steps.push(expandStep);
        onStep?.(expandStep);
        finalSpeech = expandParsed?.speech ?? expandResponse ?? finalSpeech;
    }
    return {
        steps,
        selectedDraftIndex,
        finalSpeech,
    };
}
//# sourceMappingURL=ai-player.js.map