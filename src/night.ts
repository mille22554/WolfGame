/**
 * Night Phase Resolution
 * Handles all night actions: wolf kill, seer check, guard protect, medium info
 */

import {
  GameState,
  Player,
  Role,
  Team,
  Phase,
  NightAction,
  NightActionType,
  SeerResult,
  DeathRecord,
  SeerCheck,
  GuardProtect,
} from './types.js';
import { getAlivePlayers, getAliveWerewolves, canGuardAct } from './assignment.js';
import { seerSeesAs } from './types.js';
import { pickRandomExcluding, findPlayerById } from './utils.js';

/**
 * Result of night resolution
 */
export interface NightResolutionResult {
  // Who died (if anyone)
  killedPlayerId?: number;
  killedPlayerRole?: Role;
  killBlocked: boolean;           // Whether guard blocked the kill
  guardedPlayerId?: number;       // Who guard protected
  
  // Seer result
  seerCheckTargetId?: number;
  seerCheckResult?: SeerResult;
  
  // Medium info (about yesterday's vote)
  mediumInfo?: {
    playerId: number;
    role: Role;
    result: 'villager' | 'werewolf';
  };
  
  // For logging
  log: string[];
}

/**
 * Resolve all night actions for the current night
 * Order: Guard -> Wolf -> Seer (guard protects before wolf kills)
 * Medium receives info about previous day's vote at dawn
 */
