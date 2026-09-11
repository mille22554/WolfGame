/**
 * character-session.ts — Phase 0：buildPrompt 純函式 + summarizeDay + 截斷演算法
 *
 * 組裝順序：角色卡（persona/agents.md + memory.md）→ 遊戲規則 →
 * 公開知識（buildPublicKnowledge）→ 私有知識（依角色）→ 當天討論 →
 * 歷史摘要（daySummaries）→ 任務指令（依 kind）
 *
 * 人格分層：草稿（pre_speech）與正式發言（speech/expand）皆帶人格
 * （人格是決策依據之一）；night/vote 行動決策保持中性（不帶人格），
 * 維持嚴格輸出格式的服從性。
 */
import * as fs from 'fs';
import * as path from 'path';
import { Role, Team } from './types.js';
import { buildPublicKnowledge, parseAccusatoryIds } from './ai.js';
import { getAlivePlayers } from './assignment.js';
import { getResourceRoot } from './utils.js';
import { readMemory } from './memory.js';
function readTextIfExists(filePath) {
    try {
        if (!fs.existsSync(filePath))
            return '';
        return fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        return '';
    }
}
function taskInstruction(kind, playerId) {
    switch (kind) {
        case 'speech':
            return `【任務】你是 P${playerId}，請進行白天發言（一句話，20-60字，短一點沒關係）。圍繞「誰的反應讓你在意」「想聽聽誰的說法」聊，用「我比較在意…」語氣，避免直接定罪。像一般人自然講話，不要套用角色口頭禪或壓力台詞，語氣不要強烈或浮誇。格式：P${playerId}：「你的發言」`;
        case 'vote':
            return `【任務】你是 P${playerId}，請投票。回顧今天的發言與你的私有情報，選出最值得懷疑的一人。只回覆一句話，不要角色扮演。回覆格式：我投 P{編號}。`;
        case 'night':
            return `【任務】你是 P${playerId}，請選擇今晚行動的目標（必須是存活且非自己的玩家）。只回覆一句話，不要角色扮演。回覆：我選擇 P{編號}。`;
        case 'wolf_speech':
            return `【任務】你是 P${playerId}（人狼），請與同伴討論今晚要襲擊誰、協調目標（一句話，20-60字，短一點沒關係）。直接指名具體目標（P編號）並說理由，如「P3 話多可能是占卜師，先殺他」（僅當討論紀錄中真有此觀察時才可用行為理由；沒有材料時誠實說直覺或隨機即可，不要編造理由）。你的同盟列在【你的角色資訊】，襲擊同盟是規則上不可能的行為，絕對不要考慮。守衛保護誰、誰是甚麼職業都是秘密，無從得知：不得聲稱知道，也不得以任何守衛相關猜測（無論「會保護P編號」或「沒有保護跡象」）作為選擇或排除目標的理由。請使用繁體中文。用「我覺得今晚…」語氣。像一般人自然講話，不要套用角色口頭禪或壓力台詞，語氣不要強烈或浮誇。格式：P${playerId}：「你的發言」；結尾另起一行附加決策旗標[決定:殺P編號]（已決定目標時）或[決定:資訊不足]（尚無法決定時），只可附加其一。`;
    }
}
function privateKnowledgeLines(state, playerId) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player)
        return [];
    const lines = [];
    lines.push(`你的編號：P${player.id}（${player.name}）`);
    if (player.role === Role.SEER) {
        const checks = state.seerChecks.filter((c) => c.seerId === playerId);
        if (checks.length > 0) {
            lines.push(`你的查驗紀錄：${checks
                .map((c) => `第${c.day}天查驗 P${c.targetId}：${c.result === Team.WEREWOLF ? '人狼' : '村人'}`)
                .join('；')}`);
        }
    }
    if (player.role === Role.GUARD) {
        const protects = state.guardProtects.filter((g) => g.guardId === playerId);
        if (protects.length > 0) {
            lines.push(`你的守護紀錄：${protects.map((g) => `第${g.day}天守護 P${g.targetId}`).join('；')}`);
        }
    }
    if (player.role === Role.MEDIUM) {
        const voteDeaths = state.deathHistory.filter((d) => d.cause === 'vote');
        if (voteDeaths.length > 0) {
            lines.push(`你的靈能情報：${voteDeaths
                .map((d) => {
                const pl = state.players.find((p) => p.id === d.playerId);
                const team = pl && pl.role === Role.WEREWOLF ? '人狼' : '村人';
                return `第${d.day}天票死 P${d.playerId} 是${team}`;
            })
                .join('；')}`);
        }
    }
    if (player.role === Role.MASON && player.masonPartnerId !== undefined) {
        lines.push(`你的共有者夥伴：P${player.masonPartnerId}`);
    }
    if (player.role === Role.WEREWOLF) {
        const allies = state.players.filter((p) => p.role === Role.WEREWOLF && p.alive && p.id !== playerId);
        if (allies.length > 0) {
            lines.push(`你的人狼同盟：${allies.map((a) => `P${a.id}`).join('、')}`);
        }
    }
    return lines;
}
/**
 * 討論紀錄渲染：按天分組，跨日時插入「=== 第N天 ===」分隔線；
 * 單日時不加分隔線（與舊輸出逐字一致，night-1 prompt 不受影響）。
 * 呼叫方傳入已按時間排序的條目（state 內一律追加寫入，日增單調）。
 */
