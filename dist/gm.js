/**
 * Game Master CLI — Phase 0：GameEngine 的 CLI 包裝
 * 用法：node dist/gm.js <init|join|state|start-day|night|speak|wolf-ready|vote|mason-chat|reveal>
 */
import { GameEngine } from './engine.js';
import { createGameState, loadState, buildGMSnapshot, getNightActors, } from './game-state.js';
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
/** 載入存檔並接上 engine（mode: 'gm'） */
function loadEngine() {
    const state = loadState();
    if (!state) {
        error('No game state file found. Run "node dist/gm.js init <playerCount>" first.');
        throw new Error('unreachable');
    }
    return new GameEngine({ mode: 'gm' }, state);
}
/** 推進佇列、存檔、輸出 GMSnapshot */
function flush(engine, message) {
    engine.drain();
    engine.save();
    const snapshot = buildGMSnapshot(engine.getState());
    engine.close();
    if (message)
        output({ message, state: snapshot });
    else
        output(snapshot);
}
switch (command) {
    case 'init': {
        const playerCount = parseInt(args[1] || '9', 10);
        if (!Number.isInteger(playerCount) || playerCount < 6 || playerCount > 15) {
            error(`Player count must be 6-15, got ${args[1]}`);
        }
        let humans = [];
        if (args[2]) {
            try {
                humans = JSON.parse(args[2]);
            }
            catch {
                error(`Invalid humanPlayerIndices JSON: ${args[2]}`);
            }
        }
        const engine = new GameEngine({ mode: 'gm' }, createGameState(playerCount, humans));
        engine.save();
        const snapshot = buildGMSnapshot(engine.getState());
        engine.close();
        output({ message: `Game initialized with ${playerCount} players`, state: snapshot });
        break;
    }
    case 'join': {
        const name = args[1];
        if (!name)
            error('Usage: gm.js join <name>');
        const engine = loadEngine();
        engine.enqueue({ type: 'CLIENT_JOIN', name });
        flush(engine, `Player ${name} joined`);
        break;
    }
    case 'state': {
        const state = loadState();
        if (!state)
            error('No game state file found.');
        output(buildGMSnapshot(state));
        break;
    }
    case 'start-day': {
        const engine = loadEngine();
        engine.enqueue({ type: 'START_GAME' });
        flush(engine, 'Game started');
        break;
    }
    case 'night': {
        // night <playerId> <targetId>：依 getNightActors 驗證覆蓋；
        // AI → AI_NIGHT_DONE，真人 → HUMAN_NIGHT_ACTION
        const playerId = parseInt(args[1], 10);
        const targetId = parseInt(args[2], 10);
        if (!Number.isInteger(playerId) || !Number.isInteger(targetId)) {
            error('Usage: gm.js night <playerId> <targetId>');
        }
        const engine = loadEngine();
        const state = engine.getState();
        const actors = getNightActors(state);
        if (!actors.includes(playerId)) {
            error(`P${playerId} is not a night actor tonight (actors: ${actors.join(', ') || 'none'})`);
        }
        const player = state.players.find((p) => p.id === playerId);
        if (!player)
            error(`Unknown player P${playerId}`);
        if (player.controlledBy === 'ai') {
            engine.enqueue({ type: 'AI_NIGHT_DONE', playerId, targetId });
        }
        else {
            engine.enqueue({ type: 'HUMAN_NIGHT_ACTION', playerId, targetId });
        }
        flush(engine, `Night action recorded for P${playerId}`);
        break;
    }
    case 'speak': {
        // speak <playerId> <message>：狼會議階段 → HUMAN_WOLF_SPEAK / AI_WOLF_SPEECH_DONE；白天 → HUMAN_SPEAK / AI_SPEECH_DONE
        const playerId = parseInt(args[1], 10);
        const message = args.slice(2).join(' ');
        if (!Number.isInteger(playerId) || !message) {
            error('Usage: gm.js speak <playerId> <message>');
        }
        const engine = loadEngine();
        const state = engine.getState();
        const player = state.players.find((p) => p.id === playerId);
        if (!player)
            error(`Unknown player P${playerId}`);
        if (state.phase === 'NIGHT_DISCUSSION_OPEN') {
            if (player.controlledBy === 'human') {
                engine.enqueue({ type: 'HUMAN_WOLF_SPEAK', playerId, text: message });
            }
            else {
                engine.enqueue({
                    type: 'AI_WOLF_SPEECH_DONE',
                    playerId,
                    text: message,
                    boardVersion: state.boardVersion,
                });
            }
        }
        else if (player.controlledBy === 'human') {
            engine.enqueue({ type: 'HUMAN_SPEAK', playerId, text: message });
        }
        else {
            engine.enqueue({
                type: 'AI_SPEECH_DONE',
                playerId,
                text: message,
                boardVersion: state.boardVersion,
            });
        }
        flush(engine, `Recorded message from P${playerId}`);
        break;
    }
    case 'wolf-ready': {
        // wolf-ready <playerId>：存活狼收斂；AI → AI_WOLF_READY，真人 → HUMAN_WOLF_READY
        const playerId = parseInt(args[1], 10);
        if (!Number.isInteger(playerId)) {
            error('Usage: gm.js wolf-ready <playerId>');
        }
        const engine = loadEngine();
        const player = engine.getState().players.find((p) => p.id === playerId);
        if (!player)
            error(`Unknown player P${playerId}`);
        if (!player.alive || player.role !== Role.WEREWOLF) {
            error(`P${playerId} is not an alive wolf`);
        }
        if (player.controlledBy === 'ai') {
            engine.enqueue({ type: 'AI_WOLF_READY', playerId });
        }
        else {
            engine.enqueue({ type: 'HUMAN_WOLF_READY', playerId });
        }
        flush(engine, `Wolf ready recorded for P${playerId}`);
        break;
    }
    case 'vote': {
        // vote <playerId> <targetId>：幫所有存活玩家點頭（灌滿 ready）→ 統一檢查直進投票 → 投票事件
        // （CLOSING 已移除；若統一檢查未全過仍在討論，投票事件會被忽略）
        const playerId = parseInt(args[1], 10);
        const targetId = parseInt(args[2], 10);
        if (!Number.isInteger(playerId) || !Number.isInteger(targetId)) {
            error('Usage: gm.js vote <playerId> <targetId>');
        }
        const engine = loadEngine();
        const state = engine.getState();
        const player = state.players.find((p) => p.id === playerId);
        if (!player)
            error(`Unknown player P${playerId}`);
        for (const p of state.players.filter((x) => x.alive)) {
            engine.enqueue(p.controlledBy === 'human'
                ? { type: 'HUMAN_READY_VOTE', playerId: p.id }
                : { type: 'AI_READY_VOTE', playerId: p.id });
        }
        if (player.controlledBy === 'human') {
            engine.enqueue({ type: 'HUMAN_VOTE', playerId, targetId });
        }
        else {
            engine.enqueue({ type: 'AI_VOTE_DONE', playerId, targetId });
        }
        flush(engine, `Vote recorded: P${playerId} -> P${targetId}`);
        break;
    }
    case 'mason-chat': {
        const playerId = parseInt(args[1], 10);
        const message = args.slice(2).join(' ');
        if (!Number.isInteger(playerId) || !message) {
            error('Usage: gm.js mason-chat <playerId> <message>');
        }
        const engine = loadEngine();
        const player = engine.getState().players.find((p) => p.id === playerId);
        if (!player || player.role !== Role.MASON) {
            error(`P${playerId} is not a mason`);
        }
        engine.enqueue({ type: 'MASON_CHAT', playerId, text: message });
        flush(engine, `Recorded mason chat from P${playerId}`);
        break;
    }
    case 'reveal': {
        const state = loadState();
        if (!state)
            error('No game state file found.');
        output({
            roles: state.players.map((p) => ({
                id: p.id,
                name: p.name,
                role: p.role,
                team: p.team,
                alive: p.alive,
            })),
            winner: state.winner,
        });
        break;
    }
    default:
        error(`Unknown command: ${command}. Available: init, join, state, start-day, night, speak, wolf-ready, vote, mason-chat, reveal`);
}
//# sourceMappingURL=gm.js.map