export function resolveNightActions(gameState: GameState): NightResolutionResult {
  const log: string[] = [];
  const result: NightResolutionResult = {
    killBlocked: false,
    log,
  };

  const alivePlayers = getAlivePlayers(gameState.players);
  const aliveWerewolves = getAliveWerewolves(gameState.players);
  const currentDay = gameState.day;

  log.push(`=== 第 ${currentDay} 夜 夜間行動 ===`);

  // ============================================
  // 1. GUARD PROTECTION (happens first)
  // ============================================
  const guard = alivePlayers.find(p => p.role === Role.GUARD);
  let guardedTargetId: number | undefined;
  
  if (guard && canGuardAct(guard, currentDay)) {
    // Find guard's action
    const guardAction = gameState.nightActions.find(
      a => a.actorId === guard.id && a.type === NightActionType.GUARD_PROTECT
    );
    
    if (guardAction) {
      guardedTargetId = guardAction.targetId;
      // 守衛不可自保：若指定自己，視為無效，改為隨機守護其他玩家
      if (guardedTargetId === guard.id) {
        const candidates = alivePlayers.filter(p => p.id !== guard.id);
        if (candidates.length > 0) {
          guardedTargetId = pickRandomExcluding(candidates, [])!.id;
          log.push(`🛡️ 守衛 (P${guard.id}) 指定自保無效，改為隨機守護 P${guardedTargetId}`);
        } else {
          guardedTargetId = undefined;
        }
      }
      const target = guardedTargetId !== undefined ? findPlayerById(alivePlayers, guardedTargetId) : undefined;
      if (target && guardedTargetId !== undefined) {
        gameState.guardProtectedTarget = guardedTargetId;
        log.push(`🛡️ 守衛 (P${guard.id}) 守護了 P${guardedTargetId}`);
        
        // Record guard protect history
        if (!guard.guardProtects) guard.guardProtects = [];
        guard.guardProtects.push({
          targetId: guardedTargetId,
          day: currentDay,
          success: false, // Will update after wolf kill resolution
        });
      }
    } else {
      // Guard must act - pick random if no action (shouldn't happen with proper AI)
      const candidates = alivePlayers.filter(p => p.id !== guard.id);
      if (candidates.length > 0) {
        guardedTargetId = pickRandomExcluding(candidates, [])!.id;
        gameState.guardProtectedTarget = guardedTargetId;
        log.push(`🛡️ 守衛 (P${guard.id}) 隨機守護了 P${guardedTargetId}`);
      }
    }
  } else if (guard && currentDay === 1) {
    log.push(`🛡️ 守衛 (P${guard.id}) 第一晚不可守護`);
  }

  // ============================================
  // 2. WEREWOLF KILL (collective decision)
  // ============================================
  let wolfKillTargetId: number | undefined;
  
  if (aliveWerewolves.length > 0) {
    // Find wolf kill action (all wolves should agree on same target)
    const wolfActions = gameState.nightActions.filter(
      a => a.type === NightActionType.WOLF_KILL
    );
    
    if (wolfActions.length > 0) {
      // Use first wolf's choice (they should all be same)
      wolfKillTargetId = wolfActions[0].targetId;
    } else {
      // Wolves must kill - pick random non-wolf
      const candidates = alivePlayers.filter(p => p.team !== Team.WEREWOLF);
      if (candidates.length > 0) {
        wolfKillTargetId = pickRandomExcluding(candidates, [])!.id;
      }
    }

    if (wolfKillTargetId) {
      const target = findPlayerById(alivePlayers, wolfKillTargetId);
      if (target) {
        gameState.wolfKillTarget = wolfKillTargetId;
        log.push(`🔴 人狼 選擇襲擊 P${wolfKillTargetId}`);
        
        // Check if guard protected this target
        if (guardedTargetId === wolfKillTargetId) {
          result.killBlocked = true;
          log.push(`🛡️ 守衛成功守護了 P${wolfKillTargetId}，襲擊失敗！`);
          
          // Update guard protect history
          if (guard?.guardProtects) {
            const lastProtect = guard.guardProtects[guard.guardProtects.length - 1];
            if (lastProtect && lastProtect.targetId === wolfKillTargetId) {
              lastProtect.success = true;
            }
          }
        } else {
          // Kill succeeds
          result.killedPlayerId = wolfKillTargetId;
          result.killedPlayerRole = target.role;
          target.alive = false;
          
          // Record death
          const deathRecord: DeathRecord = {
            playerId: wolfKillTargetId,
            day: currentDay,
            cause: 'wolf_kill',
          };
          gameState.deathHistory.push(deathRecord);
          
          log.push(`💀 P${wolfKillTargetId} 被人狼殺害了！`);
        }
      }
    }
  }

  // ============================================
  // 3. SEER CHECK
  // ============================================
  const seer = alivePlayers.find(p => p.role === Role.SEER);
  
  if (seer) {
    const seerAction = gameState.nightActions.find(
      a => a.actorId === seer.id && a.type === NightActionType.SEER_CHECK
    );
    
    if (seerAction) {
      const targetId = seerAction.targetId;
      const target = findPlayerById(alivePlayers, targetId);
      
      if (target) {
        const seerResult = seerSeesAs(target.role);
        result.seerCheckTargetId = targetId;
        result.seerCheckResult = seerResult;
        gameState.seerCheckTarget = targetId;
        gameState.seerCheckResult = seerResult;
        
        // Record seer check history
        if (!seer.seerChecks) seer.seerChecks = [];
        seer.seerChecks.push({
          targetId,
          result: seerResult,
          day: currentDay,
        });
        
        const resultText = seerResult === SeerResult.WEREWOLF ? '人狼 🔴' : '村人 🟢';
        log.push(`🔮 占い師 (P${seer.id}) 查驗了 P${targetId} → 結果：${resultText}`);
      }
    } else {
      // Seer must act - pick random alive player (not self)
      const candidates = alivePlayers.filter(p => p.id !== seer.id);
      if (candidates.length > 0) {
        const target = pickRandomExcluding(candidates, [])!;
        const seerResult = seerSeesAs(target.role);
        result.seerCheckTargetId = target.id;
        result.seerCheckResult = seerResult;
        gameState.seerCheckTarget = target.id;
        gameState.seerCheckResult = seerResult;
        
        if (!seer.seerChecks) seer.seerChecks = [];
        seer.seerChecks.push({
          targetId: target.id,
          result: seerResult,
          day: currentDay,
        });
        
        const resultText = seerResult === SeerResult.WEREWOLF ? '人狼 🔴' : '村人 🟢';
        log.push(`🔮 占い師 (P${seer.id}) 隨機查驗了 P${target.id} → 結果：${resultText}`);
      }
    }
  }

  // ============================================
  // 4. MEDIUM INFO (about previous day's vote)
  // Medium learns at DAWN (start of next day), not during night
  // This is handled in the day transition, but we prepare the info here
  // ============================================
  // The medium gets info about the player eliminated by vote PREVIOUS day
  // This is handled in engine.ts during phase transition

  log.push(`=== 第 ${currentDay} 夜 結束 ===`);
  
  return result;
}

