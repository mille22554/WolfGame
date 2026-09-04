/**
 * 角色 Session 管理器
 * 每個角色擁有獨立 session：人格 prompt + 私有記憶 + 公開知識 + 自己的私有知識
 * 資訊隔離：絕不載入其他角色的私有記憶、查驗結果或同盟資訊
 */
import { GameState, NightAction } from './types.js';
import { LLMProvider, ChatMessage } from './llm.js';
/**
 * 單一角色的獨立 LLM session
 */
export declare class CharacterSession {
    readonly playerId: number;
    private readonly provider;
    private readonly gameState;
    private readonly player;
    private readonly messages;
    constructor(playerId: number, provider: LLMProvider, gameState: GameState);
    /** 取得目前 session 的訊息（唯讀副本，除錯用） */
    getMessages(): ChatMessage[];
    /** 白天發言：回傳角色的發言文字 */
    speak(): Promise<string>;
    /** 白天投票：回傳目標玩家編號，解析失敗回傳 -1 */
    vote(): Promise<number>;
    /**
     * 夜間行動：依角色回傳 NightAction，目標必須存活且非自己，否則回傳 null
     */
    nightAction(): Promise<NightAction | null>;
    /** 夜間目標必須是存活且非自己的玩家 */
    private isValidNightTarget;
}
//# sourceMappingURL=character-session.d.ts.map