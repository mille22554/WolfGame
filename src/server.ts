/**
 * server.ts — Phase 1 單機 Web 全 AI 後端
 *
 * HTTP 靜態（public/）+ WebSocket（ws）+ 遊戲生命週期：
 * 模型檢查/下載進度 → WorkerDispatcher → engine + SpeechScheduler + WebSocketRegistry
 * → 全 AI 自動對戰 → 關閉機制（LEAVE / 斷線零連線兜底 / SIGINT/SIGTERM）
 */

import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { GameEngine } from './engine.js';
import { SpeechScheduler } from './ai-scheduler.js';
import { WorkerDispatcher } from './worker-dispatcher.js';
import {
  createGameState, buildGMSnapshot, buildPlayerSnapshot, buildSpectatorSnapshot,
  buildLobbySnapshot,
} from './game-state.js';
import {
  DEFAULT_LLAMACPP_MODEL_URI, getDefaultModelsDir, OpenAICompatibleProvider,
} from './llm.js';
import { downloadModelFile } from './model-download.js';
import {
  LlamaServerManager, ensureLlamaServer, ensureLlamaServerPair, startLlamaServerWithFallback,
  getDefaultBinDir, readBackendPreference, writeBackendPreference, effectiveBackendPreference,
  defaultGpuLayers, defaultThreads,
  DEFAULT_LLAMA_SERVER_RELEASE, DEFAULT_LLAMA_SERVER_PORT, DEFAULT_LLAMA_SERVER_HOST,
  type BackendPreference,
} from './llama-server.js';
import { OpenAICompatibleDispatcher, MockDispatcher } from './llm-dispatcher.js';
import { getResourceRoot } from './utils.js';
import { LobbyManager } from './lobby.js';
import type {
  GameState, GameEvent, LLMDispatcher, ClientRegistry, PlayerSnapshot, SpectatorSnapshot,
  FlagStats, LobbySnapshot, ServerToClientMessage, ClientToServerMessage,
} from './types.js';

// ============================================
// 參數
// ============================================

export interface ServerLLM extends LLMDispatcher {
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ServerOptions {
  port?: number;                    // env PORT；0 = 自動（2639 起）
  playerCount?: number;             // env PLAYER_COUNT，預設 15
  publicDir?: string;               // 預設 <resourceRoot>/public
  modelsDir?: string;
  modelUri?: string;
  openBrowser?: boolean;            // 預設 true
  dispatcherFactory?: (modelPath: string) => ServerLLM;
  zeroClientShutdownMs?: number;    // env ZERO_CLIENT_SHUTDOWN_MS，預設 60000；<=0 停用自動退出（dev 用）
  pingIntervalMs?: number;          // env PING_INTERVAL_MS，預設 30000
  pingTimeoutMs?: number;           // env PING_TIMEOUT_MS，預設 10000
  gameOverReturnMs?: number;        // 遊戲結束後自動回大廳延遲，預設 10000（測試可調小）
  exitProcess?: boolean;            // 預設 true；測試設 false
  onShutdown?: (reason: string) => void;
  llamaServerPort?: number;        // env LLAMA_SERVER_PORT，預設 3001
  llamaServerHost?: string;        // env LLAMA_SERVER_HOST，預設 127.0.0.1
  llamaServerCtxSize?: number;     // env LLAMA_SERVER_CTX_SIZE，預設 8192
  llamaServerThreads?: number;     // env LLAMA_SERVER_THREADS，預設 defaultThreads()（實體核啟發式）
  llamaServerParallel?: number;    // env LLAMA_SERVER_PARALLEL，預設 1
  llamaServerIdleTimeout?: number; // 已棄用，無作用（b10361 不支援 --idle-timeout，保留相容）
  llamaServerRelease?: string;     // env LLAMA_SERVER_RELEASE，預設 'b10361'
  llamaServerBinDir?: string;      // env LLAMA_SERVER_BIN_DIR，預設 getDefaultBinDir()
  llamaServerBinPath?: string;     // 測試 hook：直接指定 exe 路徑（跳過下載）
  backend?: BackendPreference;     // 測試 hook：手動後端覆寫（最高優先；預設讀持久化＋env）
  llamaGpuLayers?: number;         // env LLAMA_GPU_LAYERS；省略＝ defaultGpuLayers() 保守分級
}

export interface ServerHandle {
  port: number;
  url: string;
  shutdown(reason: string): Promise<void>;
  closed: Promise<string>;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v !== '0' && v.toLowerCase() !== 'false' && v !== '';
}

export type ProviderMode = 'llama-server' | 'llamacpp' | 'mock' | 'openai';

export function resolveProviderMode(): ProviderMode {
  const v = process.env.LLM_PROVIDER;
  if (v === 'mock') return 'mock';
  if (v === 'llamacpp') return 'llamacpp';
  if (v === 'openai') return 'openai';
  return 'llama-server'; // 預設（含未設定）
}

// ============================================
// 模型檢查
// ============================================

/** 'hf:Qwen/Qwen3-4B-GGUF:Qwen3-4B-Q4_K_M.gguf' → 'Qwen3-4B-Q4_K_M.gguf' */
export function modelFileName(modelUri: string): string {
  const idx = modelUri.lastIndexOf(':');
  return idx >= 0 ? modelUri.slice(idx + 1) : modelUri;
}

export function isModelDownloaded(modelUri: string, modelsDir: string): boolean {
  try {
    if (fs.existsSync(path.join(modelsDir, modelFileName(modelUri)))) return true;
    // spike 驗證：node-llama-cpp resolveModelFile 實際檔名為 hf_ 前綴形式
    // （如 hf_Qwen_Qwen3-4B.QWEN3-4B-Q4_K_M.GGUF.gguf），故退回檢查任意 .gguf
    const entries = fs.readdirSync(modelsDir);
    return entries.some((e) => e.toLowerCase().endsWith('.gguf'));
  } catch {
    return false;
  }
}

/**
 * 解析實際模型檔路徑。
 * 精確檔名存在 → 直接使用；否則退回掃描 modelsDir 找第一個 .gguf
 * （node-llama-cpp 下載後實際檔名為 hf_ 前綴形式）。
 */
export function resolveModelPath(modelUri: string, modelsDir: string): string {
  const exact = path.join(modelsDir, modelFileName(modelUri));
  if (fs.existsSync(exact)) return exact;
  try {
    const found = fs.readdirSync(modelsDir).find((e) => e.toLowerCase().endsWith('.gguf'));
    if (found) return path.join(modelsDir, found);
  } catch { /* fallthrough */ }
  return exact;
}

export interface ModelInfo {
  name: string;
  sizeMB: number;
}

/** 掃描 modelsDir 下的 .gguf 檔案（回傳 name + sizeMB，name 排序） */
export function listGgufModels(modelsDir: string): ModelInfo[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(modelsDir);
  } catch {
    return [];
  }
  const ggufs = entries.filter((e) => e.toLowerCase().endsWith('.gguf')).sort();
  const out: ModelInfo[] = [];
  for (const name of ggufs) {
    try {
      const bytes = fs.statSync(path.join(modelsDir, name)).size;
      out.push({ name, sizeMB: Number((bytes / 1048576).toFixed(1)) });
    } catch { /* 忽略無法 stat 的檔案 */ }
  }
  return out;
}

/** 選定模型：檔名含 Qwen3-4B 優先，否則第一個；無模型 → null */
export function pickPreferredModel(names: string[]): string | null {
  if (names.length === 0) return null;
  const hit = names.find((n) => n.includes('Qwen3-4B'));
  return hit ?? names[0];
}