function renderDiscussionLines(entries) {
    if (entries.length === 0)
        return [];
    const lines = [];
    const multiDay = new Set(entries.map((e) => e.day)).size > 1;
    let lastDay = -1;
    for (const e of entries) {
        if (multiDay && e.day !== lastDay) {
            lines.push(`=== 第${e.day}天 ===`);
            lastDay = e.day;
        }
        lines.push(`P${e.playerId}：${e.text}`);
    }
    return lines;
}
export function buildPrompt(state, playerId, kind, budget = 4000) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player)
        throw new Error(`找不到玩家 P${playerId}`);
    const maxChars = budget ?? 4000;
    const maxDiscussionEntries = 60;
    // --- 固定部分 ---
    // 人格分層：night/vote 是中性行動決策，不帶人格；speech/wolf_speech（正式發言）與草稿（pre_speech）帶人格
    const personaId = player.personality || `p${playerId}`;
    const includePersona = kind === 'speech' || kind === 'wolf_speech';
    const personaPrompt = includePersona
        ? readTextIfExists(path.join(getResourceRoot(), 'character', personaId, 'agents.md'))
        : '';
    const privateMemory = readMemory(personaId);
    const rules = readTextIfExists(path.join(getResourceRoot(), 'character', 'game-rules.md'));
    const pub = buildPublicKnowledge(state);
    const aliveNames = pub.alivePlayers.map((p) => `P${p.id}`).join('、') || '無';
    const deadNames = pub.deadPlayers.map((p) => `P${p.id}`).join('、') || '無';
    const fixedParts = [
        '你是人狼遊戲中的角色。',
        includePersona ? (personaPrompt ? `【人格設定】\n${personaPrompt}` : '【人格設定】（無）') : '',
        privateMemory ? `【你的私有記憶】\n${privateMemory}` : '',
        `【你的角色資訊】\n${privateKnowledgeLines(state, playerId).join('\n')}`,
        rules ? `【遊戲規則】\n${rules}` : '',
        `【公開知識】第${state.day}天，存活玩家：${aliveNames}；死亡玩家：${deadNames}。`,
        taskInstruction(kind, playerId),
    ].filter((s) => s !== '');
    // --- 可截斷部分 ---
    // 討論紀錄跨日保留：取最近 N 則（含前幾天），渲染時以「=== 第N天 ===」分隔；
    // 狼討論走 wolfDiscussionLog，不帶白天歷史摘要
    const isWolfSpeech = kind === 'wolf_speech';
    let historyEntries = (isWolfSpeech ? state.wolfDiscussionLog : state.discussionLog)
        .slice(-maxDiscussionEntries);
    // 狼討論無白天摘要；僅白天流程帶 daySummaries
    let summaries = isWolfSpeech ? [] : [...state.daySummaries];
    // 狼討論改用專屬標題，避免與白天對話混淆
    const discussionTitle = isWolfSpeech ? '【今晚狼討論紀錄】' : '【今日對話紀錄】';
    // 組裝（與最終輸出逐字一致；截斷計量以此為準，含標題與 \n\n 連接符，
    // 舊 totalLength 只加總三區塊內容、漏算組裝開銷，邊界帶會超過預算）
    const assemble = () => {
        const parts = [...fixedParts];
        const currentLines = renderDiscussionLines(historyEntries);
        parts.splice(fixedParts.length - 1, 0, `${discussionTitle}\n${currentLines.length > 0 ? currentLines.join('\n') : '（尚無發言）'}`, summaries.length > 0 ? `【歷史摘要】\n${summaries.join('\n')}` : '');
        return parts.filter((s) => s !== '').join('\n\n');
    };
    // 截斷演算法：先丟最舊 daySummary，再丟最舊討論條目（跨日時含前幾天）；
    // 固定部分超限 → 原樣輸出（不截斷）
    while (assemble().length > maxChars) {
        if (summaries.length > 0) {
            summaries = summaries.slice(1);
        }
        else if (historyEntries.length > 0) {
            historyEntries = historyEntries.slice(1);
        }
        else {
            break;
        }
    }
    return assemble();
}
/**
 * summarizeDay：啟發式摘要 — top3 指控（被最多人點名）+ 投票結果
 */
