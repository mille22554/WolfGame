/**
 * 角色 Session 管理器
 * 每個角色擁有獨立 session：人格 prompt + 私有記憶 + 公開知識 + 自己的私有知識
 * 資訊隔離：絕不載入其他角色的私有記憶、查驗結果或同盟資訊
 */
import * as fs from 'fs';
import * as path from 'path';
import { Role, NightActionType, } from './types.js';
import { buildPublicKnowledge, buildPrivateKnowledge, } from './ai.js';
import { getAlivePlayers } from './assignment.js';
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
/**
 * 單一角色的獨立 LLM session
 */
export class CharacterSession {
    playerId;
    provider;
    gameState;
    player;
    messages = [];
    constructor(playerId, provider, gameState) {
        const player = gameState.players.find((p) => p.id === playerId);
        if (!player) {
            throw new Error(`找不到玩家 P${playerId}`);
        }
        this.playerId = playerId;
        this.provider = provider;
        this.gameState = gameState;
        this.player = player;
        // 人格 prompt 與私有記憶：只讀自己的檔案
        const personaId = player.personality?.id ?? `p${playerId}`;
        const agentsPath = path.join(process.cwd(), 'character', personaId, 'agents.md');
        const memoryPath = path.join(process.cwd(), 'character', personaId, 'memory.md');
        const personaPrompt = readTextIfExists(agentsPath);
        const privateMemory = readTextIfExists(memoryPath);
        const pub = buildPublicKnowledge(gameState);
        const priv = buildPrivateKnowledge(player, gameState);
        // 組公開知識摘要（繁體中文）
        const aliveNames = pub.alivePlayers.map((p) => p.name).join('、') || '無';
        const deadNames = pub.deadPlayers.map((p) => p.name).join('、') || '無';
        const discussionLines = pub.discussionLog
            .map((d) => `${d.playerName}：${d.message}`)
            .join('\n') || '（尚無發言）';
        const voteLines = pub.voteHistory
            .map((v) => `P${v.voterId} 投 P${v.targetId}（第${v.day}天）`)
            .join('\n') || '（尚無投票）';
        // 私有知識摘要：只含自己的資訊
        const privateLines = [];
        privateLines.push(`你的編號：P${player.id}（${player.name}）`);
        if (player.personality) {
            privateLines.push(`你的名字：${player.personality.name}，職業：${player.personality.occupation}，年齡：${player.personality.age}`);
        }
        if (priv.mySeerChecks && priv.mySeerChecks.length > 0) {
            const checks = priv.mySeerChecks
                .map((c) => `第${c.day}天查驗 P${c.targetId}：${c.result === 'werewolf' ? '人狼' : '村人'}`)
                .join('；');
            privateLines.push(`你的查驗紀錄：${checks}`);
        }
        if (priv.myGuardProtects && priv.myGuardProtects.length > 0) {
            const protects = priv.myGuardProtects
                .map((c) => `第${c.day}天守護 P${c.targetId}${c.success ? '（成功擋殺）' : ''}`)
                .join('；');
            privateLines.push(`你的守護紀錄：${protects}`);
        }
        if (priv.masonPartnerId !== undefined) {
            privateLines.push(`你的共有者夥伴：P${priv.masonPartnerId}`);
        }
        if (priv.wolfAllyIds && priv.wolfAllyIds.length > 0) {
            privateLines.push(`你的人狼同盟：${priv.wolfAllyIds.map((id) => `P${id}`).join('、')}`);
        }
        const systemPrompt = [
            '你是人狼遊戲中的角色。',
            personaPrompt ? `【人格設定】\n${personaPrompt}` : '【人格設定】（無）',
            privateMemory ? `【你的私有記憶】\n${privateMemory}` : '',
            `【你的角色資訊】\n${privateLines.join('\n')}`,
            `【公開知識】第${pub.day}天，存活玩家：${aliveNames}；死亡玩家：${deadNames}。`,
            `【今日對話紀錄】\n${discussionLines}`,
            `【投票紀錄】\n${voteLines}`,
            `你只能回覆對話文字，格式：P${player.id}：「你的發言」`,
        ]
            .filter((s) => s !== '')
            .join('\n\n');
        this.messages.push({ role: 'system', content: systemPrompt });
    }
    /** 取得目前 session 的訊息（唯讀副本，除錯用） */
    getMessages() {
        return [...this.messages];
    }
    /** 白天發言：回傳角色的發言文字 */
    async speak() {
        this.messages.push({
            role: 'user',
            content: '請你現在發言（一句話，30-60字）',
        });
        const reply = await this.provider.chat(this.messages);
        this.messages.push({ role: 'assistant', content: reply });
        return reply;
    }
    /** 白天投票：回傳目標玩家編號，解析失敗回傳 -1 */
    async vote() {
        this.messages.push({
            role: 'user',
            content: '請投票，回覆格式：我投 P{編號}。',
        });
        const reply = await this.provider.chat(this.messages);
        this.messages.push({ role: 'assistant', content: reply });
        const m = reply.match(/P(\d+)/);
        if (!m)
            return -1;
        return parseInt(m[1], 10);
    }
    /**
     * 夜間行動：依角色回傳 NightAction，目標必須存活且非自己，否則回傳 null
     */
    async nightAction() {
        const role = this.player.role;
        if (role === Role.WEREWOLF) {
            this.messages.push({
                role: 'user',
                content: '請選擇今晚要殺害的目標，回覆：我選擇 P{編號}。',
            });
            const reply = await this.provider.chat(this.messages);
            this.messages.push({ role: 'assistant', content: reply });
            const targetId = parseTarget(reply);
            if (!this.isValidNightTarget(targetId))
                return null;
            return { type: NightActionType.WOLF_KILL, targetId: targetId, actorId: this.playerId };
        }
        if (role === Role.SEER) {
            this.messages.push({
                role: 'user',
                content: '請選擇今晚要查驗的目標，回覆：我選擇 P{編號}。',
            });
            const reply = await this.provider.chat(this.messages);
            this.messages.push({ role: 'assistant', content: reply });
            const targetId = parseTarget(reply);
            if (!this.isValidNightTarget(targetId))
                return null;
            return { type: NightActionType.SEER_CHECK, targetId: targetId, actorId: this.playerId };
        }
        if (role === Role.GUARD) {
            this.messages.push({
                role: 'user',
                content: '請選擇今晚要守護的目標，回覆：我選擇 P{編號}。',
            });
            const reply = await this.provider.chat(this.messages);
            this.messages.push({ role: 'assistant', content: reply });
            const targetId = parseTarget(reply);
            if (!this.isValidNightTarget(targetId))
                return null;
            return { type: NightActionType.GUARD_PROTECT, targetId: targetId, actorId: this.playerId };
        }
        return null;
    }
    /** 夜間目標必須是存活且非自己的玩家 */
    isValidNightTarget(targetId) {
        if (targetId === null || Number.isNaN(targetId))
            return false;
        if (targetId === this.playerId)
            return false;
        const alive = getAlivePlayers(this.gameState.players);
        return alive.some((p) => p.id === targetId);
    }
}
function parseTarget(reply) {
    const m = reply.match(/P(\d+)/);
    if (!m)
        return null;
    return parseInt(m[1], 10);
}
//# sourceMappingURL=character-session.js.map