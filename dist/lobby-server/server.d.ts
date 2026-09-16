import { RoomManager } from './room-manager.js';
export interface LobbyServerOptions {
    port?: number;
    host?: string;
    publicDir?: string;
    inactivityTimeoutMs?: number;
    sweepIntervalMs?: number;
    startSweep?: boolean;
}
export interface LobbyServerHandle {
    port: number;
    url: string;
    roomManager: RoomManager;
    shutdown(): Promise<void>;
}
export declare function createLobbyServer(opts?: LobbyServerOptions): Promise<LobbyServerHandle>;
//# sourceMappingURL=server.d.ts.map