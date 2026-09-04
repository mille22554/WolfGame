/**
 * Game State Manager — 純狀態機，不生成任何對話
 * 所有對話和決策由 GM（遊戲主持人）在外部處理
 */
import { Role, Phase, NightActionType, } from './types.js';
import { createPlayers, getAlivePlayers, getAliveWerewolves } from './assignment.js';
import { resolveNightActions, getMediumInfoAtDawn, formatMediumResult } from './night.js';
import { checkWinCondition } from './day.js';
import { getProjectRoot } from './utils.js';
import * as fs from 'fs';
import * as path from 'path';
const STATE_FILE = path.join(getProjectRoot(), 'game-state.json');
/**
 * Initialize a new game
 */
export function initGame(playerCount) {
    const players = createPlayers(playerCount);
    const gameState = {
        players,
        day: 0,
        phase: Phase.SETUP,
        nightActions: [],
        votes: [],
        deathHistory: [],
        discussionLog: [],
        masonChatLog: [],
        gameOver: false,
    };
    saveState(gameState);
    return gameState;
}
/**
 * Save game state to file
 */
export function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}
/**
 * Load game state from file
 */
export function loadState() {
    if (!fs.existsSync(STATE_FILE)) {
        throw new Error('No game state file found. Run "node gm.js init <playerCount>" first.');
    }
    const data = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(data);
}
/**
 * Get current state as a snapshot for GM
 */
export function getStateSnapshot(state) {
    const alivePlayers = getAlivePlayers(state.players);
    const deadPlayers = state.deathHistory.map(d => {
        const player = state.players.find(p => p.id === d.playerId);
        return {
            id: d.playerId,
            name: player?.name || `P${d.playerId}`,
            day: d.day,
            cause: d.cause,
        };
    });
    // Get private info for special roles
    let seerInfo;
    let guardInfo;
    let mediumInfo;
    const seer = state.players.find(p => p.role === Role.SEER && p.alive);
    if (seer && seer.seerChecks && seer.seerChecks.length > 0) {
        const lastCheck = seer.seerChecks[seer.seerChecks.length - 1];
        const target = state.players.find(p => p.id === lastCheck.targetId);
        seerInfo = `你查驗了 ${target?.name || `P${lastCheck.targetId}`}，結果是：${lastCheck.result === 'werewolf' ? '人狼 🔴' : '村人 🟢'}`;
    }
    const guard = state.players.find(p => p.role === Role.GUARD && p.alive);
    if (guard && guard.guardProtects && guard.guardProtects.length > 0) {
        const lastProtect = guard.guardProtects[guard.guardProtects.length - 1];
        const target = state.players.find(p => p.id === lastProtect.targetId);
        guardInfo = `你守護了 ${target?.name || `P${lastProtect.targetId}`}，${lastProtect.success ? '成功擋殺' : '沒有狼人來殺'}`;
    }
    const mediumInfoResult = getMediumInfoAtDawn(state);
    if (mediumInfoResult) {
        const fmt = formatMediumResult(mediumInfoResult);
        if (fmt)
            mediumInfo = fmt;
    }
    return {
        day: state.day,
        phase: state.phase,
        alivePlayers: alivePlayers.map(p => ({
            id: p.id,
            name: p.name,
            role: p.role,
            team: p.team,
            personality: p.personality?.id,
        })),
        deadPlayers,
        seerInfo,
        guardInfo,
        mediumInfo,
        discussionLog: state.discussionLog.map(d => ({
            playerId: d.playerId,
            playerName: state.players.find(p => p.id === d.playerId)?.name || `P${d.playerId}`,
            message: d.message,
            day: d.day,
        })),
        votes: state.votes.map(v => ({
            voterId: v.voterId,
            targetId: v.targetId,
            day: v.day,
        })),
        winner: state.winner,
        gameOver: state.gameOver,
    };
}
/**
 * Start a new day cycle (night phase)
 */
export function startDay(state) {
    state.day++;
    state.phase = Phase.NIGHT;
    state.nightActions = [];
    saveState(state);
    return state;
}
/**
 * Process night actions from GM decisions
 */
