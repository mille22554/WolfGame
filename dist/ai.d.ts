import { GameState, Player, Role, Team, Phase, NightAction, SeerResult, Vote, DiscussionEntry } from './types.js';
export interface PublicKnowledge {
    day: number;
    phase: Phase;
    alivePlayers: Player[];
    deadPlayers: Player[];
    voteHistory: Vote[];
    discussionLog: DiscussionEntry[];
    publicClaims: Map<number, {
        role: Role;
        day: number;
    }>;
    publicSeerResults: Map<number, {
        targetId: number;
        result: SeerResult;
        day: number;
    }>;
    publicMediumResults: Map<number, {
        playerId: number;
        result: 'villager' | 'werewolf';
        day: number;
    }>;
    publicGuardProtects: Map<number, {
        targetId: number;
        day: number;
        success: boolean;
    }>;
}
export interface PrivateKnowledge {
    myRole: Role;
    myTeam: Team;
    mySeerChecks?: {
        targetId: number;
        result: SeerResult;
        day: number;
    }[];
    myGuardProtects?: {
        targetId: number;
        day: number;
        success: boolean;
    }[];
    masonPartnerId?: number;
    wolfAllyIds?: number[];
}
export declare function buildPublicKnowledge(gameState: GameState): PublicKnowledge;
export declare function buildPrivateKnowledge(player: Player, gameState: GameState): PrivateKnowledge;
export declare function isAccusatoryContext(msg: string, idx: number, len: number): boolean;
export declare function parseAccusatoryIds(msg: string, alivePlayers: Player[]): number[];
export declare function cleanTarget(id: number | string): string;
export declare function hasSpoken(id: number, messages: DiscussionEntry[]): boolean;
export declare function hasPointedAt(accuserId: number, targetId: number, messages: DiscussionEntry[], _alivePlayers?: Player[]): boolean;
export declare function hasBeenAccused(targetId: number, messages: DiscussionEntry[], _alivePlayers?: Player[]): boolean;
export declare function hasDefended(helperId: number, targetId: number, messages: DiscussionEntry[]): boolean;
export declare function hasSaidNeutral(id: number, messages: DiscussionEntry[]): boolean;
export declare function hasStatedOn(targetId: number, XId: number, messages: DiscussionEntry[]): boolean;
export declare function getVoteTargetOf(id: number, messages: DiscussionEntry[]): number | null;
export interface ReasoningContext {
    suspectRanking: number[];
    confidence: number;
    keyEvidence: string;
}
export declare function computeReasoningContext(player: Player, gameState: GameState): ReasoningContext;
export declare class AIPlayer {
    player: Player;
    private gameState;
    constructor(player: Player, gameState: GameState);
    private buildReasoningContext;
    decideNightAction(): NightAction | null;
    private decideWolfKill;
    private decideSeerCheck;
    private decideGuardProtect;
    decideVote(): number;
    getReasoningContext(): ReasoningContext;
    private villagerVoteStrategy;
    private wolfVoteStrategy;
    private seerVoteStrategy;
    private guardVoteStrategy;
    private mediumVoteStrategy;
    private masonVoteStrategy;
    private madmanVoteStrategy;
}
export declare function createAIPlayers(gameState: GameState): AIPlayer[];
//# sourceMappingURL=ai.d.ts.map