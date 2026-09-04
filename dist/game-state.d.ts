/**
 * Game State Manager — 純狀態機，不生成任何對話
 * 所有對話和決策由 GM（遊戲主持人）在外部處理
 */
import { GameState, Role } from './types.js';
export interface GMNightActions {
    seerCheck?: number;
    wolfKill?: number;
    guardProtect?: number;
}
export interface GMVote {
    voterId: number;
    targetId: number;
}
export interface GameStateSnapshot {
    day: number;
    phase: string;
    alivePlayers: {
        id: number;
        name: string;
        role: string;
        team: string;
        personality?: string;
    }[];
    deadPlayers: {
        id: number;
        name: string;
        day: number;
        cause: string;
    }[];
    nightResult?: string;
    seerInfo?: string;
    guardInfo?: string;
    mediumInfo?: string;
    discussionLog: {
        playerId: number;
        playerName: string;
        message: string;
        day: number;
    }[];
    votes: {
        voterId: number;
        targetId: number;
        day: number;
    }[];
    winner?: string;
    gameOver: boolean;
}
/**
 * Initialize a new game
 */
export declare function initGame(playerCount: number): GameState;
/**
 * Save game state to file
 */
export declare function saveState(state: GameState): void;
/**
 * Load game state from file
 */
export declare function loadState(): GameState;
/**
 * Get current state as a snapshot for GM
 */
export declare function getStateSnapshot(state: GameState): GameStateSnapshot;
/**
 * Start a new day cycle (night phase)
 */
export declare function startDay(state: GameState): GameState;
/**
 * Process night actions from GM decisions
 */
export declare function processNight(state: GameState, actions: GMNightActions): {
    nightResult: any;
    state: GameState;
};
/**
 * Record a discussion message from a player
 */
export declare function addMessage(state: GameState, playerId: number, message: string): GameState;
/**
 * Process votes from GM decisions
 */
export declare function processVotes(state: GameState, votes: GMVote[]): {
    eliminatedPlayerId?: number;
    eliminatedPlayerRole?: Role;
    state: GameState;
};
/**
 * Reveal all roles (end of game)
 */
export declare function revealRoles(state: GameState): {
    id: number;
    name: string;
    role: string;
    team: string;
    alive: boolean;
}[];
//# sourceMappingURL=game-state.d.ts.map