// ============================================
// 靜態檔案伺服
// ============================================

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  publicDir: string,
  _modelReady?: boolean,
): void {
  if (req.method !== 'GET') {
    res.writeHead(404).end('Not found');
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (pathname === '/') {
    pathname = '/menu.html';
  }
  const resolved = path.resolve(publicDir, `.${pathname}`);
  if (!resolved.startsWith(path.resolve(publicDir) + path.sep) && resolved !== path.resolve(publicDir)) {
    res.writeHead(404).end('Not found');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      // menu.html 尚不存在（@designer 處理中）時退回 index.html，保持根路徑可用
      if (pathname === '/menu.html') {
        const fallback = path.resolve(publicDir, './index.html');
        fs.readFile(fallback, (err2, data2) => {
          if (err2) {
            res.writeHead(404).end('Not found');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(data2);
        });
        return;
      }
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] ?? 'application/octet-stream' });
    res.end(data);
  });
}

// ============================================
// 自動找 port
// ============================================

export async function findAvailablePort(start: number): Promise<number> {
  for (let p = start; p < start + 10; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(p, () => {
        srv.close(() => resolve(true));
      });
    });
    if (ok) return p;
  }
  throw new Error(`找不到可用 port（${start} 起 10 個皆被佔用）`);
}

// ============================================
// 開瀏覽器（Windows）
// ============================================

export function openBrowser(url: string): void {
  exec(`start "" "${url}"`, (err) => {
    if (err) console.log(`請手動開啟瀏覽器：${url}`);
  });
}

// ============================================
// WebSocketRegistry（實作 ClientRegistry）
// ============================================

/** Phase 2：registry → engine/大廳的操作回呼（startServer 注入；大廳先於引擎存在） */
export interface RegistryActions {
  join(clientId: string, playerId: number, name?: string, prevToken?: string): { accepted: boolean; reason?: string; token?: string };
  reconnect(clientId: string, token: string): { accepted: boolean; reason?: string; playerId?: number; token?: string; spectator?: boolean; name?: string };
  spectate(clientId: string, playerId: number, token?: string): { accepted: boolean; reason?: string };
  leaveLobby(clientId: string, playerId: number | undefined, token?: string): { accepted: boolean; reason?: string };
  setName(clientId: string, playerId: number | undefined, token: string | undefined, name: string): { accepted: boolean; reason?: string; name?: string; token?: string };
  setPlayerCount(clientId: string, count: number): { accepted: boolean; reason?: string };
  setRandomCount(clientId: string, enabled: boolean): { accepted: boolean; reason?: string };
  chat(clientId: string, playerId: number | undefined, text: string, token?: string): { accepted: boolean; reason?: string };
  startLobbyGame(clientId: string): { accepted: boolean; reason?: string };
  humanEvent(event: GameEvent): { accepted: boolean; reason?: string };
  disconnectPlayer(playerId: number): void;
  isStarted(): boolean;
}

export interface WebSocketRegistryOptions {
  getState: () => GameState;
  zeroClientShutdownMs?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  onZeroClientsTimeout?: () => void;
  onLastClientLeave?: () => void;
  actions?: RegistryActions;   // Phase 2：未提供時為純觀戰模式（Phase 1 相容）
  ensureReady?: () => Promise<boolean>;  // WS 連線時確保 engine/llama-server 就緒；false → 回 ERROR
  getLobbySnapshot?: () => LobbySnapshot;  // 等候大廳：engine 未就緒/SETUP 時的快照來源
  onLobbySignal?: (clientId: string) => void;  // 首個遊戲頁訊號：決定 host＋啟動自動開局 timer
  onClientLeave?: (clientId: string, playerId?: number) => void;
  getFlagStats?: () => FlagStats;  // GM 除錯：每輪 AI 決策 flag 統計來源（scheduler 閉包注入）
}

interface TrackedClient {
  ws: WebSocket;
  clientId: string;    // 等候大廳：連線身分（host/觀戰者追蹤用，registry 指派 c1、c2…）
  gmView: boolean;
  lastPong: number;
  playerId?: number;   // Phase 2：真人座位（JOIN/RECONNECT 後設定）
  token?: string;
  takeoverFiltered?: boolean;  // 掛機接管：接管當下已連線的舊 WS；真人→server 遊戲訊息忽略（RECONNECT 除外）
}

/**
 * 接管過濾判定（純函式，單向：只擋真人→server 的遊戲操作；server→真人推送不受影響）。
 * 只套用接管時已連線的舊 WS（takeoverFiltered）；重整後新 WS 走正常流程。
 */
export function isTakeoverFiltered(client: { takeoverFiltered?: boolean }, msgType: string): boolean {
  if (!client.takeoverFiltered) return false;
  return msgType === 'HUMAN_SPEAK' || msgType === 'HUMAN_SKIP'
    || msgType === 'HUMAN_READY_VOTE' || msgType === 'HUMAN_UNREADY_VOTE'
    || msgType === 'HUMAN_VOTE' || msgType === 'HUMAN_NIGHT_ACTION'
    || msgType === 'HUMAN_WOLF_SPEAK' || msgType === 'HUMAN_WOLF_READY'
    || msgType === 'HUMAN_WOLF_UNREADY';
}

