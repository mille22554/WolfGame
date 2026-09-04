import { Role, Team, NightActionType, SeerResult } from './types.js';
import { getAlivePlayers, getAliveWerewolves, canGuardAct } from './assignment.js';
import { pickRandom, findPlayerById, randomInt } from './utils.js';
export function buildPublicKnowledge(gameState) {
    const alivePlayers = getAlivePlayers(gameState.players);
    const deadPlayers = gameState.players.filter(p => !p.alive);
    return { day: gameState.day, phase: gameState.phase, alivePlayers: alivePlayers.map(p => ({ ...p, role: Role.VILLAGER })), deadPlayers: deadPlayers.map(p => ({ ...p, role: Role.VILLAGER })), voteHistory: gameState.votes, discussionLog: gameState.discussionLog, publicClaims: new Map(), publicSeerResults: new Map(), publicMediumResults: new Map(), publicGuardProtects: new Map() };
}
export function buildPrivateKnowledge(player, gameState) {
    const k = { myRole: player.role, myTeam: player.team };
    if (player.role === Role.SEER && player.seerChecks)
        k.mySeerChecks = [...player.seerChecks];
    if (player.role === Role.GUARD && player.guardProtects)
        k.myGuardProtects = [...player.guardProtects];
    if (player.role === Role.MASON)
        k.masonPartnerId = player.masonPartnerId;
    if (player.role === Role.WEREWOLF)
        k.wolfAllyIds = getAliveWerewolves(gameState.players).map(w => w.id);
    return k;
}
const ACCUSATORY_KEYWORDS = ['懷疑', '可疑', '投', '票', '帶風向', '怪', '狼', '嫌疑', '出去', '壓'];
const KNIFE_NEAR_PATTERNS = [/不刀/, /刀\s*P/, /刀他/, /砍/, /挑軟/, /為何不刀/, /為什麼不刀/];
export function isAccusatoryContext(msg, idx, len) {
    const ctx = msg.slice(Math.max(0, idx - 10), Math.min(msg.length, idx + len + 10));
    for (const pat of KNIFE_NEAR_PATTERNS)
        if (pat.test(ctx))
            return false;
    for (const kw of ACCUSATORY_KEYWORDS)
        if (ctx.includes(kw))
            return true;
    if (/為什麼是|為何是|怎麼是|為什麼\s*P|為何\s*P/.test(ctx))
        return true;
    return false;
}
export function parseAccusatoryIds(msg, alivePlayers) {
    const re = /P(\d+)/g;
    const ids = [];
    let m;
    while ((m = re.exec(msg)) !== null) {
        const id = parseInt(m[1], 10);
        if (!alivePlayers.some(p => p.id === id))
            continue;
        if (ids.includes(id))
            continue;
        if (!isAccusatoryContext(msg, m.index, m[0].length))
            continue;
        ids.push(id);
    }
    return ids;
}
export function cleanTarget(id) {
    const raw = String(id).trim();
    const stripped = raw.replace(/^P+/g, '');
    const num = stripped.replace(/[^0-9]/g, '');
    return num.length === 0 ? `P${stripped}` : `P${num}`;
}
export function hasSpoken(id, messages) { return messages.some(m => m.playerId === id); }
export function hasPointedAt(accuserId, targetId, messages, _alivePlayers) {
    for (const m of messages) {
        if (m.playerId !== accuserId)
            continue;
        const msg = m.message;
        const re = new RegExp(`P${targetId}\\b`, 'g');
        let match;
        while ((match = re.exec(msg)) !== null)
            if (isAccusatoryContext(msg, match.index, match[0].length))
                return true;
    }
    return false;
}
export function hasBeenAccused(targetId, messages, _alivePlayers) {
    for (const m of messages) {
        const msg = m.message;
        const re = new RegExp(`P${targetId}\\b`, 'g');
        let match;
        while ((match = re.exec(msg)) !== null)
            if (isAccusatoryContext(msg, match.index, match[0].length))
                return true;
    }
    return false;
}
export function hasDefended(helperId, targetId, messages) {
    const defendKeywords = ['被誤會', '講的沒問題', '大家冷靜', '只是表達方式不同', '別急著錘', '邏輯自洽', '護著', '護着', '只是發言少', '沉默不等於狼', '別都衝'];
    const defendRe = /被誤會|講的沒問題|大家冷靜|只是表達方式不同|別急著錘|邏輯自洽|護著|護着|只是發言少|沉默不等於狼|別都衝/;
    for (const m of messages) {
        if (m.playerId !== helperId)
            continue;
        if (!defendRe.test(m.message))
            continue;
        const msg = m.message;
        const re = new RegExp(`P${targetId}\\b`, 'g');
        let match;
        while ((match = re.exec(msg)) !== null) {
            const ctx = msg.slice(Math.max(0, match.index - 10), Math.min(msg.length, match.index + match[0].length + 10));
            for (const kw of defendKeywords)
                if (ctx.includes(kw))
                    return true;
            if (/幫[^P]{0,6}拖時間|幫[^P]{0,6}打掩護|護著|護着|拖時間|打掩護/.test(ctx))
                if (ctx.includes('拖時間') || ctx.includes('打掩護') || ctx.includes('護著') || ctx.includes('護着') || ctx.includes('幫'))
                    return true;
        }
    }
    return false;
}
export function hasSaidNeutral(id, messages) {
    const pat = /中立|我還在看|我暫時不站邊|先觀察一下|不站邊|還在看|暫時觀望/;
    for (const m of messages)
        if (m.playerId === id && pat.test(m.message))
            return true;
    return false;
}
export function hasStatedOn(targetId, XId, messages) {
    for (const m of messages) {
        if (m.playerId !== targetId)
            continue;
        let msg = m.message.replace(/「[^」]*」/g, '');
        if (/你剛才說/.test(msg) && new RegExp(`P${XId}\\b`).test(msg)) {
            const youIdx = msg.indexOf('你剛才說');
            const pIdx = msg.indexOf(`P${XId}`);
            if (pIdx > youIdx && pIdx - youIdx < 20) {
                if (!/我投[^P]{0,6}P/.test(msg) && !/我的票/.test(msg) && !/我站邊/.test(msg)) {
                    const withoutYou = msg.replace(/你[^P]{0,15}P\d+[^。！？]*[。！？]?/g, '');
                    if (!new RegExp(`P${XId}\\b`).test(withoutYou))
                        continue;
                }
            }
        }
        if (/你投[^P]{0,6}P/.test(msg) && new RegExp(`你[^P]{0,8}投[^P]{0,6}P${XId}\\b`).test(msg)) {
            if (!/我投[^P]{0,6}P/.test(msg) && !/我的票/.test(msg)) {
                const w2 = msg.replace(/你[^P]{0,10}投[^P]{0,6}P\d+\b[^。！？]*[。！？]?/g, '');
                if (!new RegExp(`P${XId}\\b`).test(w2))
                    continue;
            }
        }
        if (getVoteTargetOf(targetId, [{ ...m, message: msg }]) === XId)
            return true;
        const pats = [new RegExp(`懷疑[^P]{0,6}P${XId}\\b`), new RegExp(`可疑[^P]{0,6}P${XId}\\b`), new RegExp(`P${XId}\\b[^P]{0,6}可疑`), new RegExp(`投[^P]{0,6}P${XId}\\b`), new RegExp(`票[^P]{0,6}P${XId}\\b`), new RegExp(`P${XId}\\b[^P]{0,8}票`), new RegExp(`把[^P]{0,6}P${XId}\\b[^P]{0,8}票`), new RegExp(`壓[^P]{0,6}P${XId}\\b`), new RegExp(`P${XId}\\b[^P]{0,8}是狼`), new RegExp(`P${XId}\\b[^P]{0,6}出去`), new RegExp(`出去[^P]{0,6}P${XId}\\b`), new RegExp(`帶風向[^P]{0,6}P${XId}\\b`), new RegExp(`P${XId}\\b[^P]{0,6}帶風向`), new RegExp(`懷疑[^P]{0,8}P${XId}\\b[^P]{0,8}是狼`), new RegExp(`比較在意[^P]{0,6}P${XId}\\b`), new RegExp(`在意[^P]{0,6}P${XId}\\b`), new RegExp(`P${XId}\\b[^P]{0,6}在意`)];
        for (const pat of pats)
            if (pat.test(msg))
                return true;
        const re = new RegExp(`P${XId}\\b`, 'g');
        let match;
        while ((match = re.exec(msg)) !== null) {
            const idx = match.index, len = match[0].length;
            const before6 = msg.slice(Math.max(0, idx - 8), idx);
            const after8 = msg.slice(idx + len, Math.min(msg.length, idx + len + 8));
            if ((before6.includes('沒對') || before6.includes('还没对')) && after8.includes('表過態'))
                continue;
            if (/沒對\s*$/.test(before6) || /還沒對\s*$/.test(before6) || /没对\s*$/.test(before6))
                if (after8.trim().startsWith('表過態') || after8.includes('表过态'))
                    continue;
            if (/^\s*你\b/.test(msg.slice(idx + len, Math.min(msg.length, idx + len + 10)))) {
                let hasDirect = false;
                for (const pat of pats)
                    if (pat.test(msg)) {
                        hasDirect = true;
                        break;
                    }
                if (!hasDirect)
                    continue;
            }
            if (isAccusatoryContext(msg, idx, len))
                return true;
        }
    }
    return false;
}
export function getVoteTargetOf(id, messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.playerId !== id)
            continue;
        const msg = m.message;
        if (/你投|你票|你剛才說|你的票|你站邊|你先把票/.test(msg))
            continue;
        if (/不站邊|還沒站邊|暫時不站邊|不投|還沒投|先不投/.test(msg))
            continue;
        const re = /P(\d+)/g;
        let match;
        let lastFound = null;
        while ((match = re.exec(msg)) !== null) {
            const pid = parseInt(match[1], 10);
            const ctx = msg.slice(Math.max(0, match.index - 16), Math.min(msg.length, match.index + match[0].length + 8));
            if (/想投|投|票|站邊|掛票/.test(ctx)) {
                if (/不刀|刀\s*P|刀他|砍|挑軟/.test(ctx))
                    continue;
                lastFound = pid;
            }
        }
        if (lastFound !== null)
            return lastFound;
        const pats = [/想投\s*[：:，, ]*\s*P(\d+)\b/, /投\s*[：:，, ]*\s*P(\d+)\b/, /票\s*[^P]{0,6}P(\d+)\b/, /站邊[^P]{0,8}P(\d+)\b/, /掛票[^P]{0,8}P(\d+)\b/];
        for (const pat of pats) {
            const mt = msg.match(pat);
            if (mt)
                return parseInt(mt[1], 10);
        }
    }
    return null;
}
export function computeReasoningContext(player, gameState) {
    const alivePlayers = getAlivePlayers(gameState.players);
    const candidates = alivePlayers.filter(p => p.id !== player.id);
    if (candidates.length === 0)
        return { suspectRanking: [], confidence: 0, keyEvidence: '無候選' };
    const todayLog = gameState.discussionLog.filter(d => d.day === gameState.day);
    const mentionCountFor = (targetId) => { let cnt = 0; const re = /P(\d+)/g; for (const entry of todayLog) {
        let m;
        const copy = new RegExp(re.source, 'g');
        while ((m = copy.exec(entry.message)) !== null) {
            if (parseInt(m[1], 10) !== targetId)
                continue;
            if (!isAccusatoryContext(entry.message, m.index, m[0].length))
                continue;
            cnt++;
        }
    } return cnt; };
    const lastMentionIdx = (targetId) => { for (let i = todayLog.length - 1; i >= 0; i--)
        if (parseAccusatoryIds(todayLog[i].message, alivePlayers).includes(targetId))
            return i; return -1; };
    const lastSpeakIdx = (targetId) => { let idx = -1; for (let i = 0; i < todayLog.length; i++)
        if (todayLog[i].playerId === targetId)
            idx = i; return idx; };
    const speakCountFor = (targetId) => { let c = 0; for (const e of todayLog)
        if (e.playerId === targetId)
            c++; return c; };
    const isWolf = player.role === Role.WEREWOLF;
    const wolfAllyIds = isWolf ? getAliveWerewolves(gameState.players).map(w => w.id).filter(id => id !== player.id) : [];
    const masonPartner = player.masonPartnerId;
    const seerWolfTargets = new Set((player.seerChecks || []).filter(c => c.result === SeerResult.WEREWOLF).map(c => c.targetId));
    const scores = new Map();
    const evidenceMap = new Map();
    for (const c of candidates) {
        let score = 10;
        const mentions = mentionCountFor(c.id);
        score += mentions * 8;
        const lm = lastMentionIdx(c.id), ls = lastSpeakIdx(c.id);
        const unresponded = lm !== -1 && lm > ls;
        if (unresponded)
            score += 15;
        const sc = speakCountFor(c.id);
        if (sc === 0)
            score += 10;
        let seerEvidence = false;
        if (seerWolfTargets.has(c.id) && alivePlayers.some(p => p.id === c.id)) {
            score += 100;
            seerEvidence = true;
        }
        if (wolfAllyIds.includes(c.id))
            score -= 50;
        if (masonPartner !== undefined && masonPartner === c.id)
            score -= 30;
        score += gameState.votes.filter(v => v.targetId === c.id).length;
        score += randomInt(0, 3);
        scores.set(c.id, score);
        let ev = '';
        if (seerEvidence) {
            const phs = [`我查驗到 P${c.id} 為狼`, `我昨晚查驗了 P${c.id}，結果是狼`, `P${c.id} 是狼，我的查驗結果不會錯`, `我查驗過 P${c.id} 了，他是狼`];
            ev = pickRandom(phs);
        }
        else if (unresponded && mentions >= 2 && sc <= 1)
            ev = `P${c.id} 被多人點名但一直沒有回應`;
        else if (unresponded && mentions >= 2)
            ev = `P${c.id} 被多人點名但回應避重就輕`;
        else if (unresponded)
            ev = `P${c.id} 被點名後沒有回應，迴避態度明顯`;
        else if (mentions >= 3)
            ev = `P${c.id} 一直是話題中心，但本人回應避重就輕`;
        else if (mentions >= 2)
            ev = `P${c.id} 被多人點名但回應不足`;
        else if (mentions >= 1)
            ev = `P${c.id} 是討論焦點之一，但說法含糊`;
        else if (sc === 0)
            ev = `P${c.id} 今天完全沉默，缺乏資訊反而可疑`;
        else
            ev = `P${c.id} 的發言與投票節奏讓我在意`;
        const recentDeath = gameState.deathHistory.length > 0 ? gameState.deathHistory[gameState.deathHistory.length - 1] : undefined;
        if (recentDeath && mentions === 0 && sc === 0)
            ev += '，且在有死者的情況下保持沉默';
        evidenceMap.set(c.id, ev);
    }
    const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
    const suspectRanking = sorted.map(([id]) => id);
    let confidence = 30;
    const topId = suspectRanking[0];
    const topScore = scores.get(topId) ?? 0;
    const secondScore = suspectRanking.length > 1 ? (scores.get(suspectRanking[1]) ?? 0) : 0;
    const gap = topScore - secondScore;
    const hasSeerWolfTop = topId !== undefined && seerWolfTargets.has(topId);
    if (hasSeerWolfTop)
        confidence = 92;
    else if (topScore >= 40 && gap >= 12)
        confidence = Math.min(90, 72 + gap);
    else if (topScore >= 30 && gap >= 7)
        confidence = Math.min(75, 55 + gap * 1.5);
    else if (todayLog.length >= 5 && topScore >= 22)
        confidence = 45 + Math.min(15, gap * 2) + randomInt(0, 5);
    else {
        confidence = 20 + Math.min(15, topScore * 0.5) + randomInt(0, 5);
        if (todayLog.length < 3)
            confidence = Math.min(confidence, 35);
    }
    confidence = Math.max(5, Math.min(95, Math.round(confidence)));
    const keyEvidence = topId !== undefined ? (evidenceMap.get(topId) ?? `在意 P${topId}`) : '資訊不足';
    return { suspectRanking, confidence, keyEvidence };
}
export class AIPlayer {
    player;
    gameState;
    constructor(player, gameState) {
        this.player = player;
        this.gameState = gameState;
    }
    buildReasoningContext() { return computeReasoningContext(this.player, this.gameState); }
    decideNightAction() {
        switch (this.player.role) {
            case Role.WEREWOLF: return this.decideWolfKill();
            case Role.SEER: return this.decideSeerCheck();
            case Role.GUARD: return this.decideGuardProtect();
            default: return null;
        }
    }
    decideWolfKill() {
        const alivePlayers = getAlivePlayers(this.gameState.players);
        const aliveWerewolves = getAliveWerewolves(this.gameState.players);
        const candidates = alivePlayers.filter(p => p.team !== Team.WEREWOLF);
        if (candidates.length === 0)
            return { type: NightActionType.WOLF_KILL, targetId: this.player.id, actorId: this.player.id };
        const existing = this.gameState.nightActions.find(a => a.type === NightActionType.WOLF_KILL && a.actorId !== this.player.id);
        if (existing)
            return { type: NightActionType.WOLF_KILL, targetId: existing.targetId, actorId: this.player.id };
        const scores = new Map();
        for (const c of candidates) {
            let s = 1;
            for (const v of this.gameState.votes) {
                if (v.voterId === c.id) {
                    const vp = findPlayerById(this.gameState.players, v.targetId);
                    if (vp && vp.role === Role.WEREWOLF)
                        s += 5;
                }
            }
            s += this.gameState.discussionLog.filter(d => d.playerId === c.id).length;
            scores.set(c.id, s);
        }
        const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
        const top = sorted.filter(([, sc]) => sc === sorted[0][1]).map(([id]) => id);
        return { type: NightActionType.WOLF_KILL, targetId: pickRandom(top), actorId: this.player.id };
    }
    decideSeerCheck() {
        const alive = getAlivePlayers(this.gameState.players).filter(p => p.id !== this.player.id);
        if (alive.length === 0)
            return { type: NightActionType.SEER_CHECK, targetId: this.player.id, actorId: this.player.id };
        const checked = this.player.seerChecks?.map(c => c.targetId) || [];
        const unchecked = alive.filter(p => !checked.includes(p.id));
        const pool = unchecked.length > 0 ? unchecked : alive;
        const target = pickRandom(pool);
        return { type: NightActionType.SEER_CHECK, targetId: target.id, actorId: this.player.id };
    }
    decideGuardProtect() {
        if (!canGuardAct(this.player, this.gameState.day))
            return null;
        const alive = getAlivePlayers(this.gameState.players);
        const candidates = alive.filter(p => p.id !== this.player.id);
        if (candidates.length === 0)
            return null;
        const claimed = new Map();
        for (const e of this.gameState.discussionLog) {
            const msg = e.message.toLowerCase();
            if (msg.includes('占い師') || msg.includes('seer') || msg.includes('查驗'))
                claimed.set(e.playerId, Role.SEER);
            else if (msg.includes('靈能者') || msg.includes('medium') || msg.includes('票死'))
                claimed.set(e.playerId, Role.MEDIUM);
            else if (msg.includes('守衛') || msg.includes('guard') || msg.includes('守護'))
                claimed.set(e.playerId, Role.GUARD);
        }
        const seers = Array.from(claimed.entries()).filter(([, r]) => r === Role.SEER).map(([id]) => id).filter(id => candidates.some(c => c.id === id));
        if (seers.length > 0)
            return { type: NightActionType.GUARD_PROTECT, targetId: pickRandom(seers), actorId: this.player.id };
        const specials = Array.from(claimed.entries()).filter(([, r]) => r === Role.MEDIUM || r === Role.GUARD).map(([id]) => id).filter(id => candidates.some(c => c.id === id));
        if (specials.length > 0)
            return { type: NightActionType.GUARD_PROTECT, targetId: pickRandom(specials), actorId: this.player.id };
        if (Math.random() < 0.3)
            return { type: NightActionType.GUARD_PROTECT, targetId: this.player.id, actorId: this.player.id };
        const t = pickRandom(candidates);
        return { type: NightActionType.GUARD_PROTECT, targetId: t.id, actorId: this.player.id };
    }
    decideVote() {
        const reasoning = this.buildReasoningContext();
        const alive = getAlivePlayers(this.gameState.players);
        const cands = alive.filter(p => p.id !== this.player.id);
        if (cands.length === 0)
            return this.player.id;
        if (reasoning.suspectRanking.length > 0) {
            const top = reasoning.suspectRanking[0];
            if (cands.some(c => c.id === top))
                return top;
        }
        switch (this.player.role) {
            case Role.WEREWOLF: return this.wolfVoteStrategy(cands);
            case Role.SEER: return this.seerVoteStrategy(cands);
            case Role.GUARD: return this.guardVoteStrategy(cands);
            case Role.MEDIUM: return this.mediumVoteStrategy(cands);
            case Role.MASON: return this.masonVoteStrategy(cands);
            case Role.MADMAN: return this.madmanVoteStrategy(cands);
            default: return this.villagerVoteStrategy(cands);
        }
    }
    getReasoningContext() { return this.buildReasoningContext(); }
    villagerVoteStrategy(cands) {
        const scores = new Map();
        for (const c of cands) {
            let s = 1;
            s += this.gameState.votes.filter(v => v.targetId === c.id).length * 2;
            s += randomInt(0, 3);
            scores.set(c.id, s);
        }
        const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
        const top = sorted.filter(([, s]) => s === sorted[0][1]).map(([id]) => id);
        return pickRandom(top);
    }
    wolfVoteStrategy(cands) {
        const allies = getAliveWerewolves(this.gameState.players).map(w => w.id).filter(id => id !== this.player.id);
        const pool = cands.filter(c => !allies.includes(c.id));
        const usePool = pool.length > 0 ? pool : cands;
        const scores = new Map();
        for (const c of usePool) {
            let s = 1;
            for (const v of this.gameState.votes) {
                if (v.voterId === c.id) {
                    const vp = findPlayerById(this.gameState.players, v.targetId);
                    if (vp && vp.role === Role.WEREWOLF)
                        s += 10;
                }
            }
            scores.set(c.id, s);
        }
        const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
        const top = sorted.filter(([, s]) => s === sorted[0][1]).map(([id]) => id);
        return pickRandom(top);
    }
    seerVoteStrategy(cands) {
        const wolves = (this.player.seerChecks || []).filter(c => c.result === SeerResult.WEREWOLF).filter(c => { const t = findPlayerById(this.gameState.players, c.targetId); return t && t.alive; });
        if (wolves.length > 0)
            return wolves[0].targetId;
        return this.villagerVoteStrategy(cands);
    }
    guardVoteStrategy(cands) { return this.villagerVoteStrategy(cands); }
    mediumVoteStrategy(cands) { return this.villagerVoteStrategy(cands); }
    masonVoteStrategy(cands) { return this.villagerVoteStrategy(cands); }
    madmanVoteStrategy(cands) { return pickRandom(cands).id; }
}
export function createAIPlayers(gameState) { return gameState.players.filter(p => p.alive && !p.isHuman).map(p => new AIPlayer(p, gameState)); }
//# sourceMappingURL=ai.js.map