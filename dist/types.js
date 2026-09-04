/**
 * Werewolf Game Types
 * Core type definitions for the game engine
 */
// ============================================
// Role Definitions
// ============================================
export var Role;
(function (Role) {
    Role["VILLAGER"] = "villager";
    Role["SEER"] = "seer";
    Role["MEDIUM"] = "medium";
    Role["GUARD"] = "guard";
    Role["MASON"] = "mason";
    Role["WEREWOLF"] = "werewolf";
    Role["MADMAN"] = "madman";
})(Role || (Role = {}));
export var Team;
(function (Team) {
    Team["VILLAGE"] = "village";
    Team["WEREWOLF"] = "werewolf";
})(Team || (Team = {}));
export var Phase;
(function (Phase) {
    Phase["SETUP"] = "setup";
    Phase["NIGHT"] = "night";
    Phase["DAY_DISCUSSION"] = "day_discussion";
    Phase["DAY_VOTING"] = "day_voting";
    Phase["DAY_RESULT"] = "day_result";
    Phase["GAME_OVER"] = "game_over";
})(Phase || (Phase = {}));
export var NightActionType;
(function (NightActionType) {
    NightActionType["WOLF_KILL"] = "wolf_kill";
    NightActionType["SEER_CHECK"] = "seer_check";
    NightActionType["GUARD_PROTECT"] = "guard_protect";
    // Medium has no active action - receives info passively
    // Masons have private chat (handled separately)
})(NightActionType || (NightActionType = {}));
export var SeerResult;
(function (SeerResult) {
    SeerResult["VILLAGER"] = "villager";
    SeerResult["WEREWOLF"] = "werewolf";
})(SeerResult || (SeerResult = {}));
export var MediumResult;
(function (MediumResult) {
    MediumResult["VILLAGER"] = "villager";
    MediumResult["WEREWOLF"] = "werewolf";
})(MediumResult || (MediumResult = {}));
export const ROLE_CONFIG = {
    6: { [Role.VILLAGER]: 2, [Role.SEER]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 1, [Role.MADMAN]: 1 },
    7: { [Role.VILLAGER]: 3, [Role.SEER]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 1, [Role.MADMAN]: 1 },
    8: { [Role.VILLAGER]: 2, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
    9: { [Role.VILLAGER]: 3, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
    10: { [Role.VILLAGER]: 4, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
    11: { [Role.VILLAGER]: 5, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
    12: { [Role.VILLAGER]: 6, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.WEREWOLF]: 2, [Role.MADMAN]: 1 },
    13: { [Role.VILLAGER]: 4, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.MASON]: 2, [Role.WEREWOLF]: 3, [Role.MADMAN]: 1 },
    14: { [Role.VILLAGER]: 5, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.MASON]: 2, [Role.WEREWOLF]: 3, [Role.MADMAN]: 1 },
    15: { [Role.VILLAGER]: 6, [Role.SEER]: 1, [Role.MEDIUM]: 1, [Role.GUARD]: 1, [Role.MASON]: 2, [Role.WEREWOLF]: 3, [Role.MADMAN]: 1 },
};
// ============================================
// Role Metadata
// ============================================
export const ROLE_TEAM = {
    [Role.VILLAGER]: Team.VILLAGE,
    [Role.SEER]: Team.VILLAGE,
    [Role.MEDIUM]: Team.VILLAGE,
    [Role.GUARD]: Team.VILLAGE,
    [Role.MASON]: Team.VILLAGE,
    [Role.WEREWOLF]: Team.WEREWOLF,
    [Role.MADMAN]: Team.VILLAGE, // Madman is human team but wins with wolves
};
export const ROLE_DISPLAY = {
    // 守衛即獵人/狩人（顯示為「獵人」以對應官方與截圖）
    [Role.VILLAGER]: '村民 🟢',
    [Role.SEER]: '占い師 🔮',
    [Role.MEDIUM]: '靈能者 👁️',
    [Role.GUARD]: '獵人 🛡️', // 獵人（狩人/守衛）
    [Role.MASON]: '共有者 🤝',
    [Role.WEREWOLF]: '人狼 🔴',
    [Role.MADMAN]: '狂人 🤡',
};
export const ROLE_DESCRIPTION = {
    // 守衛即獵人/狩人
    [Role.VILLAGER]: '無特殊能力，靠推理與投票找出人狼',
    [Role.SEER]: '每夜選一名存活玩家查驗，結果為「村人」或「人狼」（狂人顯示為村人）',
    [Role.MEDIUM]: '只能得知白天被投票出局者的身分（「村人」或「人狼」），夜間被殺者無法得知',
    [Role.GUARD]: '獵人（狩人/守衛）：每夜守護一人免於人狼襲擊，可連續守護同一人，第一天不可守護',
    [Role.MASON]: '雙人組，互相知道對方身分，夜間可私聊，查驗結果為「村人」',
    [Role.WEREWOLF]: '夜間互相認識並合謀，全體共同選擇一人殺害，查驗結果為「人狼」',
    [Role.MADMAN]: '為人類陣營效力但不知同夥誰，無特殊能力，查驗結果為「村人」，人狼勝則狂人勝',
};
// ============================================
// Utility Functions
// ============================================
export function getTeam(role) {
    return ROLE_TEAM[role];
}
export function getDisplayName(role) {
    return ROLE_DISPLAY[role];
}
export function getDescription(role) {
    return ROLE_DESCRIPTION[role];
}
export function isVillageTeam(role) {
    return ROLE_TEAM[role] === Team.VILLAGE;
}
export function isWerewolfTeam(role) {
    return ROLE_TEAM[role] === Team.WEREWOLF;
}
export function seerSeesAs(targetRole) {
    // Seer sees Werewolf as Werewolf, everything else as Villager (including Madman, Mason)
    return targetRole === Role.WEREWOLF ? SeerResult.WEREWOLF : SeerResult.VILLAGER;
}
export function mediumSeesAs(targetRole) {
    // Medium sees Werewolf as Werewolf, everything else as Villager (cannot distinguish Madman)
    return targetRole === Role.WEREWOLF ? MediumResult.WEREWOLF : MediumResult.VILLAGER;
}
//# sourceMappingURL=types.js.map