export class WebSocketRegistry implements ClientRegistry {
  private readonly opts: Required<Omit<WebSocketRegistryOptions, 'onZeroClientsTimeout' | 'onLastClientLeave' | 'actions' | 'ensureReady' | 'getLobbySnapshot' | 'onLobbySignal' | 'onClientLeave' | 'getFlagStats'>>
    & Pick<WebSocketRegistryOptions, 'onZeroClientsTimeout' | 'onLastClientLeave' | 'actions' | 'ensureReady' | 'getLobbySnapshot' | 'onLobbySignal' | 'onClientLeave' | 'getFlagStats'>;
  private readonly clients = new Set<TrackedClient>();
  private clientSeq = 0;
  private zeroTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(wss: WebSocketServer, opts: WebSocketRegistryOptions) {
    this.opts = {
      getState: opts.getState,
      zeroClientShutdownMs: opts.zeroClientShutdownMs ?? envInt('ZERO_CLIENT_SHUTDOWN_MS', 60000),
      pingIntervalMs: opts.pingIntervalMs ?? envInt('PING_INTERVAL_MS', 30000),
      pingTimeoutMs: opts.pingTimeoutMs ?? envInt('PING_TIMEOUT_MS', 10000),
      onZeroClientsTimeout: opts.onZeroClientsTimeout,
      onLastClientLeave: opts.onLastClientLeave,
      actions: opts.actions,
      ensureReady: opts.ensureReady,
      getLobbySnapshot: opts.getLobbySnapshot,
      onLobbySignal: opts.onLobbySignal,
      onClientLeave: opts.onClientLeave,
      getFlagStats: opts.getFlagStats,
    };
    wss.on('connection', (ws) => void this.onConnection(ws));
    this.pingTimer = setInterval(() => this.pingCheck(), this.opts.pingIntervalMs);
    const t = this.pingTimer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  // --- ClientRegistry ---
  getConnectedPlayerIds(): number[] {
    return [...this.clients]
      .filter((c) => c.playerId !== undefined)
      .map((c) => c.playerId!);
  }

  send(playerId: number, snapshot: PlayerSnapshot): void {
    for (const c of this.clients) {
      if (c.playerId !== playerId) continue;
      const msg: ServerToClientMessage = { type: 'SNAPSHOT', snapshot, gmView: false };
      try {
        c.ws.send(JSON.stringify(msg));
      } catch { /* 單一客戶端失敗不影響其他人 */ }
    }
  }

  sendSpectator(snapshot: SpectatorSnapshot): void {
    for (const c of this.clients) {
      if (c.playerId !== undefined) continue;   // Phase 2：只送給觀戰者（未選座）
      const msg: ServerToClientMessage = c.gmView
        ? { type: 'SNAPSHOT', snapshot: buildGMSnapshot(this.opts.getState(), this.opts.getFlagStats?.()), gmView: true }
        : { type: 'SNAPSHOT', snapshot, gmView: false };
      try {
        c.ws.send(JSON.stringify(msg));
      } catch { /* 單一客戶端失敗不影響其他人 */ }
    }
  }

  sendLobby(lobby: LobbySnapshot): void {
    // per-client 信封附 clientId：前端 host 比對＋「我的觀眾席」定位用；快照本體全員一致
    for (const c of this.clients) {
      const msg: ServerToClientMessage = { type: 'LOBBY', lobby, clientId: c.clientId };
      try {
        c.ws.send(JSON.stringify(msg));
      } catch { /* 單一客戶端失敗不影響其他人 */ }
    }
  }

  hasSpectators(): boolean {
    return [...this.clients].some((c) => c.playerId === undefined);
  }

  /** 測試用：目前連線數 */
  clientCount(): number {
    return this.clients.size;
  }

  /**
   * 掛機接管通知：只推被接管者本人；同時標記其當下已連線的舊 WS 為接管過濾
   *（拿回成功後過濾解除；重整後新 WS 不受影響）。
   */
  notifyTakeover(playerId: number, reason: string): void {
    const msg: ServerToClientMessage = { type: 'IDLE_TAKEOVER', playerId, reason };
    for (const c of this.clients) {
      if (c.playerId !== playerId) continue;
      c.takeoverFiltered = true;
      try {
        c.ws.send(JSON.stringify(msg));
      } catch { /* 單一客戶端失敗不影響其他人 */ }
    }
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.zeroTimer) clearTimeout(this.zeroTimer);
    this.zeroTimer = null;
  }

  /** 關閉所有連線（shutdown 時） */
  closeAll(): void {
    const msg: ServerToClientMessage = { type: 'SHUTDOWN' };
    for (const c of this.clients) {
      try {
        c.ws.send(JSON.stringify(msg));
      } catch { /* ignore */ }
      try {
        c.ws.close(1000, 'server shutdown');
      } catch { /* ignore */ }
    }
    this.clients.clear();
  }

  private pushSnapshot(c: TrackedClient): void {
    let msg: ServerToClientMessage;
    try {
      const state = this.opts.getState();
      if (state.phase === 'SETUP_WAITING_JOIN' || state.phase === 'SETUP_READY') {
        // 大廳階段一律送大廳快照（等候大廳先於引擎存在）
        const lobby = this.opts.getLobbySnapshot?.();
        if (!lobby) return;
        msg = { type: 'LOBBY', lobby, clientId: c.clientId };
      } else if (c.gmView) {
        msg = { type: 'SNAPSHOT', snapshot: buildGMSnapshot(state, this.opts.getFlagStats?.()), gmView: true };
      } else if (c.playerId !== undefined) {
        msg = { type: 'SNAPSHOT', snapshot: buildPlayerSnapshot(state, c.playerId), gmView: false };
      } else {
        msg = { type: 'SNAPSHOT', snapshot: buildSpectatorSnapshot(state), gmView: false };
      }
    } catch {
      // engine 尚未就緒 → 大廳快照（等候大廳先於引擎存在）；無提供者則略過
      const lobby = this.opts.getLobbySnapshot?.();
      if (!lobby) return;
      msg = { type: 'LOBBY', lobby, clientId: c.clientId };
    }
    try {
      c.ws.send(JSON.stringify(msg));
    } catch { /* ignore */ }
  }

  // 注意：連線時不觸發 ensureReady（模型管理頁也會連 WS 監聽 MODEL_STATUS，
  // 若連線即啟動會被誤觸發）。等候大廳先於引擎存在：連線當下即推送大廳快照；
  // REQUEST_SNAPSHOT 在背景觸發引擎啟動（不等待），START_GAME 才同步等待引擎。
  private onConnection(ws: WebSocket): void {
    const client: TrackedClient = { ws, clientId: `c${++this.clientSeq}`, gmView: false, lastPong: Date.now() };
    this.clients.add(client);
    if (this.zeroTimer) {
      clearTimeout(this.zeroTimer);
      this.zeroTimer = null;
    }
    this.pushSnapshot(client);
    ws.on('message', (data) => this.onClientMessage(client, data));
    ws.on('close', () => this.onDisconnect(client));
    ws.on('error', () => { /* close 事件會接著處理 */ });
  }

  private onClientMessage(client: TrackedClient, data: unknown): void {
    void this.handleClientMessage(client, data);
  }

