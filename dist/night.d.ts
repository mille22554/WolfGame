/**
 * Night Phase Resolution
 * Handles all night actions: wolf kill, seer check, guard protect, medium info
 */
import { GameState, Role, SeerResult } from './types.js';
/**
 * Result of night resolution
 */
export interface NightResolutionResult {
    killedPlayerId?: number;
    killedPlayerRole?: Role;
    killBlocked: boolean;
    guardedPlayerId?: number;
    seerCheckTargetId?: number;
    seerCheckResult?: SeerResult;
    mediumInfo?: {
        playerId: number;
        role: Role;
        result: 'villager' | 'werewolf';
    };
    log: string[];
}
/**
 * Resolve all night actions for the current night
 * Order: Guard -> Wolf -> Seer (guard protects before wolf kills)
 * Medium receives info about previous day's vote at dawn
 */
export declare function resolveNightActions(gameState: GameState): NightResolutionResult;
/**
 * Get medium's info at dawn (about previous day's vote elimination)
 * Called at start of day phase
 */
export declare function getMediumInfoAtDawn(gameState: GameState): {
    playerId: number;
    role: Role;
    result: 'villager' | 'werewolf';
} | null;
/**
 * Format night result for GM log
 */
export declare function formatNightResult(result: NightResolutionResult): string;
/**
 * Format seer result for seer player only
 */
export declare function formatSeerResult(result: NightResolutionResult): string | null;
/**
 * Format guard result for guard player only
 */
export declare function formatGuardResult(result: NightResolutionResult): string | null;
/**
 * Format medium result for medium player only
 */
export declare function formatMediumResult(info: {
    playerId: number;
    result: 'villager' | 'werewolf';
} | null): string | null;
//# sourceMappingURL=night.d.ts.map