/**
 * Get medium's info at dawn (about previous day's vote elimination)
 * Called at start of day phase
 */
export function getMediumInfoAtDawn(gameState: GameState): {
  playerId: number;
  role: Role;
  result: 'villager' | 'werewolf';
} | null {
  // Medium learns about the player voted out YESTERDAY (day - 1)
  // On day 1, there was no previous vote
  if (gameState.day <= 1) return null;

  // Medium must be alive to learn
  const medium = gameState.players.find(p => p.role === Role.MEDIUM && p.alive);
  if (!medium) return null;
  
  // Find the death from previous day that was by vote
  const previousDayDeaths = gameState.deathHistory.filter(
    d => d.day === gameState.day - 1 && d.cause === 'vote'
  );
  
  if (previousDayDeaths.length === 0) return null;
  
  // Should only be one vote death per day
  const death = previousDayDeaths[0];
  const player = findPlayerById(gameState.players, death.playerId);
  
  if (!player) return null;
  
  // Medium sees Werewolf as Werewolf, everything else as Villager
  const result = player.role === Role.WEREWOLF ? 'werewolf' : 'villager';
  
  return {
    playerId: death.playerId,
    role: player.role,
    result,
  };
}

/**
 * Format night result for GM log
 */
export function formatNightResult(result: NightResolutionResult): string {
  const lines = [...result.log];
  
  if (result.killBlocked) {
    lines.push('🌅 平安夜（守衛成功守護）');
  } else if (result.killedPlayerId) {
    lines.push(`🌅 今晚犧牲者：P${result.killedPlayerId}（身分不公開）`);
  } else {
    lines.push('🌅 平安夜');
  }
  
  return lines.join('\n');
}

/**
 * Format seer result for seer player only
 */
export function formatSeerResult(result: NightResolutionResult): string | null {
  if (result.seerCheckTargetId && result.seerCheckResult) {
    const resultText = result.seerCheckResult === SeerResult.WEREWOLF ? '人狼 🔴' : '村人 🟢';
    return `🔮 你的查驗結果：P${result.seerCheckTargetId} 是 ${resultText}`;
  }
  return null;
}

/**
 * Format guard result for guard player only
 */
export function formatGuardResult(result: NightResolutionResult): string | null {
  if (result.guardedPlayerId) {
    if (result.killBlocked && result.killedPlayerId === result.guardedPlayerId) {
      return `🛡️ 你守護了 P${result.guardedPlayerId}，成功阻擋了襲擊！`;
    } else {
      return `🛡️ 你守護了 P${result.guardedPlayerId}${result.killBlocked ? '（但襲擊目標是其他人）' : ''}`;
    }
  }
  return null;
}

/**
 * Format medium result for medium player only
 */
export function formatMediumResult(info: { playerId: number; result: 'villager' | 'werewolf' } | null): string | null {
  if (info) {
    const resultText = info.result === 'werewolf' ? '人狼 🔴' : '村人 🟢';
    return `👁️ 靈能者結果：昨天被票死的 P${info.playerId} 是 ${resultText}`;
  }
  return null;
}