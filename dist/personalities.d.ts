/**
 * AI Personality Database
 * 15 個獨特的 AI 人格，用於生成自然、有個性的對話
 */
export interface Personality {
    id: string;
    name: string;
    age: number;
    occupation: string;
    gamesPlayed: number;
    speechStyle: {
        sentenceLength: 'short' | 'medium' | 'long';
        常用語: string[];
        禁用詞: string[];
        語尾: string[];
        問句比例: number;
    };
    psychology: {
        stressResponse: 'calm' | 'emotional' | 'aggressive' | 'evasive';
        trustMode: 'logical' | 'intuitive' | 'skeptical' | 'naive';
        riskTolerance: 'cautious' | 'balanced' | 'bold';
        decisionSpeed: 'fast' | 'moderate' | 'slow';
    };
    social: {
        leadership: number;
        aggression: number;
        cooperativeness: number;
        suspicion: number;
    };
    strategy: {
        earlyGame: 'aggressive' | 'defensive' | 'observant' | 'chaotic';
        claimStyle: 'bold' | 'cautious' | 'delayed' | 'never';
        votingPattern: 'logical' | 'emotional' | 'random' | 'follow_leader';
    };
    pressureLines: {
        whenAccused: string[];
        whenDefending: string[];
        whenAttacking: string[];
        whenUncertain: string[];
    };
    interactions: {
        getsAlongWith: string[];
        conflictsWith: string[];
        influences: string[];
    };
}
export declare const personalities: Personality[];
/**
 * 隨機分配人格給玩家
 */
export declare function assignPersonalities(playerCount: number): Personality[];
/**
 * 根據人格生成壓力台詞
 */
export declare function getPressureLine(personality: Personality, situation: 'accused' | 'defending' | 'attacking' | 'uncertain'): string;
//# sourceMappingURL=personalities.d.ts.map