export function summarizeDay(state, day) {
    const entries = state.discussionLog.filter((d) => d.day === day);
    const votes = state.votes.filter((v) => v.day === day);
    const alivePlayers = getAlivePlayers(state.players);
    const mentionCounts = new Map();
    for (const e of entries) {
        for (const id of parseAccusatoryIds(e.text, alivePlayers)) {
            mentionCounts.set(id, (mentionCounts.get(id) ?? 0) + 1);
        }
    }
    const top3 = Array.from(mentionCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
    const voteCounts = new Map();
    for (const v of votes) {
        voteCounts.set(v.targetId, (voteCounts.get(v.targetId) ?? 0) + 1);
    }
    const voteLines = Array.from(voteCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([id, c]) => `P${id}: ${c} 票`);
    const parts = [`第${day}天摘要：`];
    if (top3.length > 0) {
        parts.push(`最多被指控：${top3.map(([id, c]) => `P${id}（${c}次）`).join('、')}`);
    }
    else {
        parts.push('無明確指控');
    }
    if (voteLines.length > 0) {
        parts.push(`投票結果：${voteLines.join('、')}`);
        const max = Math.max(...voteCounts.values());
        const tied = Array.from(voteCounts.values()).filter((c) => c === max).length > 1;
        if (tied) {
            parts.push('平票，無人出局');
        }
        else {
            const out = Array.from(voteCounts.entries()).find(([, c]) => c === max);
            if (out)
                parts.push(`P${out[0]} 被投票出局`);
        }
    }
    else {
        parts.push('無投票紀錄');
    }
    return parts.join('；');
}
// ============================================
// Phase 1：預發言 / 裁判 / 展開 prompt
// ============================================
export const PRE_SPEECH_BUDGET = 2000; // 字元預算
export const PRE_SPEECH_RECENT = 5; // 最近幾則
/**
 * buildPreSpeechPrompt（輕量，2-3K tokens）：
 * 人格（前 500 字）→ 私有知識 → 當天摘要（最後一則）→ 最近 5 則討論 → 任務指令
 */
export function buildPreSpeechPrompt(state, playerId) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player)
        throw new Error(`找不到玩家 P${playerId}`);
    // 草稿帶人格：人格是決策依據之一（懷疑度/風格/投票模式），草稿由人格驅動產生差異；
    // expand 階段仍會以同一人格潤飾，不會衝突
    const personaId = player.personality || `p${playerId}`;
    const personaPrompt = readTextIfExists(path.join(getResourceRoot(), 'character', personaId, 'agents.md'));
    const privateLines = privateKnowledgeLines(state, playerId);
    const lastSummary = state.daySummaries.length > 0
        ? state.daySummaries[state.daySummaries.length - 1]
        : '尚無摘要';
    const recentEntries = state.discussionLog.slice(-PRE_SPEECH_RECENT);
    let recent = renderDiscussionLines(recentEntries);
    const parts = [
        personaPrompt ? `【人格設定】\n${personaPrompt}` : '',
        `【你的角色資訊】\n${privateLines.join('\n')}`,
        `【當天摘要】\n${lastSummary}`,
        `【最近討論】\n${recent.length > 0 ? recent.join('\n') : '（尚無發言）'}`,
        hasNoPublicBehaviorRecord(state) ? emptyBoardDeclaration() : '',
        `【任務】你是 P${playerId}，請寫一句 20-40 字的預發言草稿（不超過 40 字）。\n這是候選草稿，稍後可能被選中展開。用一般人的自然語氣寫，不要刻意扮演角色口吻、不要浮誇；人格設定只作為你的思考傾向參考（懷疑誰、在意什麼），不要求模仿其說話風格。圍繞當前局勢，提出一個值得討論的點；沒有材料時可談直覺或對局勢的疑問，不要編造對他人的觀察。\n格式：P${playerId}：「你的草稿」`,
        `【決策旗標】草稿結尾另起一行附加你的投票準備狀態（中控內部判讀用，不會公開）：已決定投某人→[決定:投P編號]；已決定棄票→[決定:棄票]；資訊不足無法決定→[決定:資訊不足]。只可附加其一。`,
    ];
    let prompt = parts.filter((s) => s !== '').join('\n\n');
    // 超預算：先丟最近討論最舊條目（固定部分保留）
    while (prompt.length > PRE_SPEECH_BUDGET && recentEntries.length > 1) {
        recentEntries.shift();
        recent = renderDiscussionLines(recentEntries);
        parts[3] = `【最近討論】\n${recent.join('\n')}`;
        prompt = parts.filter((s) => s !== '').join('\n\n');
    }
    return prompt;
}
/**
 * buildJudgePrompt（裁判，全盲）：
 * 當天摘要 + 打亂匿名預發言（slot 1..N，不含 P 編號）+ 評分指令
 */
