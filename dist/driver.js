/**
 * 遊戲驅動器：由程式碼直接呼叫 LLM Provider，依序驅動各角色 session
 * 討論保持順序執行，不做平行呼叫
 */
import { Role } from './types.js';
import { addMessage } from './game-state.js';
import { getAlivePlayers, getAliveWerewolves } from './assignment.js';
import { CharacterSession } from './character-session.js';
/**
 * 白天討論：每個存活且非 human 的玩家依序發言，並記錄到 discussionLog
 */
export async function runDiscussion(gameState, provider) {
    const speakers = getAlivePlayers(gameState.players).filter((p) => !p.isHuman);
    for (const player of speakers) {
        const session = new CharacterSession(player.id, provider, gameState);
        const text = await session.speak();
        addMessage(gameState, player.id, text);
    }
}
/**
 * 白天投票：每個存活玩家依序投票，收集 {voterId, targetId}（解析失敗跳過）
 */
export async function runVoting(gameState, provider) {
    const voters = getAlivePlayers(gameState.players);
    const result = [];
    for (const player of voters) {
        const session = new CharacterSession(player.id, provider, gameState);
        const targetId = await session.vote();
        if (targetId === -1)
            continue;
        result.push({ voterId: player.id, targetId });
    }
    return result;
}
/**
 * 夜間行動：狼（第一個存活狼）、預言家、守衛各自決策，組出 GMNightActions
 */
export async function runNight(gameState, provider) {
    const actions = {};
    const wolves = getAliveWerewolves(gameState.players);
    if (wolves.length > 0) {
        const session = new CharacterSession(wolves[0].id, provider, gameState);
        const action = await session.nightAction();
        if (action)
            actions.wolfKill = action.targetId;
    }
    const seer = getAlivePlayers(gameState.players).find((p) => p.role === Role.SEER);
    if (seer) {
        const session = new CharacterSession(seer.id, provider, gameState);
        const action = await session.nightAction();
        if (action)
            actions.seerCheck = action.targetId;
    }
    const guard = getAlivePlayers(gameState.players).find((p) => p.role === Role.GUARD);
    if (guard) {
        const session = new CharacterSession(guard.id, provider, gameState);
        const action = await session.nightAction();
        if (action)
            actions.guardProtect = action.targetId;
    }
    return actions;
}
//# sourceMappingURL=driver.js.map