export function processNight(state, actions) {
    // Build night actions
    const nightActions = [];
    if (actions.seerCheck !== undefined) {
        const seer = state.players.find(p => p.role === Role.SEER && p.alive);
        if (seer) {
            nightActions.push({
                type: NightActionType.SEER_CHECK,
                actorId: seer.id,
                targetId: actions.seerCheck,
            });
        }
    }
    if (actions.wolfKill !== undefined) {
        const wolves = getAliveWerewolves(state.players);
        if (wolves.length > 0) {
            // Use first wolf as actor (they coordinate anyway)
            nightActions.push({
                type: NightActionType.WOLF_KILL,
                actorId: wolves[0].id,
                targetId: actions.wolfKill,
            });
        }
    }
    if (actions.guardProtect !== undefined) {
        const guard = state.players.find(p => p.role === Role.GUARD && p.alive);
        if (guard) {
            nightActions.push({
                type: NightActionType.GUARD_PROTECT,
                actorId: guard.id,
                targetId: actions.guardProtect,
            });
        }
    }
    state.nightActions = nightActions;
    // Resolve night actions
    const nightResult = resolveNightActions(state);
    // Apply deaths - resolveNightActions already applied kill & deathHistory,
    // but spec's duplicate logic is guarded to avoid double-record
    if (nightResult.killedPlayerId !== undefined && !nightResult.killBlocked) {
        const victim = state.players.find(p => p.id === nightResult.killedPlayerId);
        if (victim) {
            // resolveNightActions already set victim.alive = false and pushed deathHistory
            // Only ensure deathHistory not duplicated
            const alreadyRecorded = state.deathHistory.some(d => d.playerId === victim.id && d.day === state.day && d.cause === 'wolf_kill');
            if (!alreadyRecorded) {
                victim.alive = false;
                state.deathHistory.push({
                    playerId: victim.id,
                    day: state.day,
                    cause: 'wolf_kill',
                });
            }
        }
    }
    // Check win condition
    const winner = checkWinCondition(state);
    if (winner) {
        state.winner = winner;
        state.gameOver = true;
    }
    state.phase = Phase.DAY_DISCUSSION;
    saveState(state);
    return { nightResult, state };
}
/**
 * Record a discussion message from a player
 */
export function addMessage(state, playerId, message) {
    const player = state.players.find(p => p.id === playerId);
    state.discussionLog.push({
        playerId,
        playerName: player?.name || `P${playerId}`,
        message,
        day: state.day,
        phase: 'discussion',
    });
    saveState(state);
    return state;
}
/**
 * Process votes from GM decisions
 */
export function processVotes(state, votes) {
    // Record votes
    for (const vote of votes) {
        state.votes.push({
            voterId: vote.voterId,
            targetId: vote.targetId,
            day: state.day,
        });
    }
    // Count votes
    const voteCounts = new Map();
    for (const vote of votes) {
        voteCounts.set(vote.targetId, (voteCounts.get(vote.targetId) || 0) + 1);
    }
    // Find player with most votes
    let maxVotes = 0;
    let eliminatedPlayerId;
    let tie = false;
    for (const [targetId, count] of voteCounts) {
        if (count > maxVotes) {
            maxVotes = count;
            eliminatedPlayerId = targetId;
            tie = false;
        }
        else if (count === maxVotes) {
            tie = true;
        }
    }
    // Handle tie - no elimination
    if (tie) {
        eliminatedPlayerId = undefined;
    }
    // Eliminate player
    if (eliminatedPlayerId !== undefined) {
        const victim = state.players.find(p => p.id === eliminatedPlayerId);
        if (victim) {
            victim.alive = false;
            state.deathHistory.push({
                playerId: victim.id,
                day: state.day,
                cause: 'vote',
            });
        }
    }
    // Check win condition
    const winner = checkWinCondition(state);
    if (winner) {
        state.winner = winner;
        state.gameOver = true;
    }
    saveState(state);
    return {
        eliminatedPlayerId,
        eliminatedPlayerRole: eliminatedPlayerId !== undefined
            ? state.players.find(p => p.id === eliminatedPlayerId)?.role
            : undefined,
        state,
    };
}
/**
 * Reveal all roles (end of game)
 */
export function revealRoles(state) {
    return state.players.map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        team: p.team,
        alive: p.alive,
    }));
}
//# sourceMappingURL=game-state.js.map