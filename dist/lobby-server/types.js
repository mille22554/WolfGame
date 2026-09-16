/**
 * types.ts — lobby-server 共用型別與常數
 *
 * 多房大廳 WebSocket 協定（ubuntu 分支）：
 * - ClientToServerMessage：client → server
 * - ServerToClientMessage：server → client
 */
export const MIN_PLAYERS = 6;
export const MAX_PLAYERS = 15;
export const MAX_MEMBERS_PER_ROOM = 20;
export const MAX_MESSAGE_LEN = 200;
/** 狼會議安全上限（測試用）：白板累計 N 則 WOLF_MESSAGE 未收斂 → 停止並報告 */
export const WOLF_MESSAGE_CAP = 100;
export const CHAT_LIMIT = 50;
export const RATE_LIMIT_PER_MIN = 10;
//# sourceMappingURL=types.js.map