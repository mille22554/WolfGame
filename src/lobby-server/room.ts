/**
 * room.ts — 單一房間的純記憶體狀態（多房大廳）
 *
 * 房主 = joinSeq 最小者（最早加入者）；即時計算，房主離開時自動移轉。
 */
import type { MemberInfo, ChatEntry } from './types.js';
import { CHAT_LIMIT } from './types.js';
import type { GameEngine } from './game.js';

export interface Member {
  clientId: string;
  nickname: string;
  joinSeq: number;        // monotonically increasing per room; host = smallest joinSeq
  isSpectator: boolean;   // false = player（參戰）, true = spectator（觀戰）
}

export class Room {
  readonly code: string;
  private members = new Map<string, Member>(); // clientId -> Member
  private seq = 0;
  maxPlayers: number;     // 6..15, default 15
  randomCount: boolean = false; // default false
  started: boolean = false;     // default false
  game: GameEngine | null = null; // 進行中的遊戲引擎（M5）；房間回收／解散時 destroyGame()
  lastActivity: number;   // Date.now(), updated on any member action
  private chat: ChatEntry[] = [];

  constructor(code: string, maxPlayers = 15) {
    this.code = code;
    this.maxPlayers = maxPlayers;
    this.lastActivity = Date.now();
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  addMember(clientId: string, nickname: string, isSpectator: boolean): Member {
    this.seq += 1;
    const m: Member = { clientId, nickname, joinSeq: this.seq, isSpectator };
    this.members.set(clientId, m);
    this.touch();
    return m;
  }

  removeMember(clientId: string): Member | undefined {
    const m = this.members.get(clientId);
    if (m) this.members.delete(clientId);
    this.touch();
    return m;
  }

  getMember(clientId: string): Member | undefined {
    return this.members.get(clientId);
  }

  getMemberByNickname(nickname: string): Member | undefined {
    for (const m of this.members.values()) if (m.nickname === nickname) return m;
    return undefined;
  }

  /** Host = member with the smallest joinSeq (the earliest joiner). Recomputed live, so it auto-transfers when the host leaves. */
  get host(): Member | undefined {
    let h: Member | undefined;
    for (const m of this.members.values()) if (!h || m.joinSeq < h.joinSeq) h = m;
    return h;
  }

  get playerCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (!m.isSpectator) n++;
    return n;
  }

  get totalMembers(): number {
    return this.members.size;
  }

  get isFull(): boolean {
    return this.playerCount >= this.maxPlayers;
  }

  addChat(entry: ChatEntry): void {
    this.chat.push(entry);
    if (this.chat.length > CHAT_LIMIT) this.chat.splice(0, this.chat.length - CHAT_LIMIT);
  }

  getChat(): ChatEntry[] {
    return [...this.chat];
  }

  /** Full member list sorted by joinSeq; each flagged with isHost (== current host) and isSpectator. */
  memberList(): MemberInfo[] {
    const hostId = this.host?.clientId;
    return [...this.members.values()]
      .sort((a, b) => a.joinSeq - b.joinSeq)
      .map((m) => ({ nickname: m.nickname, isHost: m.clientId === hostId, isSpectator: m.isSpectator }));
  }

  /** 參戰成員（非觀戰者），依加入順序（遊戲開局用） */
  getParticipatingMembers(): Member[] {
    return [...this.members.values()].filter((m) => !m.isSpectator);
  }

  /** 摧毀遊戲引擎（清除所有 timer）；房間回收／解散時呼叫，避免孤兒 timer 讓 process 無法結束 */
  destroyGame(): void {
    if (this.game) {
      this.game.destroy();
      this.game = null;
    }
  }
}