  private async handleClientMessage(client: TrackedClient, data: unknown): Promise<void> {
    let msg: ClientToServerMessage;
    try {
      msg = JSON.parse(String(data)) as ClientToServerMessage;
    } catch {
      return;
    }
    const send = (m: ServerToClientMessage): void => {
      try {
        client.ws.send(JSON.stringify(m));
      } catch { /* ignore */ }
    };
    // 大廳訊號：首個遊戲頁訊息決定 host＋啟動自動開局 timer。
    // 純 WS 連線（模型管理／下載頁只監聽 MODEL_STATUS 不發訊）不觸發。
    if (msg.type === 'REQUEST_SNAPSHOT' || msg.type === 'RECONNECT' || msg.type === 'JOIN'
      || msg.type === 'SPECTATE' || msg.type === 'SET_NAME' || msg.type === 'SET_PLAYER_COUNT' || msg.type === 'SET_RANDOM_COUNT'
      || msg.type === 'CHAT_SEND' || msg.type === 'START_GAME' || msg.type === 'SET_GM_VIEW') {
      this.opts.onLobbySignal?.(client.clientId);
    }
    // 等候大廳優先：快照請求立即回大廳快照，引擎在背景啟動（不等待、不阻塞）
    if (msg.type === 'REQUEST_SNAPSHOT') {
      if (this.opts.ensureReady) {
        let needEnsure = false;
        try {
          this.opts.getState();
        } catch {
          needEnsure = true;
        }
        if (needEnsure) {
          void this.opts.ensureReady().then((ok) => {
            if (!ok) send({ type: 'ERROR', message: '模型未就緒' });
          });
        }
      }
      this.pushSnapshot(client);
      return;
    }
    // 延遲初始化重試：先前因模型未就緒而連線的 client，下載完成後無需重連，
    // 任意遊戲訊息（除 PONG/LEAVE/大廳訊息）都可觸發 ensure，成功後繼續處理本次訊息。
    // 大廳訊息（JOIN/SPECTATE/人數/隨機/聊天/GM 檢視）不觸發引擎：等候大廳先於引擎存在。
    const lobbyOnly = msg.type === 'JOIN' || msg.type === 'SPECTATE' || msg.type === 'SET_NAME'
      || msg.type === 'SET_PLAYER_COUNT' || msg.type === 'SET_RANDOM_COUNT'
      || msg.type === 'CHAT_SEND' || msg.type === 'SET_GM_VIEW' || msg.type === 'LEAVE_LOBBY';
    if (this.opts.ensureReady && msg.type !== 'PONG' && msg.type !== 'LEAVE' && !lobbyOnly) {
      let needEnsure = false;
      try {
        this.opts.getState();
      } catch {
        needEnsure = true;
      }
      if (needEnsure) {
        let ok = false;
        try {
          ok = await this.opts.ensureReady();
        } catch {
          ok = false;
        }
        if (!ok) {
          send({ type: 'ERROR', message: '模型未就緒' });
          return;
        }
      }
    }
    switch (msg.type) {
      case 'PONG':
        client.lastPong = Date.now();
        break;
      case 'SET_GM_VIEW':
        client.gmView = msg.enabled;
        this.pushSnapshot(client);
        break;
      case 'JOIN': {
        const actions = this.opts.actions;
        if (!actions) return;
        if (actions.isStarted()) {
          send({ type: 'JOIN_REJECTED', reason: 'game started' });
          break;
        }
        if (typeof msg.playerId !== 'number') {
          send({ type: 'JOIN_REJECTED', reason: 'bad seat' });
          break;
        }
        const r = actions.join(client.clientId, msg.playerId, msg.name, client.token);
        if (!r.accepted || r.token === undefined) {
          send({ type: 'JOIN_REJECTED', reason: r.reason ?? 'join failed' });
          break;
        }
        client.playerId = msg.playerId;
        client.token = r.token;
        client.takeoverFiltered = false;   // 新座位不繼承舊過濾
        send({ type: 'JOINED', playerId: msg.playerId, token: r.token, clientId: client.clientId });
        break;
      }
      case 'RECONNECT': {
        const actions = this.opts.actions;
        if (!actions) return;
        if (typeof msg.token !== 'string') {
          send({ type: 'JOIN_REJECTED', reason: 'bad token' });
          break;
        }
        const r = actions.reconnect(client.clientId, msg.token);
        if (!r.accepted) {
          send({ type: 'JOIN_REJECTED', reason: r.reason ?? 'unknown token' });
          break;
        }
        if (r.playerId !== undefined && r.token !== undefined) {
          client.playerId = r.playerId;
          client.token = r.token;
          client.takeoverFiltered = false;   // 拿回成功後過濾解除（含死亡轉觀戰）
          send({ type: 'JOINED', playerId: r.playerId, token: r.token, clientId: client.clientId });
          break;
        }
        // 大廳觀眾重連：同 token 拿回原編號＋原名（無座位，故回 NAME_SET）
        if (r.spectator && r.token !== undefined) {
          client.playerId = undefined;
          client.token = r.token;
          send({ type: 'NAME_SET', name: r.name ?? '', token: r.token, clientId: client.clientId });
          break;
        }
        send({ type: 'JOIN_REJECTED', reason: r.reason ?? 'unknown token' });
        break;
      }
      case 'SET_NAME': {
        const actions = this.opts.actions;
        if (!actions) return;
        if (actions.isStarted()) {
          send({ type: 'ACTION_REJECTED', reason: 'game started' });
          break;
        }
        if (typeof msg.name !== 'string') {
          send({ type: 'ACTION_REJECTED', reason: 'bad name' });
          break;
        }
        const token = client.token ?? msg.token;
        const r = actions.setName(client.clientId, client.playerId, token, msg.name);
        if (!r.accepted || r.token === undefined || r.name === undefined) {
          send({ type: 'ACTION_REJECTED', reason: r.reason ?? 'rename failed' });
          break;
        }
        client.token = r.token;
        send({ type: 'NAME_SET', name: r.name, token: r.token, clientId: client.clientId });
        break;
      }
      case 'START_GAME': {
        const actions = this.opts.actions;
        if (!actions) return;
        const r = actions.startLobbyGame(client.clientId);
        if (!r.accepted) send({ type: 'ACTION_REJECTED', reason: r.reason ?? 'rejected' });
        break;
      }
      case 'SPECTATE': {
        const actions = this.opts.actions;
        if (!actions || client.playerId === undefined) return;
        const r = actions.spectate(client.clientId, client.playerId, client.token);
        if (!r.accepted) {
          send({ type: 'ACTION_REJECTED', reason: r.reason ?? 'rejected' });
          break;
        }
        client.playerId = undefined;
        break;
      }
      case 'LEAVE_LOBBY': {
        // 大廳乾淨離開（返回主選單用）：顯式釋放座位＋觀眾身份，即時廣播；遊戲中拒絕（保持斷線接管語義）
        const actions = this.opts.actions;
        if (!actions) return;
        const r = actions.leaveLobby(client.clientId, client.playerId, client.token);
        if (!r.accepted) {
          send({ type: 'ACTION_REJECTED', reason: r.reason ?? 'rejected' });
          break;
        }
        client.playerId = undefined;
        client.token = undefined; // 座位 token 已作廢，避免後續 RECONNECT 拿回
        send({ type: 'LEFT_LOBBY' });
        break;
      }
      case 'SET_PLAYER_COUNT': {
        const actions = this.opts.actions;
        if (!actions) return;
        if (typeof msg.count !== 'number') {
          send({ type: 'ACTION_REJECTED', reason: 'bad count' });
          break;
        }
        const r = actions.setPlayerCount(client.clientId, msg.count);
        if (!r.accepted) send({ type: 'ACTION_REJECTED', reason: r.reason ?? 'rejected' });
        break;
      }
      case 'SET_RANDOM_COUNT': {
        const actions = this.opts.actions;
        if (!actions) return;
        if (typeof msg.enabled !== 'boolean') {
          send({ type: 'ACTION_REJECTED', reason: 'bad flag' });
          break;
        }
        const r = actions.setRandomCount(client.clientId, msg.enabled);
        if (!r.accepted) send({ type: 'ACTION_REJECTED', reason: r.reason ?? 'rejected' });
        break;
      }
      case 'CHAT_SEND': {
        const actions = this.opts.actions;
        if (!actions) return;
        if (typeof msg.text !== 'string') return;
        const r = actions.chat(client.clientId, client.playerId, msg.text, client.token);
        if (!r.accepted) send({ type: 'ACTION_REJECTED', reason: r.reason ?? 'rejected' });
        break;
      }
      case 'HUMAN_SPEAK':
      case 'HUMAN_SKIP':
      case 'HUMAN_READY_VOTE':
      case 'HUMAN_UNREADY_VOTE':
      case 'HUMAN_VOTE':
      case 'HUMAN_NIGHT_ACTION':
      case 'HUMAN_WOLF_SPEAK':
      case 'HUMAN_WOLF_READY':
      case 'HUMAN_WOLF_UNREADY': {
        // 掛機接管中：舊 WS 的遊戲操作一律忽略（只收 RECONNECT；推送不受影響）
        if (isTakeoverFiltered(client, msg.type)) return;
        const actions = this.opts.actions;
        if (!actions || client.playerId === undefined) return;
        const pid = client.playerId;
        let event: GameEvent;
        switch (msg.type) {
          case 'HUMAN_SPEAK': event = { type: 'HUMAN_SPEAK', playerId: pid, text: msg.text }; break;
          case 'HUMAN_SKIP': event = { type: 'HUMAN_SKIP', playerId: pid }; break;
          case 'HUMAN_READY_VOTE': event = { type: 'HUMAN_READY_VOTE', playerId: pid }; break;
          case 'HUMAN_UNREADY_VOTE': event = { type: 'HUMAN_UNREADY_VOTE', playerId: pid }; break;
          case 'HUMAN_VOTE': event = { type: 'HUMAN_VOTE', playerId: pid, targetId: msg.targetId }; break;
          case 'HUMAN_NIGHT_ACTION': event = { type: 'HUMAN_NIGHT_ACTION', playerId: pid, targetId: msg.targetId }; break;
          case 'HUMAN_WOLF_SPEAK': event = { type: 'HUMAN_WOLF_SPEAK', playerId: pid, text: msg.text }; break;
          case 'HUMAN_WOLF_READY': event = { type: 'HUMAN_WOLF_READY', playerId: pid }; break;
          case 'HUMAN_WOLF_UNREADY': event = { type: 'HUMAN_WOLF_UNREADY', playerId: pid }; break;
        }
        const r = actions.humanEvent(event!);
        if (!r.accepted) send({ type: 'ACTION_REJECTED', reason: r.reason ?? 'rejected' });
        break;
      }
      case 'LEAVE': {
        const isLast = this.clients.size === 1 && this.clients.has(client);
        try {
          client.ws.close(1000, 'leave');
        } catch { /* ignore */ }
        if (isLast) this.opts.onLastClientLeave?.();
        break;
      }
    }
  }

