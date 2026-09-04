/**
 * Game Master CLI — 供 GM 在 opencode 對話中呼叫
 * 所有對話和決策由 GM（AI）在外部處理，此 CLI 只負責狀態管理
 */
import { initGame, loadState, saveState, getStateSnapshot, startDay, processNight, addMessage, processVotes, revealRoles, } from './game-state.js';
import { Role } from './types.js';
const args = process.argv.slice(2);
const command = args[0];
function output(data) {
    console.log(JSON.stringify(data, null, 2));
}
function error(msg) {
    console.error(JSON.stringify({ error: msg }));
    process.exit(1);
}
switch (command) {
    case 'init': {
        const playerCount = parseInt(args[1]) || 9;
        if (playerCount < 6 || playerCount > 15) {
            error(`Player count must be 6-15, got ${playerCount}`);
        }
        const state = initGame(playerCount);
        const snapshot = getStateSnapshot(state);
        output({ message: `Game initialized with ${playerCount} players`, state: snapshot });
        break;
    }
    case 'state': {
        const state = loadState();
        const snapshot = getStateSnapshot(state);
        output(snapshot);
        break;
    }
    case 'start-day': {
        const state = loadState();
        startDay(state);
        const snapshot = getStateSnapshot(state);
        output({ message: `Day ${snapshot.day} started`, state: snapshot });
        break;
    }
    case 'night': {
        const state = loadState();
        const actions = JSON.parse(args[1] || '{}');
        const { nightResult, state: updatedState } = processNight(state, actions);
        const snapshot = getStateSnapshot(updatedState);
        output({ nightResult: {
                killed: nightResult.killedPlayerId,
                killBlocked: nightResult.killBlocked,
                guarded: nightResult.guardedPlayerId,
                seerCheck: nightResult.seerCheckTargetId,
                seerResult: nightResult.seerCheckResult,
            }, state: snapshot });
        break;
    }
    case 'speak': {
        const state = loadState();
        const playerId = parseInt(args[1]);
        const message = args[2];
        if (!playerId || !message) {
            error('Usage: gm.js speak <playerId> <message>');
        }
        addMessage(state, playerId, message);
        output({ message: `Recorded message from P${playerId}` });
        break;
    }
    case 'vote': {
        const state = loadState();
        const votes = JSON.parse(args[1] || '[]');
        const { eliminatedPlayerId, eliminatedPlayerRole, state: updatedState } = processVotes(state, votes);
        const snapshot = getStateSnapshot(updatedState);
        output({
            eliminated: eliminatedPlayerId,
            eliminatedRole: eliminatedPlayerRole,
            state: snapshot,
        });
        break;
    }
    case 'mason-chat': {
        const state = loadState();
        const playerId = parseInt(args[1]);
        const message = args[2];
        if (!playerId || !message) {
            error('Usage: gm.js mason-chat <playerId> <message>');
        }
        const player = state.players.find(p => p.id === playerId);
        if (!player || player.role !== Role.MASON) {
            error(`P${playerId} is not a mason`);
        }
        state.masonChatLog.push({
            playerId,
            playerName: player.name,
            message,
            night: state.day,
        });
        saveState(state);
        output({ message: `Recorded mason chat from P${playerId}` });
        break;
    }
    case 'reveal': {
        const state = loadState();
        const roles = revealRoles(state);
        output({ roles, winner: state.winner });
        break;
    }
    default:
        error(`Unknown command: ${command}. Available: init, state, start-day, night, speak, vote, reveal`);
}
//# sourceMappingURL=gm.js.map