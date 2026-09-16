import { CHAT_LIMIT } from './types.js';
export class Room {
    code;
    members = new Map(); // clientId -> Member
    seq = 0;
    maxPlayers; // 6..15, default 15
    randomCount = false; // default false
    started = false; // default false
    lastActivity; // Date.now(), updated on any member action
    chat = [];
    constructor(code, maxPlayers = 15) {
        this.code = code;
        this.maxPlayers = maxPlayers;
        this.lastActivity = Date.now();
    }
    touch() {
        this.lastActivity = Date.now();
    }
    addMember(clientId, nickname, isSpectator) {
        this.seq += 1;
        const m = { clientId, nickname, joinSeq: this.seq, isSpectator };
        this.members.set(clientId, m);
        this.touch();
        return m;
    }
    removeMember(clientId) {
        const m = this.members.get(clientId);
        if (m)
            this.members.delete(clientId);
        this.touch();
        return m;
    }
    getMember(clientId) {
        return this.members.get(clientId);
    }
    getMemberByNickname(nickname) {
        for (const m of this.members.values())
            if (m.nickname === nickname)
                return m;
        return undefined;
    }
    /** Host = member with the smallest joinSeq (the earliest joiner). Recomputed live, so it auto-transfers when the host leaves. */
    get host() {
        let h;
        for (const m of this.members.values())
            if (!h || m.joinSeq < h.joinSeq)
                h = m;
        return h;
    }
    get playerCount() {
        let n = 0;
        for (const m of this.members.values())
            if (!m.isSpectator)
                n++;
        return n;
    }
    get totalMembers() {
        return this.members.size;
    }
    get isFull() {
        return this.playerCount >= this.maxPlayers;
    }
    addChat(entry) {
        this.chat.push(entry);
        if (this.chat.length > CHAT_LIMIT)
            this.chat.splice(0, this.chat.length - CHAT_LIMIT);
    }
    getChat() {
        return [...this.chat];
    }
    /** Full member list sorted by joinSeq; each flagged with isHost (== current host) and isSpectator. */
    memberList() {
        const hostId = this.host?.clientId;
        return [...this.members.values()]
            .sort((a, b) => a.joinSeq - b.joinSeq)
            .map((m) => ({ nickname: m.nickname, isHost: m.clientId === hostId, isSpectator: m.isSpectator }));
    }
}
//# sourceMappingURL=room.js.map