  private onDisconnect(client: TrackedClient): void {
    this.clients.delete(client);
    // 遊戲中斷線 → engine AI 接管；大廳斷線 → server hook（座位保留＋AI 託管＋host 遞補）
    const actions = this.opts.actions;
    if (actions && client.playerId !== undefined && actions.isStarted()) {
      try {
        actions.disconnectPlayer(client.playerId);
      } catch { /* ignore */ }
    }
    this.opts.onClientLeave?.(client.clientId, client.playerId);
    this.armZeroTimerIfEmpty();
  }

  /**
   * 零連線關閉計時器：無 client 且尚未 armed 時啟動。
   * - 啟動時呼叫一次（主選單不開 WS 也能兜底：60 秒無連線 → no-clients 關閉 exe）。
   * - 逃生口：`zeroClientShutdownMs <= 0`（`ZERO_CLIENT_SHUTDOWN_MS=0`）時永不 armed，供 dev 使用。
   */
  armZeroTimerIfEmpty(): void {
    if (this.opts.zeroClientShutdownMs <= 0) return;
    if (this.clients.size === 0 && !this.zeroTimer) {
      this.zeroTimer = setTimeout(() => {
        this.zeroTimer = null;
        this.opts.onZeroClientsTimeout?.();
      }, this.opts.zeroClientShutdownMs);
      const t = this.zeroTimer as unknown as { unref?: () => void };
      if (typeof t.unref === 'function') t.unref();
    }
  }

  private pingCheck(): void {
    const now = Date.now();
    const ping: ServerToClientMessage = { type: 'PING' };
    for (const c of [...this.clients]) {
      // 先發 PING，讓客戶端有時間回覆 PONG
      try {
        c.ws.send(JSON.stringify(ping));
      } catch { /* ignore */ }
      // 再檢查上一次 PONG 是否超過 interval + timeout
      if (now - c.lastPong > this.opts.pingIntervalMs + this.opts.pingTimeoutMs) {
        try {
          c.ws.terminate();
        } catch { /* ignore */ }
      }
    }
  }
}

// ============================================
// startServer
// ============================================