export function buildJudgePrompt(daySummary, preSpeeches) {
    const lines = preSpeeches.map((p) => `${p.slot}. ${p.text}`);
    const formatExample = preSpeeches.map((p) => `${p.slot}: 分數`).join('\n');
    return [
        `【當天摘要】\n${daySummary}`,
        `【候選發言】\n${lines.join('\n')}`,
        `【裁判任務】以下是 ${preSpeeches.length} 位玩家的候選發言（順序已打亂，匿名）。\n請針對每一則以 0-10 整數評分，考量三個面向：\n- 新資訊：是否帶來討論中尚未出現的資訊\n- 相關性：是否緊扣當前局勢\n- 推進力：是否能推動討論前進\n輸出格式（每行一則，嚴格遵守）：\n${formatExample}`,
    ].join('\n\n');
}
/**
 * buildExpandPrompt（展開完整發言）：
 * buildPrompt(state, playerId, 'speech') + 預發言草稿附加
 */
export function buildExpandPrompt(state, playerId, preSpeech) {
    const base = buildPrompt(state, playerId, 'speech');
    return `${base}\n\n【你的預發言草稿】${preSpeech}\n請把這則草稿改寫成自然的口語發言（20-60 字，像一般人在會議中講話；短一點沒關係，不要為了湊字數而新增內容），不必保留草稿的字句與句構，也不要套用任何固定句式。鐵則：草稿的核心論點不得改變，不得新增草稿中沒有的理由或觀察。`;
}
/**
 * summarizeWolfDiscussion：狼討論摘要 — top 提及的襲擊目標（無投票段）
 */
