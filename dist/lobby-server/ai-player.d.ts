/**
 * AI Player — prompt builder + SpeechScheduler 管線
 *
 * 從 character/ 目錄載入 persona，組裝 prompt，呼叫 LLM，parse 回應。
 * 管線：PRE_SPEECH（分批）→ JUDGE → SELECT → EXPAND → BROADCAST
 */
import { type ChatMessage } from './llm.js';
export interface CharacterProfile {
    id: string;
    persona: string;
    memory: string;
}
export declare function loadCharacterProfile(id: string): CharacterProfile | null;
export interface AiPlayerInfo {
    id: number;
    name: string;
    role: string;
    personality: string;
    alive: boolean;
}
export interface AiGameState {
    day: number;
    phase: string;
    players: AiPlayerInfo[];
    /** 對特定玩家可見的私訊（狼隊名單、狂人、占い結果等） */
    privateInfo?: string;
    /** 最近討論訊息（白天討論用） */
    recentMessages?: {
        from: string;
        text: string;
    }[];
}
/** PRE_SPEECH：生成草稿（≤100 token） */
export declare function buildPreSpeechPrompt(player: AiPlayerInfo, profile: CharacterProfile, gameState: AiGameState): ChatMessage[];
/** JUDGE：全盲評分所有草稿 */
export declare function buildJudgePrompt(drafts: string[]): ChatMessage[];
/** EXPAND：將選中的草稿展開為完整發言 */
export declare function buildExpandPrompt(player: AiPlayerInfo, profile: CharacterProfile, draft: string, gameState: AiGameState): ChatMessage[];
export declare function parseJsonResponse(text: string | null): Record<string, any> | null;
export interface PipelineStep {
    name: string;
    prompts: ChatMessage[];
    response: string | null;
    parsed: Record<string, any> | null;
}
export interface PipelineResult {
    steps: PipelineStep[];
    selectedDraftIndex: number;
    finalSpeech: string;
}
/**
 * 執行狼會議管線：
 * 1. PRE_SPEECH：分批（每批 2 個）平行生成草稿，等全部完成
 * 2. JUDGE：全部草稿到齊後，一次性評分
 * 3. SELECT：選最高分（同分取先）
 * 4. EXPAND：被選中的 wolf 展開完整句
 */
export declare function runWolfMeetingPipeline(wolves: AiPlayerInfo[], profiles: Map<string, CharacterProfile>, gameState: AiGameState, onStep?: (step: PipelineStep) => void): Promise<PipelineResult>;
//# sourceMappingURL=ai-player.d.ts.map