export async function startServer(options: ServerOptions = {}): Promise<ServerHandle> {
  const portOpt = options.port ?? envInt('PORT', 0);
  const playerCount = options.playerCount ?? envInt('PLAYER_COUNT', 15);
  if (!Number.isInteger(playerCount) || playerCount < 6 || playerCount > 15) {
    throw new Error(`玩家人數必須是 6-15，輸入為：${playerCount}`);
  }

  // ---- 等候大廳（先於引擎存在；server 側唯一資料源） ----
  const lobby = new LobbyManager(playerCount);
  const lobbyClients = new Set<string>();
  const lobbySeatByClient = new Map<string, number>(); // clientId → 座位（host 轉移參戰者優先用；離場/轉觀戰即刪）

  /** host 轉移（共用）：離場者是 host 時轉給仍在場者——參戰者優先，同類則最長在場（lobbyClients 插入序）優先；無人則清除，後續首個發訊號者經 onLobbySignal 接任 */
  function transferHostIfLeaver(leaverId: string): void {
    if (!lobby.clearHostIf(leaverId)) return;
    let fallback: string | undefined;
    for (const cid of lobbyClients) {
      fallback ??= cid;
      if (lobbySeatByClient.has(cid)) {
        lobby.setHost(cid);
        return;
      }
    }
    if (fallback !== undefined) lobby.setHost(fallback);
  }
  const publicDir = options.publicDir ?? path.join(getResourceRoot(), 'public');
  const modelsDir = options.modelsDir ?? process.env.LLM_MODELS_DIR ?? getDefaultModelsDir();
  const modelUri = options.modelUri ?? process.env.LLM_MODEL_URI ?? DEFAULT_LLAMACPP_MODEL_URI;
  const shouldOpenBrowser = options.openBrowser ?? envBool('OPEN_BROWSER', true);
  const exitProcess = options.exitProcess ?? true;
  const mode = resolveProviderMode();
  const isMock = mode === 'mock';
  const llamaServerHost = options.llamaServerHost ?? process.env.LLAMA_SERVER_HOST ?? DEFAULT_LLAMA_SERVER_HOST;
  const llamaServerPort = options.llamaServerPort ?? envInt('LLAMA_SERVER_PORT', DEFAULT_LLAMA_SERVER_PORT);

  // ---- 啟動時模型掃描（不自動下載；mock/openai 免檢查）----
  let modelReady: boolean;
  let selectedModel: string | null;
  let modelPath: string;
  let downloading = false;
  if (isMock) {
    modelReady = true;
    selectedModel = 'mock';
    modelPath = 'mock';
  } else if (mode === 'openai') {
    modelReady = true;
    selectedModel = null;
    modelPath = 'openai';
  } else {
    const found = listGgufModels(modelsDir);
    if (found.length > 0) {
      modelReady = true;
      const pick = pickPreferredModel(found.map((f) => f.name))!;
      selectedModel = pick;
      modelPath = path.join(modelsDir, pick);
    } else {
      modelReady = false;
      selectedModel = null;
      modelPath = resolveModelPath(modelUri, modelsDir);
    }
  }

  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res);
  });
  const wss = new WebSocketServer({ server: httpServer });

  const broadcast = (msg: ServerToClientMessage): void => {
    // MODEL_STATUS 同步寫入大廳 engineStatus（LOBBY 內嵌初始值用；即時更新仍走廣播）
    if (msg.type === 'MODEL_STATUS') {
      lobby.setEngineStatus({ state: msg.state, stage: msg.stage, downloaded: msg.downloaded, total: msg.total, info: msg.info, error: msg.error });
    }
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(JSON.stringify(msg));
        } catch { /* ignore */ }
      }
    }
  };

  function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let data = '';
      req.on('data', (c) => { data += String(c); });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      } catch {
        res.writeHead(400).end('Bad request');
        return;
      }
      if (req.method === 'GET' && pathname === '/api/status') {
        sendJson(res, 200, {
          modelReady, selectedModel, models: listGgufModels(modelsDir),
          backend: effectiveBackendPreference({
            option: options.backend, stored: readBackendPreference(), env: process.env,
          }),
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/backend') {
        const stored = readBackendPreference();
        sendJson(res, 200, {
          backend: stored,
          effective: effectiveBackendPreference({ option: options.backend, stored, env: process.env }),
        });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/backend') {
        let body = '';
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 400, { error: 'bad body' });
          return;
        }
        let backend: unknown;
        try {
          backend = (JSON.parse(body || '{}') as { backend?: unknown }).backend;
        } catch {
          sendJson(res, 400, { error: 'invalid json' });
          return;
        }
        if (backend !== 'auto' && backend !== 'cpu' && backend !== 'gpu') {
          sendJson(res, 400, { error: 'bad backend (want auto|cpu|gpu)' });
          return;
        }
        try {
          writeBackendPreference(backend);
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          backend,
          // 只寫檔不熱切換：下次引擎啟動才生效；本局進行中不受影響
          note: engine
            ? '已儲存，將於下次啟動引擎時生效（本局不受影響）'
            : '已儲存，將於下次啟動引擎時生效',
        });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/model/select') {
        let body = '';
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 400, { error: 'bad body' });
          return;
        }
        let name: unknown;
        try {
          name = (JSON.parse(body || '{}') as { name?: unknown }).name;
        } catch {
          sendJson(res, 400, { error: 'invalid json' });
          return;
        }
        if (typeof name !== 'string' || name.length === 0) {
          sendJson(res, 400, { error: 'missing name' });
          return;
        }
        if (name.includes('/') || name.includes('\\') || name.includes('..')) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        if (!name.toLowerCase().endsWith('.gguf')) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        const target = path.join(modelsDir, name);
        try {
          const st = fs.statSync(target);
          if (!st.isFile()) {
            sendJson(res, 404, { error: 'not found' });
            return;
          }
        } catch {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        selectedModel = name;
        modelPath = target;
        modelReady = true;
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/model/download') {
        if (!downloading && !modelReady) {
          downloading = true;
          void (async () => {
            try {
              broadcast({ type: 'MODEL_STATUS', state: 'downloading', stage: 'model', downloaded: 0, total: 0 });
              const dlPath = await downloadModelFile(modelUri, modelsDir, (downloaded, total) => {
                broadcast({ type: 'MODEL_STATUS', state: 'downloading', stage: 'model', downloaded, total });
              });
              modelPath = dlPath;
              selectedModel = path.basename(dlPath);
              modelReady = true;
              broadcast({ type: 'MODEL_STATUS', state: 'ready', stage: 'model' });
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              broadcast({ type: 'MODEL_STATUS', state: 'error', stage: 'model', error });
            } finally {
              downloading = false;
            }
          })();
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      serveStatic(req, res, publicDir, modelReady);
    } catch {
      try {
        res.writeHead(500).end('Internal error');
      } catch { /* ignore */ }
    }
  }

  let handle: ServerHandle;
  let shutdownFn: (reason: string) => Promise<void> = async () => undefined;
  const closed = new Promise<string>((resolveClosed) => {
    shutdownFn = async (reason: string) => {
      await doShutdown(reason);
      resolveClosed(reason);
    };
  });

  // 遊戲物件（shutdown 流程用，延遲指派）
  let engine: GameEngine | null = null;
  let scheduler: SpeechScheduler | null = null;
  let dispatcher: ServerLLM | null = null;
  let llamaServer: LlamaServerManager | null = null;   // doShutdown 用
  let shut = false;

  async function doShutdown(reason: string): Promise<void> {
    if (shut) return;
    shut = true;
    console.log(`[server] 關閉（${reason}）`);
    try {
      engine?.save();
    } catch { /* ignore */ }
    scheduler?.stop();
    if (gameOverTimer) {
      clearTimeout(gameOverTimer);
      gameOverTimer = null;
    }
    registry.stop();
    if (dispatcher) {
      try {
        await dispatcher.shutdown();
      } catch { /* ignore */ }
    }
    if (llamaServer) {
      try {
        await llamaServer.stop();
      } catch { /* ignore */ }
    }
    engine?.close();
    registry.closeAll();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    options.onShutdown?.(reason);
    if (exitProcess) process.exit(0);
  }

  // ---- 等候大廳流程（大廳先於引擎存在；engine 延到 START_GAME 才建立） ----
  // 開局唯一入口：大廳開始遊戲鈕（host 按下）；無自動開局 timer
  let started = false;
  let starting = false;
  let gameOverTimer: ReturnType<typeof setTimeout> | null = null;

  // 遊戲結束：保留座位，延遲後自動回大廳（結果畫面由最後一次快照呈現）
  function scheduleLobbyReturn(): void {
    if (gameOverTimer) return;
    const ms = options.gameOverReturnMs ?? 10000;
    gameOverTimer = setTimeout(() => {
      gameOverTimer = null;
      engine?.close();
      engine = null;
      started = false;
      registry.sendLobby(lobby.snapshot());
    }, ms);
    if (typeof (gameOverTimer as unknown as { unref?: () => void }).unref === 'function') {
      (gameOverTimer as unknown as { unref: () => void }).unref();
    }
  }

  // 開局：heavy（dispatcher）就緒後，用當下大廳人數建 engine 並灌入座位
  async function runStartGame(): Promise<void> {
    if ((started && engine) || starting) return;
    starting = true;
    try {
      const ok = await ensureEngineReady();
      if (!ok || !dispatcher || !scheduler) {
        // heavy 失敗（例如模型未就緒）：退回未開始，大廳重推（開始鈕恢復可用）
        started = false;
        registry.sendLobby(lobby.snapshot());
        return;
      }
      const count = lobby.resolveCount();
      // 斷線未歸的真人座位先轉 AI（否則 HUMAN_JOIN 進遊戲，gate 等無連線者卡死）
      lobby.fillDisconnectedAsAi();
      try {
        engine = new GameEngine(
          { mode: 'web', llm: dispatcher, scheduler, registry, onGameOver: () => scheduleLobbyReturn() },
          createGameState(count),
        );
        for (const s of lobby.seatsForStart()) {
          if (s.controlledBy === 'human') {
            engine.enqueue({ type: 'HUMAN_JOIN', playerId: s.playerId, name: s.name === '' ? undefined : s.name });
          } else {
            engine.enqueue({ type: 'AI_JOIN', playerId: s.playerId });
          }
        }
      started = true;
      engine.enqueue({ type: 'START_GAME' });
        engine.drain();
      } catch (err) {
        // 建 engine／灌座位失敗：退回未開始（避免 started=true＋engine 半殘的永久死鎖）
        console.error(`[server] runStartGame 建引擎失敗：${err instanceof Error ? err.message : String(err)}`);
        engine = null;
        started = false;
        registry.sendLobby(lobby.snapshot());
      }
    } finally {
      starting = false;
    }
  }

  const registry = new WebSocketRegistry(wss, {
    getState: () => {
      if (!engine) throw new Error('engine not ready');
      return engine.getState();
    },
    zeroClientShutdownMs: options.zeroClientShutdownMs,
    pingIntervalMs: options.pingIntervalMs,
    pingTimeoutMs: options.pingTimeoutMs,
    onZeroClientsTimeout: () => void shutdownFn('no-clients'),
    onLastClientLeave: () => void shutdownFn('leave'),
    ensureReady: () => ensureEngineReady(),
    getLobbySnapshot: () => lobby.snapshot(),
    onLobbySignal: (clientId) => {
      lobbyClients.add(clientId);
      if (lobby.hostClientId === undefined) lobby.setHost(clientId);
    },
    getFlagStats: () => scheduler?.flagStats() ?? { decided: 0, abstain: 0, uncertain: 0 },
    onClientLeave: (clientId, playerId) => {
      lobbyClients.delete(clientId);
      lobbySeatByClient.delete(clientId);
      lobby.removeSpectator(clientId);
      transferHostIfLeaver(clientId);
      if (playerId !== undefined && !started) {
        lobby.markDisconnected(playerId);   // 座位保留＋AI 託管
        registry.sendLobby(lobby.snapshot());
      }
    },
    actions: {
      join: (clientId, playerId, name, prevToken) => {
        if (started || engine) return { accepted: false, reason: 'game started' };
        try {
          const { token } = lobby.join(playerId, name, clientId);
          lobby.adoptSpectatorIdentity(clientId, prevToken, token);
          lobby.removeSpectator(clientId);
          lobbySeatByClient.set(clientId, playerId);
          registry.sendLobby(lobby.snapshot());
          return { accepted: true, token };
        } catch (err) {
          return { accepted: false, reason: err instanceof Error ? err.message : 'join failed' };
        }
      },
      reconnect: (clientId, token) => {
        if (!started || !engine) {
          // 大廳內重連：拿回座位（斷線保留／limbo）
          const back = lobby.reclaim(token);
          if (back) {
            lobby.removeSpectator(clientId);
            lobbySeatByClient.set(clientId, back.playerId);
            registry.sendLobby(lobby.snapshot());
            return { accepted: true, playerId: back.playerId, token };
          }
          // 座位拿不回（或純觀眾 token）：同 token 拿回原觀眾編號＋原名
          const sp = lobby.restoreSpectator(clientId, token);
          if (sp) {
            registry.sendLobby(lobby.snapshot());
            return { accepted: true, token, spectator: true, name: sp.name };
          }
          return { accepted: false, reason: 'unknown token' };
        }
        const pid = lobby.lookupToken(token);
        if (pid === undefined) return { accepted: false, reason: 'unknown token' };
        engine.enqueue({ type: 'RECONNECT', playerId: pid });
        engine.drain();
        // 死亡 → RECONNECT 被拒，client 變觀戰者，仍回 JOINED 讓其知道身分
        return { accepted: true, playerId: pid, token };
      },
      spectate: (clientId, playerId, token) => {
        if (started || engine) return { accepted: false, reason: 'game started' };
        lobby.leave(playerId);
        // 同 token 回原觀眾編號（首次離席則把無名號碼帶到 token，不遞增）
        lobby.addSpectator(clientId, token);
        lobbySeatByClient.delete(clientId);
        registry.sendLobby(lobby.snapshot());
        return { accepted: true };
      },
      leaveLobby: (clientId, playerId, token) => {
        // 大廳乾淨離開（返回主選單用）：顯式釋放座位（limbo 一併清除，不可重連拿回）＋觀眾下架＋host 轉移，即時廣播；遊戲中拒絕
        if (started || engine) return { accepted: false, reason: 'game started' };
        if (playerId !== undefined) {
          lobby.leaveLobbySeat(playerId, token);
        }
        lobby.removeSpectator(clientId);
        lobbyClients.delete(clientId);
        lobbySeatByClient.delete(clientId);
        transferHostIfLeaver(clientId);
        registry.sendLobby(lobby.snapshot());
        return { accepted: true };
      },
      setName: (clientId, playerId, token, name) => {
        if (started || engine) return { accepted: false, reason: 'game started' };
        try {
          const r = lobby.setName(clientId, { playerId, token, name });
          registry.sendLobby(lobby.snapshot());
          return { accepted: true, name: r.name, token: r.token };
        } catch (err) {
          return { accepted: false, reason: err instanceof Error ? err.message : 'rename failed' };
        }
      },
      setPlayerCount: (clientId, count) => {
        const h = lobby.hostClientId;
        if (h !== undefined && h !== clientId) return { accepted: false, reason: 'only host' };
        if (started || engine) return { accepted: false, reason: 'game started' };
        try {
          lobby.setPlayerCount(count);
        } catch (err) {
          return { accepted: false, reason: err instanceof Error ? err.message : 'bad count' };
        }
        registry.sendLobby(lobby.snapshot());
        return { accepted: true };
      },
      setRandomCount: (clientId, enabled) => {
        const h = lobby.hostClientId;
        if (h !== undefined && h !== clientId) return { accepted: false, reason: 'only host' };
        if (started || engine) return { accepted: false, reason: 'game started' };
        lobby.setRandomCount(enabled);
        registry.sendLobby(lobby.snapshot());
        return { accepted: true };
      },
      chat: (clientId, playerId, text, token) => {
        if (started || engine) return { accepted: false, reason: 'game started' };
        const from = (playerId !== undefined ? lobby.seatName(playerId) : undefined)
          ?? lobby.addSpectator(clientId, token).name;
        try {
          const entry = lobby.addChat(from, text);
          broadcast({ type: 'CHAT_MESSAGE', from: entry.from, text: entry.text, ts: entry.ts });
        } catch (err) {
          return { accepted: false, reason: err instanceof Error ? err.message : 'chat failed' };
        }
        return { accepted: true };
      },
      startLobbyGame: (clientId) => {
        if (started || engine) return { accepted: false, reason: 'game started' };
        const h = lobby.hostClientId;
        if (h !== undefined && h !== clientId) return { accepted: false, reason: 'only host' };
        started = true;
        void runStartGame();
        return { accepted: true };
      },
      humanEvent: (event) => {
        if (!engine) return { accepted: false, reason: 'engine not ready' };
        const result = engine.tryEvent(event);
        // 真人事件可能觸發 ENQUEUE 級聯（如完成夜間 gate → RESOLVE_NIGHT）；
        // tryEvent 只處理單一事件不消化佇列，必須 drain，否則結算事件卡 queue、遊戲凍結
        engine.drain();
        return { accepted: result.accepted, reason: result.reason };
      },
      disconnectPlayer: (playerId) => {
        if (!engine) return;
        engine.enqueue({ type: 'DISCONNECT', playerId });
        engine.drain();
      },
      isStarted: () => started,
    },
  });

  // ---- 延遲建立：進入遊戲（WS 連線）時確保 llama-server + dispatcher/scheduler/engine ----
  // llama-server 只啟動一次；重複連線直接回傳既有 engine。
  let initPromise: Promise<void> | null = null;

  async function ensureEngineReady(): Promise<boolean> {
    if (engine) return true;
    if (initPromise) {
      try {
        await initPromise;
      } catch {
        return false;
      }
      return dispatcher !== null;
    }
    // 測試 hook 直接注入 dispatcher，跳過模型檢查與 sidecar
    if (!options.dispatcherFactory && (mode === 'llama-server' || mode === 'llamacpp') && !modelReady) {
      return false;
    }
    initPromise = initGame();
    try {
      await initPromise;
    } catch {
      initPromise = null;
      return false;
    }
    // 注意：engine 本體延到 START_GAME 才建（大廳先於引擎存在）；
    //此處回傳 heavy（dispatcher）是否就緒。
    return dispatcher !== null;
  }

  async function initGame(): Promise<void> {
    if (engine) return;
    if (options.dispatcherFactory) {
      dispatcher = options.dispatcherFactory(modelPath);   // 測試 hook：跳過 sidecar
    } else if (mode === 'llama-server') {
      broadcast({ type: 'MODEL_STATUS', state: 'starting', stage: 'llama-server' });
      const backendPref = effectiveBackendPreference({
        option: options.backend, stored: readBackendPreference(), env: process.env,
      });
      const binDir = options.llamaServerBinDir ?? process.env.LLAMA_SERVER_BIN_DIR ?? getDefaultBinDir();
      const release = options.llamaServerRelease ?? process.env.LLAMA_SERVER_RELEASE ?? DEFAULT_LLAMA_SERVER_RELEASE;
      const gpuLayers = options.llamaGpuLayers ?? defaultGpuLayers();
      const mgrBase = {
        modelPath,
        port: llamaServerPort,
        host: llamaServerHost,
        ctxSize: options.llamaServerCtxSize ?? envInt('LLAMA_SERVER_CTX_SIZE', 8192),
        threads: options.llamaServerThreads ?? envInt('LLAMA_SERVER_THREADS', defaultThreads()),
        parallel: options.llamaServerParallel ?? envInt('LLAMA_SERVER_PARALLEL', 1),
        idleTimeout: options.llamaServerIdleTimeout ?? envInt('LLAMA_SERVER_IDLE_TIMEOUT', 600), // 已棄用：b10361 不支援，不轉 flag
        // 2.38GB 模型載入動輒數分鐘：健康等待放寬至 300s（可用 env 覆寫），避免誤殺
        healthTimeoutMs: envInt('LLAMA_SERVER_HEALTH_TIMEOUT_MS', 300000),
      };
      const forwardStatus = (status: 'starting' | 'ready' | 'crashed' | 'stopped', info?: string): void => {
        if (status === 'starting') broadcast({ type: 'MODEL_STATUS', state: 'starting', stage: 'llama-server', info });
        if (status === 'ready') broadcast({ type: 'MODEL_STATUS', state: 'ready', stage: 'llama-server' });
        if (status === 'crashed') broadcast({ type: 'MODEL_STATUS', state: 'error', stage: 'llama-server', error: info ?? 'llama-server crashed' });
      };
      const onProg = {
        onProgress: (downloaded: number, total: number) =>
          broadcast({ type: 'MODEL_STATUS', state: 'downloading', stage: 'llama-server', downloaded, total }),
        onStage: (info: string) =>
          broadcast({ type: 'MODEL_STATUS', state: 'starting', stage: 'llama-server', info }),
      };
      try {
        let port: number;
        if (options.llamaServerBinPath) {
          // 測試 hook：單包直啟（跳過下載與回退）
          llamaServer = new LlamaServerManager({ ...mgrBase, binPath: options.llamaServerBinPath, onStatus: forwardStatus });
          ({ port } = await llamaServer.start());
        } else if (backendPref === 'cpu') {
          const binPath = await ensureLlamaServer({ binDir, release, variant: 'cpu', pruneOtherVariants: true, ...onProg });
          llamaServer = new LlamaServerManager({ ...mgrBase, binPath, gpuLayers: 0, onStatus: forwardStatus });
          ({ port } = await llamaServer.start());
        } else if (backendPref === 'gpu') {
          // 手動 GPU：只下 Vulkan 包；GPU 錯可降層一次，但不換 CPU（尊重手動選擇）
          const binPath = await ensureLlamaServer({ binDir, release, variant: 'vulkan', pruneOtherVariants: true, ...onProg });
          const r = await startLlamaServerWithFallback({
            cpuBinPath: binPath, vulkanBinPath: binPath,
            gpuLayers, allowCpuFallback: false, onStatus: forwardStatus, ...mgrBase,
          });
          llamaServer = r.manager;
          port = r.port;
        } else {
          // auto：先 CPU（底線）再 Vulkan；優先 Vulkan，失敗自動降層→換碟上 CPU，全程無二次下載
          const { cpuPath, vulkanPath } = await ensureLlamaServerPair({ binDir, release, ...onProg });
          const r = await startLlamaServerWithFallback({
            cpuBinPath: cpuPath, vulkanBinPath: vulkanPath,
            gpuLayers, allowCpuFallback: true, onStatus: forwardStatus, ...mgrBase,
          });
          llamaServer = r.manager;
          port = r.port;
        }
        dispatcher = new OpenAICompatibleDispatcher(
          new OpenAICompatibleProvider({ baseURL: `http://${llamaServerHost}:${port}/v1`, model: 'local' }));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        broadcast({ type: 'MODEL_STATUS', state: 'error', stage: 'llama-server', error });
        console.error(`[server] llama-server 啟動失敗：${error}`);
        throw err;
      }
    } else if (mode === 'llamacpp') {
      try {
        dispatcher = new WorkerDispatcher({ modelPath });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        broadcast({ type: 'MODEL_STATUS', state: 'error', stage: 'model',
          error: `packaged build 不支援 llamacpp 模式：${error}` });
        console.error(`[server] llamacpp 模式啟動失敗：${error}`);
        throw err;
      }
    } else if (mode === 'openai') {
      dispatcher = new OpenAICompatibleDispatcher(new OpenAICompatibleProvider({
        baseURL: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL, apiKey: process.env.FREELLMAPI_API_KEY }));
    } else {  // mock
      dispatcher = new MockDispatcher();
    }
    try {
      await dispatcher.start();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'MODEL_STATUS', state: 'error', stage: 'model', error });
      console.error(`[server] worker 啟動失敗：${error}`);
      throw err;
    }

    // scheduler 先建（ctx 閉包延遲取用 engine；engine 本體延到 START_GAME 才建）
    scheduler = new SpeechScheduler({
      enqueue: (e) => {
        engine!.enqueue(e);
        engine!.drain();   // AI_SPEECH_DONE 需立即處理，否則卡在 queue（討論永不推進）
      },
      getState: () => engine!.getState(),
      llm: dispatcher,
    });

    // 收斂直進投票（第 2 項）：討論結束不再靠發言數強制關閉，
    // 改由 AI_READY_VOTE／HUMAN_READY_VOTE 的統一檢查推進；此處無需 timer。

    // heavy 就緒後重推一次大廳（含最新 engineStatus），各 client 無需重連
    try {
      registry.sendLobby(lobby.snapshot());
    } catch { /* ignore */ }
  }

  const onSignal = (): void => {
    void shutdownFn('signal');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const port = portOpt === 0 ? await findAvailablePort(2639) : portOpt;
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, () => resolve());
  });
  const url = `http://localhost:${port}`;
  console.log(`[server] 啟動：${url}`);

  // 啟動即 armed：主選單不開 WS，從頭 0 連線也會計時（60 秒無連線 → no-clients）；
  // 首條連線進來時 onConnection 會清掉 timer，故已有連線的情況不受影響。
  registry.armZeroTimerIfEmpty();

  handle = {
    port,
    url,
    shutdown: (reason: string) => shutdownFn(reason),
    closed,
  };

  // ---- 啟動完成：先顯示主選單，不自動下載模型、不自動啟動 llama-server ----
  // 模型下載改由 POST /api/model/download 觸發；
  // llama-server + dispatcher/scheduler/engine 改由 WS 連線時（ensureEngineReady）延遲建立。
  if (!modelReady && !isMock && mode !== 'openai') {
    console.log(`[server] 未偵測到模型（${modelsDir}），請由主選單下載`);
  }

  if (shouldOpenBrowser) openBrowser(url);
  return handle;
}

export async function main(): Promise<void> {
  try {
    await startServer({});
  } catch (err) {
    console.error(`[server] 啟動失敗：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