export function summarizeWolfDiscussion(state, day) {
    const entries = state.wolfDiscussionLog.filter((d) => d.day === day);
    const alivePlayers = getAlivePlayers(state.players);
    // 復用指控解析：狼文本中的 P編號提及即視為襲擊目標候選
    const mentionCounts = new Map();
    for (const e of entries) {
        for (const id of parseAccusatoryIds(e.text, alivePlayers)) {
            mentionCounts.set(id, (mentionCounts.get(id) ?? 0) + 1);
        }
    }
    const top3 = Array.from(mentionCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
    if (top3.length > 0) {
        return `第${day}天狼討論摘要：最多被提及的目標：${top3.map(([id, c]) => `P${id}（${c}次）`).join('、')}`;
    }
    return `第${day}天狼討論摘要：尚無明確目標`;
}
/**
 * 狼合法襲擊目標清單：存活、非自己、非同盟（列舉出來，讓模型只能從中挑選，從根本上避免想殺同盟）
 */
function wolfValidTargets(state, playerId) {
    const allyIds = state.players.filter((p) => p.role === Role.WEREWOLF && p.alive).map((p) => p.id);
    return getAlivePlayers(state.players)
        .filter((p) => !allyIds.includes(p.id))
        .map((p) => `P${p.id}`)
        .join('、');
}
/**
 * 現實材料狀態聲明（防幻覺觀察＋防編號幻覺）：
 * 討論紀錄為空（尚無任何公開發言）時，明確告知模型：
 * 1. 不可聲稱觀察到任何人的活動或行為（防「他最近活動頻繁」假觀察）
 * 2. P編號只是代號，無大小/遠近/邊緣意義，不可當理由（防「他位於邊緣」空間幻覺）
 * 3. 沒材料時誠實說直覺/隨機/跟隨建議即可，坦白無依據是正常發言
 */
function emptyBoardDeclaration() {
    return `【現實材料狀態】目前尚無任何公開發言或行為紀錄，你不可能觀察到任何人的活動、發言量或在場時間，禁止聲稱任何此類觀察（如「他活動頻繁」「他在場時間長」「他有異常的活動模式」「他不太對勁」）。也不要用「一直」「總是」「經常」「近期」「最近」這類暗示你長期觀察過對方的詞。P編號只是代號，沒有大小、遠近、邊緣或中央之分，禁止以編號本身作為理由（如「他位於邊緣」「外圍編號」）。沒有材料時可用的依據只有直覺、隨機嘗試或跟隨他人已提出的建議；直覺就說直覺，不得把直覺包裝成觀察；坦白說「目前沒有特別依據」完全正常。`;
}
/** 是否尚無任何公開行為材料：白天討論與狼討論紀錄全空（含歷史天數） */
function hasNoPublicBehaviorRecord(state) {
    return state.discussionLog.length === 0 && state.wolfDiscussionLog.length === 0;
}
/**
 * buildWolfPreSpeechPrompt（狼預發言，輕量）：
 * 私有知識 → 當晚狼討論最近 5 則 → 任務指令（含殺人決策旗標）
 */
export function buildWolfPreSpeechPrompt(state, playerId) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player)
        throw new Error(`找不到玩家 P${playerId}`);
    // 草稿帶人格：人格是決策依據之一（懷疑度/風格/投票模式），草稿由人格驅動產生差異
    const personaId = player.personality || `p${playerId}`;
    const personaPrompt = readTextIfExists(path.join(getResourceRoot(), 'character', personaId, 'agents.md'));
    const privateLines = privateKnowledgeLines(state, playerId);
    let recentEntries = state.wolfDiscussionLog.slice(-PRE_SPEECH_RECENT);
    let recent = renderDiscussionLines(recentEntries);
    // 根因修復：空板時「並給理由」會逼模型把直覺包裝成觀察（「直覺說P15有異動」），
    // 無材料時直接取消理由要求（指名＋直覺即可）；有材料才要求基於實際發言的理由
    const reasonReq = hasNoPublicBehaviorRecord(state)
        ? '直接指名一個具體目標（P編號），並說這是你的直覺即可；不需要給理由，也不要描述對方的任何行為或狀態。'
        : '直接指名一個具體目標（P編號）並給理由（只能基於【今晚狼討論】中的實際發言內容）。';
    const parts = [
        personaPrompt ? `【人格設定】\n${personaPrompt}` : '',
        `【你的角色資訊】\n${privateLines.join('\n')}`,
        `【今晚狼討論】\n${recent.length > 0 ? recent.join('\n') : '（尚無發言）'}`,
        hasNoPublicBehaviorRecord(state) ? emptyBoardDeclaration() : '',
        `【任務】你是 P${playerId}，請寫一句 10-40 字的預發言草稿，與同伴討論今晚要襲擊誰、協調目標（不超過 40 字；短一點沒關係，誠實優先於湊字數）。用一般人的自然語氣寫，不要刻意扮演角色口吻、不要浮誇；人格設定只作為你的思考傾向參考（懷疑誰、敢不敢果斷），不要求模仿其說話風格。${reasonReq}今晚可襲擊的存活玩家只有：${wolfValidTargets(state, playerId)}（你的同盟不在其中，襲擊同盟是規則上不可能的行為，不要考慮）。守衛保護誰、誰是甚麼職業都是秘密，無從得知：不得聲稱知道，也不得以任何守衛相關猜測（無論「會保護P編號」或「沒有保護跡象」）作為選擇或排除目標的理由。請使用繁體中文。\n格式：P${playerId}：「你的草稿」`,
        `【決策旗標】草稿結尾另起一行附加你的襲擊決策狀態（中控內部判讀用，不會公開）：已決定襲擊某人→[決定:殺P編號]；資訊不足無法決定→[決定:資訊不足]。只可附加其一。`,
    ];
    let prompt = parts.filter((s) => s !== '').join('\n\n');
    // 超預算：先丟最近討論最舊條目（固定部分保留）
    while (prompt.length > PRE_SPEECH_BUDGET && recentEntries.length > 1) {
        recentEntries.shift();
        recent = renderDiscussionLines(recentEntries);
        parts[2] = `【今晚狼討論】\n${recent.join('\n')}`;
        prompt = parts.filter((s) => s !== '').join('\n\n');
    }
    return prompt;
}
/**
 * buildWolfExpandPrompt（狼展開完整發言）：
 * buildPrompt(state, playerId, 'wolf_speech') + 預發言草稿附加
 */
export function buildWolfExpandPrompt(state, playerId, preSpeech) {
    const base = buildPrompt(state, playerId, 'wolf_speech');
    return `${base}\n\n${hasNoPublicBehaviorRecord(state) ? emptyBoardDeclaration() + '\n\n' : ''}【今晚可襲擊的存活玩家】${wolfValidTargets(state, playerId)}（你的同盟不在其中，襲擊同盟是規則上不可能的行為，不要考慮；守衛保護誰是秘密，不得以任何守衛相關猜測（無論「會保護P編號」或「沒有保護跡象」）作為選擇或排除目標的理由）\n\n【你的預發言草稿】${preSpeech}\n請把這則草稿改寫成自然的口語發言（20-60 字，像一般人在會議中講話；短一點沒關係，不要為了湊字數而新增內容），不必保留草稿的字句與句構，也不要套用任何固定句式。鐵則：草稿指名的目標（P編號）與理由不得改變，不得新增草稿中沒有的理由（尤其不得新增守衛預測、行為觀察或編號位置聯想）。`;
}
//# sourceMappingURL=character-session.js.map