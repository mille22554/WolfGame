/**
 * Day Phase Logic
 * Handles discussion, voting, and elimination
 */
import { GameState, Role, Team, Vote } from './types.js';
/**
 * Result of day voting
 */
export interface VotingResult {
    eliminatedPlayerId?: number;
    eliminatedPlayerRole?: Role;
    voteCounts: Map<number, number>;
    votes: Vote[];
    tie: boolean;
}
/**
 * Conduct voting phase
 * All alive players vote for someone to eliminate
 */
export declare function conductVoting(gameState: GameState, humanVoteTargetId?: number): VotingResult;
/**
 * Format voting result for public announcement
 * IMPORTANT: Role of eliminated player is NOT revealed publicly
 * Only the medium learns it privately
 */
export declare function formatVotingResultPublic(result: VotingResult): string;
/**
 * Format voting result for medium (private)
 */
export declare function formatVotingResultForMedium(result: VotingResult): string | null;
/**
 * Check win conditions
 */
export declare function checkWinCondition(gameState: GameState): Team | null;
/**
 * Get game status summary
 */
export declare function getGameStatus(gameState: GameState): string;
/**
 * Format day start announcement
 */
export declare function formatDayStart(gameState: GameState, nightResult?: any): string;
/**
 * Format discussion prompt — 依 @oracle P0 設計：Day1/Day2+ 差異化，首日避免硬懷疑
 */
export declare function formatDiscussionPrompt(gameState: GameState): string;
//# sourceMappingURL=day.d.ts.map