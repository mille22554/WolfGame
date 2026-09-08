# Phase 3 exe 打包（雙擊即玩）：詳細實作規格

> 本文件是 Phase 3（exe 打包）的完整實作規格，fixer 可直接照做。
> 前置：Phase 0（481f831）+ Phase 1（2250455、88a88b1）+ Phase 2（9add54c）已完成。
> 已確認：pkg spike 結論（Plan B = llama-server.exe sidecar + OpenAICompatibleProvider）；getResourceRoot/getDataDir 拆分已於 Phase 0 就緒。
> 若實作中發現規格矛盾或遺漏，記錄問題回報，不要自行發明解法。

---

## 0. 目標與完成定義

### 0.1 目標

1. **雙擊即玩**：`WerewolfGame.exe` 雙擊 → 自動下載/定位 llama-server.exe 與模型 → 啟動本地推理 → 開瀏覽器進大廳
2. **Plan B 落地**：預設改用 llama-server sidecar（OpenAI 相容端點 localhost:3001/v1），exe 內**不含** node-llama-cpp
3. **開發模式不破**：`npm start` / `node dist/entry.js` 繼續可用；`LLM_PROVIDER` 可切換 `llama-server` / `llamacpp` / `mock` / `openai`
4. **首次啟動流程**：exe → 檢查執行環境 → 檢查模型 → 啟動 sidecar → 啟動 web server → 開瀏覽器；進度以 MODEL_STATUS 廣播（Phase 1 已有）

### 0.2 完成定義

Phase 3 完成的定義（全部滿足）：

1. `npm test` 全綠（既有 14 檔 + 新增 3 檔，共 17 檔）；`node driver.mjs mock-test` 跑通
2. `npm start`（LLM_PROVIDER 未設，即 llama-server 模式）→ 下載/定位 llama-server.exe + 模型 → 啟動 → 瀏覽器開大廳 → 全 AI 局跑完
3. `LLM_PROVIDER=llamacpp` → 沿用 Phase 1/2 行為（node-llama-cpp worker）不破
4. `LLM_PROVIDER=mock` → 無 sidecar、無下載，直接開局（測試/開發快速路徑）
5. `npm run build:pkg` → 產出 `dist-pkg/WerewolfGame.exe`（約 37MB）；`npm run smoke:pkg` 冒煙測試通過（exe 啟動 → HTTP 200 → WS 收到討論 → 乾淨退出）
6. exe 內不含 node-llama-cpp（esbuild bundle 檢查：`dist-pkg/entry.cjs` 無 `node-llama-cpp` 字樣）
7. 手動驗證：exe 雙擊 → 首次啟動下載流程（llama-server → 模型）→ 遊戲可玩；重啟 exe → 跳過下載直接開局；關閉 exe → sidecar 停止

---

## 1. 設計總覽與關鍵決策

### 1.1 打包工具評估結論（已確認）

| 工具 | 結論 | 理由 |
|---|---|---|
| **pkg 5.8.1 + esbuild CJS bundle** | ✅ **採用** | spike 實測 CJS 入口 → 37MB exe；esbuild 將 ESM 源碼 bundle 為單一 CJS；node18 base binary 為唯一可用目標 |
| pkg 直接打包 ESM | ❌ | spike 實測 `import()` ESM 於 snapshot 內失敗（"Invalid host defined options"）；pkg 5.8.1 不支援 ESM 入口 |
| pkg 直接打包 node-llama-cpp | ❌ | 3 blocker：ESM、native binding dlopen 快照路徑失敗（需 extraction shim）、僅 node18 base |
| Node SEA | ❌ | 同樣需 CJS snapshot（`--experimental-sea-config` 只吃 CJS）；exe = node.exe + blob（>100MB）；實驗性 API 變動風險 |
| nexe | ❌ | 維護停滯、同樣 CJS 限制、無優勢 |
| bun compile | ❌ | 原生 ESM 但 ws/worker_threads 相容性未驗證；本專案 exe 模式不需 worker_threads，但 ws 依賴 node:net/tls 行為，風險高於收益 |

**關鍵推論**：exe 模式（llama-server）**不需要** worker.ts / worker-dispatcher.ts 的執行路徑，也不需要 node-llama-cpp。因此 bundle 可排除 node-llama-cpp（esbuild `--external`），llamacpp 相關程式碼以動態 import + external 隔離，exe 內永不載入。

### 1.2 LLM 提供者切換（Plan B 核心）

```
LLM_PROVIDER（環境變數）：
  'llama-server'（預設，含未設定）→ 純 fetch 下載模型 → spawn llama-server sidecar → OpenAICompatibleDispatcher
  'llamacpp'                    → ensureModelDownloaded（node-llama-cpp）→ WorkerDispatcher（沿用 Phase 1/2）
  'mock'                        → MockProvider（無 sidecar、無下載）
  'openai'                      → OpenAICompatibleDispatcher 指向外部端點（LLM_BASE_URL/LLM_MODEL/FREELLMAPI_API_KEY）
```

- **現況**：`createProvider()`（llm.ts）已是 OpenAICompatibleProvider 預設，但 server.ts 直接走 WorkerDispatcher，未使用 createProvider。Phase 3 把 server.ts 的 dispatcher 建立邏輯改為依 `LLM_PROVIDER` 切換。
- **llama-server 模式與 llamacpp 模式共用**：`isModelDownloaded` / `resolveModelPath` / `modelFileName`（server.ts，純 fs）與 `DEFAULT_LLAMACPP_MODEL_URI`（llm.ts，純字串）。

### 1.3 llama-server sidecar 生命週期

```
啟動：
  1. 檢查 getDataDir()/bin/llama-b<release>/llama-server.exe（或 binDir/llama-server.exe 使用者手放）→ 無 → 下載 zip → 解壓 → 驗證
  2. probe GET http://host:port/health → 200 {"status":"ok"} → 重用（不 spawn；雙開/殘留實例共用）
  3. 否則 spawn llama-server.exe --model <path> --host 127.0.0.1 --port <port> --ctx-size 8192 --threads N --parallel 1 --no-webui
     （注意：b10361 不支援 --idle-timeout，傳了會秒死 invalid argument；idleTimeout 選項已棄用）
  4. 輪詢 /health（1s 間隔，上限 120s——模型載入可能很久）→ 200 → ready
  5. spawn 失敗或 crash → 重啟（backoff 1s/2s/4s，≤ maxRestarts=3）；port 被佔 → 依序試 port+1..+10
  6. 全部失敗 → MODEL_STATUS error → shutdown

關閉（doShutdown）：
  僅當 sidecar 由本實例 spawn → child.kill()（SIGTERM）→ 5s 未退 → SIGKILL
  重用實例 → 不殺（共享資源）

崩潰殘留：
  父進程意外死亡（關閉 console 視窗）→ sidecar 成為孤兒 → 下次啟動 /health 探測到 → 重用
  孤兒安全僅靠：重用＋stop 只殺自 spawn child＋零連線自動關閉（b10361 無 --idle-timeout，不可依賴）
```

### 1.4 模型下載（純 fetch，無 node-llama-cpp）

- 新 `downloadModelFile()`：`hf:owner/repo:file` → `https://huggingface.co/owner/repo/resolve/main/file`；`https://...` 直通。
- 下載到 `getDataDir()/models/<file>.gguf`（tmp → rename 原子寫入），進度回呼 → MODEL_STATUS 廣播。
- **向後相容**：既有下載檔 `hf_Qwen_Qwen3-4B.QWEN3-4B-Q4_K_M.GGUF.gguf` 滿足 `isModelDownloaded` 的「任一 .gguf」檢查 → 不重複下載；`resolveModelPath` 掃描找到即用。
- llamacpp 模式沿用 `ensureModelDownloaded`（node-llama-cpp 的 resolveModelFile）。

### 1.5 pkg 打包流程

```
npm run build:pkg：
  1. tsc（既有 build）
  2. esbuild src/entry.ts → dist-pkg/WerewolfGame.cjs
     --bundle --platform=node --format=cjs --target=node18
     --external:node-llama-cpp --external:./llamacpp.js --external:bufferutil --external:utf-8-validate
  3. pkg dist-pkg/WerewolfGame.cjs --config pkg.config.json
     targets: node18-win-x64；assets: public/**、character/**、package.json
     → dist-pkg/WerewolfGame.exe（約 37MB）
```

- **snapshot 佈局**（spike 實測）：pkg 以 package.json `name`（werewolf-game）建 snapshot 根 `C:\snapshot\werewolf-game\`；assets 依專案相對路徑放置（`public/`、`character/`、`package.json`）；entry 位於 `dist-pkg/` 子目錄。
- **getResourceRoot 正確性**：現行 `path.resolve(__dirname, '..')` 在 pkg 下 = `C:\snapshot\werewolf-game`（entry 在子目錄時 dirname 一次即為 snapshot 根）→ **不需修改**。spike 的 test-entry.cjs 在專案根導致誤判，實作時以冒煙測試驗證（見 §12.4）。
- **exe 內不可用**：llamacpp 模式（動態 import `./llamacpp.js` 在 exe 中不存在 → 明確錯誤訊息「packaged build 不支援 llamacpp 模式」）。

### 1.6 首次啟動流程（exe）

```
exe 啟動 → entry.ts → startServer()
  → http server 先啟動（serve download.html）
  → 檢查 llama-server.exe → 無 → 下載+解壓（MODEL_STATUS stage='llama-server'）
  → 檢查模型 → 無 → 下載（MODEL_STATUS stage='model'）
  → spawn llama-server → /health 就緒
  → 建立 OpenAICompatibleDispatcher → engine + scheduler + registry
  → startLobbyTimer() → 開瀏覽器 /
```

---

## 2. 檔案地圖

| 檔案 | 動作 | 說明 |
|---|---|---|
| src/types.ts | 小改 | MODEL_STATUS 加 `stage` 欄位 |
| src/llm.ts | 拆分 | 只留 providers（OpenAICompatibleProvider / MockProvider / createProvider）+ 常數；node-llama-cpp 相關移出 |
| src/llamacpp.ts | 新增 | LlamaCppProvider + ensureModelDownloaded（node-llama-cpp 依賴集中於此） |
| src/model-download.ts | 新增 | 純 fetch GGUF 下載器（無 node-llama-cpp） |
| src/llama-server.ts | 新增 | LlamaServerManager（sidecar 生命週期）+ getDefaultBinDir + ensureLlamaServer |
| src/llm-dispatcher.ts | 新增 | OpenAICompatibleDispatcher（LLMDispatcher + ServerLLM 實作，包 OpenAICompatibleProvider） |
| src/entry.ts | 新增 | 入口：`import { main } from './server.js'; void main();` |
| src/server.ts | 擴充 | 移除自啟動區塊、provider 切換、sidecar 生命週期、模型下載切換、OPEN_BROWSER env |
| src/worker.ts | 不動 | 已只 import MockProvider from llm.js（llm.js 拆分後仍相容） |
| src/worker-dispatcher.ts | 小改 | 匯出 KIND_DEFAULTS（供 llm-dispatcher 共用） |
| src/utils.ts | 不動 | getResourceRoot/getDataDir 已就緒（Phase 0） |
| driver.mjs | 小改 | ensureModelDownloaded 等改從 dist/llamacpp.js import |
| public/js/download.js | 小改 | MODEL_STATUS stage 支援（llama-server / model 不同文案） |
| public/download.html | 不動 | 結構已夠用 |
| package.json | 擴充 | start → dist/entry.js；build:pkg / smoke:pkg scripts；deps: adm-zip；devDeps: esbuild, pkg |
| pkg.config.json | 新增 | pkg 打包設定 |
| scripts/build-pkg.mjs | 新增 | esbuild + pkg 建置腳本 |
| scripts/pkg-smoke.mjs | 新增 | exe 冒煙測試 |
| src/llm.test.ts | 新增 | OpenAICompatibleProvider / MockProvider 測試 |
| src/model-download.test.ts | 新增 | downloadModelFile 測試 |
| src/llama-server.test.ts | 新增 | LlamaServerManager 測試（fake binary） |
| src/server.test.ts | 擴充 | llama-server 模式整合測試 |

**不動**：engine.ts、game-state.ts、ai-scheduler.ts、ai.ts、character-session.ts、night.ts、day.ts、gm.ts、assignment.ts、public/index.html、public/js/main.js、public/css/。

---

## 3. types.ts 小改

```typescript
// MODEL_STATUS 加 stage（區分 llama-server 下載與模型下載）
| { type: 'MODEL_STATUS'; state: 'downloading' | 'ready' | 'error';
    stage?: 'llama-server' | 'model'; downloaded?: number; total?: number; error?: string }
```

---

## 4. llm.ts 拆分 + llamacpp.ts

### 4.1 llm.ts（拆分後內容）

保留（**不 import node-llama-cpp**）：

```typescript
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface LLMProvider { chat(messages: ChatMessage[], config?: GenerationConfig): Promise<string>; readonly name: string }
export interface OpenAICompatibleOptions { baseURL?: string; model?: string; apiKey?: string }
export class OpenAICompatibleProvider implements LLMProvider { /* 原樣不動 */ }
export class MockProvider implements LLMProvider { /* 原樣不動 */ }
export const DEFAULT_LLAMACPP_MODEL_URI = 'hf:Qwen/Qwen3-4B-GGUF:Qwen3-4B-Q4_K_M.gguf';  // 純字串常數，名稱保留（driver.mjs 相容）
export const DEFAULT_MODEL_URI = DEFAULT_LLAMACPP_MODEL_URI;  // 語意化別名（llama-server 模式也用）
export function getDefaultModelsDir(): string {
  // 改：getProjectRoot() → getDataDir()（dev 下兩者相同；pkg 下為 %APPDATA%/WerewolfGame/models 或 exe 旁 data/models）
  return path.join(getDataDir(), 'models');
}
export async function createProvider(): Promise<LLMProvider> {
  // 'mock' → MockProvider
  // 'llamacpp' → 動態 import('./llamacpp.js') 取 ensureModelDownloaded + LlamaCppProvider
  // 其餘 → OpenAICompatibleProvider（外部端點）
}
```

- `createProvider` 的 llamacpp 分支用**動態 import**（esbuild 對 `./llamacpp.js` 設 external → exe 內該 import 保留為 runtime require，僅在 llamacpp 模式被呼叫時才失敗）。
- 移除：`import { getLlama, LlamaChatSession, QwenChatWrapper, resolveModelFile } from 'node-llama-cpp'`、`LlamaCppProvider`、`ensureModelDownloaded`。

### 4.2 llamacpp.ts（新增，node-llama-cpp 依賴集中處）

```typescript
import { getLlama, LlamaChatSession, QwenChatWrapper, resolveModelFile } from 'node-llama-cpp';
import { getDataDir } from './utils.js';

export async function ensureModelDownloaded(modelUri, modelsDir, onProgress?): Promise<string>;  // 原樣搬移
export class LlamaCppProvider implements LLMProvider { /* 原樣搬移 */ }
```

- 被誰 import：`createProvider`（動態）、server.ts llamacpp 分支（動態）、driver.mjs（靜態，dev only）。
- **此檔是 exe bundle 中唯一會觸及 node-llama-cpp 的模組**；esbuild 設 `--external:./llamacpp.js` 使其不進 bundle。

### 4.3 worker.ts

- 現況已只 `import { MockProvider } from './llm.js'` + 直接 `import { getLlama, ... } from 'node-llama-cpp'` → **不需修改**（llm.js 拆分後 MockProvider 仍在）。

### 4.4 driver.mjs

```javascript
// 改：ensureModelDownloaded / DEFAULT_LLAMACPP_MODEL_URI / getDefaultModelsDir 從 llamacpp.js 取
const { MockProvider, createProvider } = await import('./dist/llm.js');
const { ensureModelDownloaded, DEFAULT_LLAMACPP_MODEL_URI, getDefaultModelsDir } = await import('./dist/llamacpp.js');
```

---

## 5. model-download.ts（純 fetch GGUF 下載器）

```typescript
export interface ModelUri { url: string; fileName: string }

/** 'hf:owner/repo:file' → HF resolve URL；'https://...' 直通 */
export function parseModelUri(uri: string): ModelUri {
  if (uri.startsWith('hf:')) {
    const rest = uri.slice(3);                       // 'owner/repo:file'
    const colon = rest.lastIndexOf(':');
    if (colon <= 0) throw new Error(`無效 hf URI：${uri}`);
    const repo = rest.slice(0, colon);
    const file = rest.slice(colon + 1);
    return { url: `https://huggingface.co/${repo}/resolve/main/${file}`, fileName: file };
  }
  if (uri.startsWith('https://') || uri.startsWith('http://')) {
    return { url: uri, fileName: path.basename(new URL(uri).pathname) };
  }
  throw new Error(`不支援的模型 URI：${uri}`);
}

/**
 * 純 fetch 下載 GGUF（無 node-llama-cpp）。
 * 已存在（精確檔名或任一 .gguf）→ 直接回傳路徑，不下載。
 * 下載流程：fetch → res.ok 檢查 → Readable.fromWeb(res.body) → pipe 到 <file>.tmp → rename 原子寫入。
 * 失敗 → 刪除 tmp → throw。
 */
export async function downloadModelFile(
  uri: string,
  modelsDir: string,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<string>;
```

演算法：

```
1. { url, fileName } = parseModelUri(uri)
2. modelsDir 不存在 → mkdirSync recursive
3. target = path.join(modelsDir, fileName)
4. 已存在 target → 回傳 target
5. 掃描 modelsDir 任一 .gguf → 回傳該路徑（既有 hf_ 前綴檔相容）
6. fetch(url, { signal: AbortSignal.timeout(0) })  // 無逾時；下載中斷由 pipe error 處理
7. !res.ok → throw `下載失敗（HTTP ${res.status}）`
8. total = Number(res.headers.get('content-length') ?? 0)
9. tmp = target + '.tmp'
10. Readable.fromWeb(res.body) → pipeline(stream, fs.createWriteStream(tmp), cb)；
    每寫入 chunk 累計 downloaded → onProgress?.(downloaded, total)
11. 完成 → fs.renameSync(tmp, target) → 回傳 target
12. catch → fs.rmSync(tmp, { force: true }) → throw
```

- 依賴：`node:fs`、`node:path`、`node:stream`（Readable.fromWeb / pipeline）、`node:util`（promisify）。全部 Node 18 內建。
- 測試注入：接受 `fetchImpl?: typeof fetch` 參數（預設全域 fetch）以便測試用本地 http server。

---

## 6. llama-server.ts（sidecar 管理）

### 6.1 常數與路徑

```typescript
export const DEFAULT_LLAMA_SERVER_RELEASE = 'b10361';   // 與 node-llama-cpp 鎖定版本一致（Qwen3 支援）
export const DEFAULT_LLAMA_SERVER_PORT = 3001;
export const DEFAULT_LLAMA_SERVER_HOST = '127.0.0.1';

export function getDefaultBinDir(): string {
  return path.join(getDataDir(), 'bin');
}

/** llama-server.exe 下載 URL（llama.cpp GitHub release 資產，已驗證存在） */
export function llamaServerDownloadUrl(release: string): string {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${release}/llama-${release}-bin-win-cpu-x64.zip`;
}
```

### 6.2 ensureLlamaServer（下載/解壓/驗證）

```typescript
export interface LlamaServerDownloadOptions {
  binDir?: string;                       // 預設 getDefaultBinDir()
  release?: string;                      // 預設 DEFAULT_LLAMA_SERVER_RELEASE
  onProgress?: (downloaded: number, total: number) => void;
  fetchImpl?: typeof fetch;              // 測試注入
}

/** 回傳 llama-server.exe 絕對路徑；找不到/下載失敗 → throw */
export async function ensureLlamaServer(options: LlamaServerDownloadOptions = {}): Promise<string>;
```

演算法：

```
1. binDir = options.binDir ?? getDefaultBinDir()
2. 候選路徑依序檢查（存在 → 回傳）：
   a. binDir/llama-<release>/llama-server.exe   （先前下載）
   b. binDir/llama-server.exe                   （使用者手放）
3. 下載：
   a. mkdirSync(binDir, recursive)
   b. zipPath = binDir/llama-<release>.zip.tmp
   c. fetch(downloadUrl) → res.ok 檢查 → pipeline 寫入 zipPath（onProgress 回呼）
   d. 解壓：new AdmZip(zipPath).extractAllTo(binDir/llama-<release>/, true)
   e. rmSync(zipPath)
4. 驗證 exe 存在 → 回傳；否則 throw
```

- 依賴：`adm-zip`（純 JS、無 native、pkg 可 bundle）——新增 dependency。
- zip 內含 llama-server.exe + 所需 DLL（ggml.dll、llama.dll、ggml-base.dll、ggml-cpu.dll），**整包解壓**（DLL 需與 exe 同目錄）。

### 6.3 LlamaServerManager（spawn/健康檢查/重啟/停止）

```typescript
export interface LlamaServerManagerOptions {
  binPath: string;                 // llama-server.exe 或測試用 fake binary
  modelPath: string;               // .gguf 絕對路徑
  port?: number;                   // 預設 3001
  host?: string;                   // 預設 127.0.0.1
  ctxSize?: number;                // 預設 8192
  threads?: number;                // 預設 os.cpus().length
  parallel?: number;               // 預設 1
  idleTimeout?: number;            // 已棄用，無作用（b10361 不支援 --idle-timeout，保留相容）
  healthTimeoutMs?: number;        // 預設 120000（模型載入可能很久）
  healthIntervalMs?: number;       // 預設 1000
  maxRestarts?: number;            // 預設 3
  onStatus?: (status: 'starting' | 'ready' | 'crashed' | 'stopped', info?: string) => void;
}

export class LlamaServerManager {
  constructor(options: LlamaServerManagerOptions);
  /** 健康檢查通過即 resolve；回傳實際 port 與是否重用既有實例 */
  start(): Promise<{ port: number; reused: boolean }>;
  /** 僅當由本實例 spawn 才殺 child；重用實例為 no-op */
  stop(): Promise<void>;
  isRunning(): boolean;
  readonly port: number;
}
```

**start() 演算法**：

```
1. for port in [port, port+1, ..., port+10]:
   a. probeHealth(port) → 200 {"status":"ok"} → return { port, reused: true }
   b. spawn(binPath, args(port)) → 輪詢 probeHealth（healthIntervalMs 間隔，≤ healthTimeoutMs）
   c. spawn 失敗（exit ≠ 0 於 5s 內）→ 若 port 被佔（EADDRINUSE 特徵）→ 試下一個 port；否則重啟
2. 運行中 crash（exit 事件）→ restarts < maxRestarts → backoff sleep(1000 * 2^restarts) → 重新 spawn
   → restarts ≥ maxRestarts → onStatus('crashed') → throw
3. 全部 port 皆失敗 → throw
```

**args()**：

```
--model <modelPath> --host <host> --port <port> --ctx-size <ctxSize>
--threads <threads> --parallel <parallel> --no-webui
```

**probeHealth(port)**：

```
GET http://host:port/health（fetch，timeout 2s）
→ res.ok && body.status === 'ok' → true
→ 其餘（含 503 載入中、連線拒絕）→ false
```

**stop() 演算法**：

```
spawnedByUs && child 存在：
  child.kill()（SIGTERM）→ 等 5s → 未退出 → child.kill('SIGKILL')
reused → no-op
```

**spawn 細節**：

```
child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
child.stdout/stderr → 收集尾部 200 行（錯誤診斷用，onStatus('crashed', tail)）
child.on('exit', ...) → 依狀態走重啟/失敗邏輯
```

---

## 7. llm-dispatcher.ts（OpenAICompatibleDispatcher）

```typescript
import { OpenAICompatibleProvider } from './llm.js';
import { parseTargetId, KIND_DEFAULTS } from './worker-dispatcher.js';
import type { LLMDispatcher, GenerationConfig } from './types.js';

/** 包裝任何 OpenAI 相容端點（本地 llama-server 或外部 API）為 LLMDispatcher */
export class OpenAICompatibleDispatcher implements LLMDispatcher {
  readonly name = 'openai-compatible';
  constructor(private readonly provider: OpenAICompatibleProvider) {}

  async requestSpeech(playerId: number, prompt: string): Promise<{ text: string }> {
    void playerId;
    const text = await this.provider.chat([{ role: 'user', content: prompt }], KIND_DEFAULTS.speech);
    return { text: text.trim() };
  }
  async requestVote(playerId: number, prompt: string): Promise<{ targetId: number }> {
    void playerId;
    const text = await this.provider.chat([{ role: 'user', content: prompt }], KIND_DEFAULTS.vote);
    return { targetId: parseTargetId(text) };
  }
  async requestNightAction(playerId: number, prompt: string): Promise<{ targetId: number }> {
    void playerId;
    const text = await this.provider.chat([{ role: 'user', content: prompt }], KIND_DEFAULTS.night);
    return { targetId: parseTargetId(text) };
  }
  async generate(prompt: string, config?: GenerationConfig): Promise<string> {
    const text = await this.provider.chat([{ role: 'user', content: prompt }], config ?? KIND_DEFAULTS.expand);
    return text.trim();
  }
}
```

- **worker-dispatcher.ts 小改**：`export const KIND_DEFAULTS`（現為 module 私有，加 export）。
- 注意：`OpenAICompatibleProvider.chat` 已處理 temperature/max_tokens 映射（llm.ts 現行），不需改。

---

## 8. server.ts 整合

### 8.1 ServerOptions 新增

```typescript
export interface ServerOptions {
  /* 既有欄位（不變） */
  llamaServerPort?: number;        // env LLAMA_SERVER_PORT，預設 3001
  llamaServerHost?: string;        // env LLAMA_SERVER_HOST，預設 127.0.0.1
  llamaServerCtxSize?: number;     // env LLAMA_SERVER_CTX_SIZE，預設 8192
  llamaServerThreads?: number;     // env LLAMA_SERVER_THREADS，預設 os.cpus().length
  llamaServerParallel?: number;    // env LLAMA_SERVER_PARALLEL，預設 1
  llamaServerIdleTimeout?: number; // 已棄用，無作用（b10361 不支援 --idle-timeout，保留相容）
  llamaServerRelease?: string;     // env LLAMA_SERVER_RELEASE，預設 'b10361'
  llamaServerBinDir?: string;      // env LLAMA_SERVER_BIN_DIR，預設 getDefaultBinDir()
  llamaServerBinPath?: string;     // 測試 hook：直接指定 exe 路徑（跳過下載）
}
```

### 8.2 移除自啟動區塊

```typescript
// 刪除 server.ts 末尾：
// if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { void main(); }
// main() 保留 export，改由 src/entry.ts 呼叫
export async function main(): Promise<void> { /* 原樣 */ }
```

- 同時移除 `import { pathToFileURL } from 'url'`（不再使用）。

### 8.3 Provider 模式解析

```typescript
export type ProviderMode = 'llama-server' | 'llamacpp' | 'mock' | 'openai';

export function resolveProviderMode(): ProviderMode {
  const v = process.env.LLM_PROVIDER;
  if (v === 'mock') return 'mock';
  if (v === 'llamacpp') return 'llamacpp';
  if (v === 'openai') return 'openai';
  return 'llama-server';   // 預設（含未設定）
}
```

### 8.4 startServer 流程修改

```typescript
const mode = resolveProviderMode();
const isMock = mode === 'mock';
const shouldOpenBrowser = options.openBrowser ?? envBool('OPEN_BROWSER', true);   // 新增 envBool helper
let modelReady = isMock || isModelDownloaded(modelUri, modelsDir);
let modelPath = isMock ? 'mock' : resolveModelPath(modelUri, modelsDir);
let llamaServer: LlamaServerManager | null = null;   // doShutdown 用

// ---- 模型下載流程（依 mode 切換）----
if (!modelReady) {
  if (shouldOpenBrowser) openBrowser(`${url}/download.html`);
  try {
    if (mode === 'llamacpp') {
      const { ensureModelDownloaded } = await import('./llamacpp.js');
      modelPath = await ensureModelDownloaded(modelUri, modelsDir, (d, t) =>
        broadcast({ type: 'MODEL_STATUS', state: 'downloading', stage: 'model', downloaded: d, total: t }));
    } else {
      modelPath = await downloadModelFile(modelUri, modelsDir, (d, t) =>
        broadcast({ type: 'MODEL_STATUS', state: 'downloading', stage: 'model', downloaded: d, total: t }));
    }
    modelReady = true;
    broadcast({ type: 'MODEL_STATUS', state: 'ready', stage: 'model' });
  } catch (err) { /* 既有錯誤處理 */ }
} else {
  broadcast({ type: 'MODEL_STATUS', state: 'ready', stage: 'model' });
}

// ---- dispatcher 建立（依 mode 切換）----
if (options.dispatcherFactory) {
  dispatcher = options.dispatcherFactory(modelPath);   // 測試 hook：跳過 sidecar
} else if (mode === 'llama-server') {
  // 1. 確保 llama-server.exe
  const binPath = options.llamaServerBinPath
    ?? await ensureLlamaServer({
        binDir: options.llamaServerBinDir,
        release: options.llamaServerRelease,
        onProgress: (d, t) => broadcast({ type: 'MODEL_STATUS', state: 'downloading', stage: 'llama-server', downloaded: d, total: t }),
      });
  // 2. 啟動 sidecar
  llamaServer = new LlamaServerManager({
    binPath, modelPath,
    port: options.llamaServerPort, host: options.llamaServerHost,
    ctxSize: options.llamaServerCtxSize, threads: options.llamaServerThreads,
    parallel: options.llamaServerParallel,
    // idleTimeout 已棄用（b10361 不支援 --idle-timeout），不傳
    onStatus: (status, info) => {
      if (status === 'ready') broadcast({ type: 'MODEL_STATUS', state: 'ready', stage: 'llama-server' });
      if (status === 'crashed') broadcast({ type: 'MODEL_STATUS', state: 'error', stage: 'llama-server', error: info ?? 'llama-server crashed' });
    },
  });
  try {
    const { port } = await llamaServer.start();
    dispatcher = new OpenAICompatibleDispatcher(
      new OpenAICompatibleProvider({ baseURL: `http://${options.llamaServerHost ?? DEFAULT_LLAMA_SERVER_HOST}:${port}/v1`, model: 'local' }));
  } catch (err) {
    broadcast({ type: 'MODEL_STATUS', state: 'error', stage: 'llama-server', error: ... });
    return handle;
  }
} else if (mode === 'llamacpp') {
  // exe 內 worker.js 不存在於 snapshot → new Worker 會 throw；
  // 包 try/catch 回報明確錯誤（不靜默失敗，見不變式 #2）
  try {
    dispatcher = new WorkerDispatcher({ modelPath });
  } catch (err) {
    broadcast({ type: 'MODEL_STATUS', state: 'error', stage: 'model',
      error: `packaged build 不支援 llamacpp 模式：${err instanceof Error ? err.message : String(err)}` });
    return handle;
  }
} else if (mode === 'openai') {
  dispatcher = new OpenAICompatibleDispatcher(new OpenAICompatibleProvider({
    baseURL: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL, apiKey: process.env.FREELLMAPI_API_KEY }));
} else {  // mock
  dispatcher = new MockDispatcher();   // 見 §8.5
}

try { await dispatcher.start(); } catch (err) { /* 既有錯誤處理 */ }
/* 其餘（scheduler/engine/lobby/autoClose）不動 */
```

### 8.5 MockDispatcher（新增於 server.ts 或 llm-dispatcher.ts）

```typescript
/** mock 模式用的 LLMDispatcher 包裝（MockProvider 不實作 LLMDispatcher） */
class MockDispatcher implements ServerLLM {
  private readonly provider = new MockProvider();
  async start(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async requestSpeech(_p: number, prompt: string): Promise<{ text: string }> {
    return { text: (await this.provider.chat([{ role: 'user', content: prompt }])).trim() };
  }
  async requestVote(_p: number, prompt: string): Promise<{ targetId: number }> {
    return { targetId: parseTargetId(await this.provider.chat([{ role: 'user', content: prompt }])) };
  }
  async requestNightAction(_p: number, prompt: string): Promise<{ targetId: number }> {
    return { targetId: parseTargetId(await this.provider.chat([{ role: 'user', content: prompt }])) };
  }
  async generate(prompt: string): Promise<string> {
    return (await this.provider.chat([{ role: 'user', content: prompt }])).trim();
  }
}
```

- 放 llm-dispatcher.ts（與 OpenAICompatibleDispatcher 同檔）。

### 8.6 doShutdown 修改

```typescript
async function doShutdown(reason: string): Promise<void> {
  /* 既有流程 */
  if (dispatcher) { try { await dispatcher.shutdown(); } catch {} }
  if (llamaServer) { try { await llamaServer.stop(); } catch {} }   // 新增：sidecar 停止
  /* 其餘不動 */
}
```

### 8.7 既有測試相容

- `dispatcherFactory` 保留 → server.test.ts / server-human.test.ts 的 `dispatcherFactory: () => mockDispatcher()` 不破（跳過 sidecar）。
- `isMock` 判斷改為 `mode === 'mock'`（原 `LLM_PROVIDER === 'mock'`）——行為等價。

---

## 9. entry.ts + package.json

### 9.1 src/entry.ts（新增）

```typescript
import { main } from './server.js';
void main();
```

### 9.2 package.json

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/entry.js",
    "test": "node --test --test-concurrency=1 ./dist/game-state.test.js ... ./dist/server-human.test.js ./dist/llm.test.js ./dist/model-download.test.js ./dist/llama-server.test.js",
    "build:pkg": "node scripts/build-pkg.mjs",
    "smoke:pkg": "node scripts/pkg-smoke.mjs"
  },
  "dependencies": {
    "@types/ws": "^8.18.1",
    "adm-zip": "^0.5.16",
    "node-llama-cpp": "^3.20.0",
    "ws": "^8.21.3"
  },
  "devDependencies": {
    "@types/node": "^26.4.0",
    "esbuild": "^0.24.0",
    "pkg": "^5.8.1",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

- `node-llama-cpp` 保留為 dependency（llamacpp 模式 dev 用；exe 不打包）。
- `adm-zip` 為 runtime dependency（exe 內解壓 llama-server zip 用；純 JS）。

---

## 10. 前端（download.html / download.js 小改）

### 10.1 download.js

```javascript
// MODEL_STATUS 處理加 stage 判斷：
if (msg.state === 'downloading') {
  statusEl.textContent = msg.stage === 'llama-server' ? '下載執行環境（llama-server）…' : '模型下載中…';
  /* 進度條邏輯不變 */
} else if (msg.state === 'ready') {
  // 兩階段皆 ready 才跳轉：llama-server ready 後仍會收到 model 的 downloading/ready
  // 實作：僅當 msg.stage === 'model' 且 state === 'ready' 才跳轉（model 是最後階段）
  if (msg.stage === 'model') { /* 既有跳轉邏輯 */ }
} else if (msg.state === 'error') { /* 既有邏輯 */ }
```

- 階段順序保證：server 依序廣播 `llama-server`（downloading→ready）→ `model`（downloading→ready）→ 最後 `model ready` 觸發跳轉。
- download.html 結構不動。

---

## 11. 打包（esbuild + pkg）

### 11.1 scripts/build-pkg.mjs

```javascript
// 1. 前置：npm run build（tsc）已產出 dist/
// 2. esbuild bundle
await $`npx esbuild src/entry.ts
  --bundle --platform=node --format=cjs --target=node18
  --outfile=dist-pkg/WerewolfGame.cjs
  --external:node-llama-cpp
  --external:./llamacpp.js
  --external:bufferutil
  --external:utf-8-validate
  --log-level=warning`;
// 3. 驗證：bundle 不含 node-llama-cpp
const bundle = fs.readFileSync('dist-pkg/WerewolfGame.cjs', 'utf-8');
if (bundle.includes('node-llama-cpp')) throw new Error('bundle 含 node-llama-cpp！');
// 4. pkg
await $`npx pkg dist-pkg/WerewolfGame.cjs --config pkg.config.json`;
// 5. 驗證產物存在
```

### 11.2 pkg.config.json

```json
{
  "pkg": {
    "targets": ["node18-win-x64"],
    "outputPath": "dist-pkg",
    "assets": [
      "public/**/*",
      "character/**/*",
      "package.json"
    ]
  }
}
```

- 產出：`dist-pkg/WerewolfGame.exe`（entry basename 命名）。
- **snapshot 佈局**：entry → `C:\snapshot\werewolf-game\dist-pkg\WerewolfGame.cjs`；assets → `C:\snapshot\werewolf-game\public`、`\character`。`getResourceRoot()`（`resolve(__dirname,'..')`）= `C:\snapshot\werewolf-game` ✓（不需改 utils.ts）。
- **Node 18 相容**：bundle 目標 node18；程式碼已確認無 Node 20+ API（fetch/randomUUID/rmSync/Readable.fromWeb 皆 Node 18 可用）。

### 11.3 exe 行為差異

| 項目 | dev | exe |
|---|---|---|
| getDataDir() | 專案根 | exe 旁 data/（不可寫 → %APPDATA%/WerewolfGame） |
| getResourceRoot() | 專案根 | snapshot 根（public/、character/ 唯讀） |
| llamacpp 模式 | 可用 | 動態 import 失敗 → 錯誤訊息「packaged build 不支援 llamacpp 模式」 |
| 模型下載 | downloadModelFile（純 fetch） | 同左（無 node-llama-cpp） |
| llama-server | 同左 | 同左 |

---

## 12. 測試規格

框架：node:test + node:assert（沿用）。`package.json` test script 擴充為 17 檔。

### 12.1 llm.test.ts（新增）

- OpenAICompatibleProvider 對本地 fake server（node http server，ephemeral port）：
  - 200 + choices[0].message.content → 回傳文字
  - HTTP 500 → throw（含 status）
  - 非 JSON → throw
  - 缺 content → throw
  - 連線拒絕（未 listen 的 port）→ throw「LLM 連線失敗」
  - 驗證請求 body：model / temperature / max_tokens 正確送出
- MockProvider：投票/夜晚/一般 prompt → 確定性回應

### 12.2 model-download.test.ts（新增）

- parseModelUri：`hf:Qwen/Qwen3-4B-GGUF:Qwen3-4B-Q4_K_M.gguf` → 正確 URL + fileName；`https://...` 直通；非法 URI → throw
- downloadModelFile（本地 http server 餵假 GGUF bytes，fetchImpl 注入）：
  - 檔案寫入正確內容（tmp → rename）
  - onProgress 被呼叫且最終 downloaded === total
  - 已存在精確檔名 → 跳過（server hit 數 0）
  - modelsDir 有任一 .gguf → 跳過
  - HTTP 404 → throw + tmp 清理
  - 中斷（server 中途斷線）→ throw + tmp 清理

### 12.3 llama-server.test.ts（新增）

- **fake binary**：測試用 node 腳本（寫入 temp 目錄），行為可參數化：
  - `--fake-mode healthy`：起 http server 於指定 port，/health 回 200 {"status":"ok"}
  - `--fake-mode crash`：立即 exit(1)
  - `--fake-mode slow`：5s 後才 /health 200
- LlamaServerManager：
  - start()：healthy fake → resolve { port, reused: false }
  - **重用**：先起一個 healthy fake server 於 port → manager.start() → { reused: true } 且 spawn 數 0
  - crash fake → start() reject（重啟耗盡）
  - slow fake → start() resolve（輪詢等待）
  - stop()：spawn 實例 → child 被殺；reused → no-op
  - port 被非 llama 程序佔用 → 依序試下一個 port
- ensureLlamaServer（fetchImpl 注入 + AdmZip 打包的假 zip）：
  - 下載 → 解壓 → exe 路徑回傳
  - 已存在 → 跳過下載
  - 404 → throw
- 整合（**skip 條件**：真實 llama-server.exe 不存在時 `t.skip()`）：spawn 真實 → /health → stop

### 12.4 server.test.ts 擴充 + pkg 冒煙

- **llama-server 模式整合**（新案例）：
  - 環境：LLM_PROVIDER 未設（預設 llama-server）+ `llamaServerBinPath` 指向 fake healthy binary + `modelsDir` 指向含假 .gguf 的 temp 目錄 + 不提供 dispatcherFactory
  - 斷言：server 啟動 → MODEL_STATUS ready → engine 建立 → WS 收到 snapshot
- **既有案例**：dispatcherFactory 提供 → 跳過 sidecar（不 spawn）→ 不破
- **scripts/pkg-smoke.mjs**（build:pkg 後執行）：
  1. 確認 dist-pkg/WerewolfGame.exe 存在
  2. spawn exe，env：`LLM_PROVIDER=mock`、`OPEN_BROWSER=0`、`PORT=0`、`ZERO_CLIENT_SHUTDOWN_MS=60000`
  3. 讀 stdout 等「啟動：http://localhost:PORT」→ 解析 port
  4. fetch `http://localhost:PORT/` → 200（驗證 public/ 資產從 snapshot 可讀）
  5. 以 `ws` 連線 → 收 SNAPSHOT → 等 discussionLog 出現 ≥1 則（驗證 character/ 從 snapshot 可讀 + engine + scheduler + ws 全鏈路）
  6. 送 SIGTERM → 等 exit → 斷言 exit code 0
  7. 失敗 → 印 exe stdout/stderr 尾部 → exit 1

### 12.5 回歸

- `npm test` 17 檔全綠
- `node driver.mjs mock-test` 跑通
- 手動：`npm start`（llama-server 模式）→ 全 AI 局跑完；`LLM_PROVIDER=llamacpp npm start` → 不破；`LLM_PROVIDER=mock npm start` → 直接開局

---

## 13. 實作順序與驗收標準

| 步驟 | 檔案 | 驗收標準 |
|---|---|---|
| 1 | llm.ts 拆分 + llamacpp.ts + driver.mjs + entry.ts + package.json start | tsc 通過；npm test 既有 14 檔全綠；`node dist/entry.js`（mock）可啟動 |
| 2 | model-download.ts + model-download.test.ts | 測試全綠；`node driver.mjs model` 行為不變（llamacpp 路徑） |
| 3 | worker-dispatcher.ts（export KIND_DEFAULTS）+ llm-dispatcher.ts + llama-server.ts + 兩檔測試 | llm.test.ts / llama-server.test.ts 全綠 |
| 4 | server.ts 整合（provider 切換、sidecar、OPEN_BROWSER、移除自啟動） | server.test.ts 既有 + 新增全綠；`npm start`（llama-server 模式）實機跑通 |
| 5 | download.js stage 支援 | 首次啟動兩階段進度顯示正確 |
| 6 | scripts/build-pkg.mjs + pkg.config.json + esbuild/pkg devDeps | `npm run build:pkg` 產出 WerewolfGame.exe（~37MB）；bundle 無 node-llama-cpp |
| 7 | scripts/pkg-smoke.mjs | `npm run smoke:pkg` 通過 |
| 8 | 收尾 | npm test 17 檔全綠；手動 exe 驗證（首次下載流程、重啟跳過下載、關閉停 sidecar、雙開重用） |

---

## 附錄 A：不可違反的不變式

1. **開發模式不破**：`npm start` / `node dist/entry.js` 三種 provider（llama-server / llamacpp / mock）皆可用；`LLM_PROVIDER` 切換是唯一開關。
2. **exe 不含 node-llama-cpp**：esbuild `--external:node-llama-cpp` + `--external:./llamacpp.js`；build 腳本驗證 bundle 無 `node-llama-cpp` 字樣。llamacpp 模式在 exe 中回報明確錯誤，不靜默失敗。
3. **寫入一律 getDataDir()**（models/、bin/、game-state.json）；**讀取一律 getResourceRoot()**（public/、character/）。pkg 下 getResourceRoot = snapshot 根（entry 位於 dist-pkg/ 子目錄，`resolve(__dirname,'..')` 正確）。
4. **llama-server 是共享資源**：/health 探測到健康實例 → 重用不 spawn；優雅關閉只殺本實例 spawn 的 child；孤兒由下次啟動重用＋零連線自動關閉兜底（b10361 無 --idle-timeout）。
5. **崩潰重啟 ≤ maxRestarts（3）**，backoff 1s/2s/4s；耗盡 → MODEL_STATUS error → shutdown。
6. **下載進度一律 MODEL_STATUS 廣播**（stage: 'llama-server' | 'model'）；download.html 驅動；模型下載純 fetch（無 node-llama-cpp）。
7. **模型檔相容**：`isModelDownloaded` 的「任一 .gguf」檢查保留（既有 hf_ 前綴檔不重複下載）；`resolveModelPath` 掃描邏輯不變。
8. **測試 hook 保留**：`dispatcherFactory` 提供時跳過 sidecar 管理（既有測試不破）。
9. **exe bundle 目標 node18**：不得引入 Node 20+ API；esbuild `--target=node18`。
10. **無新增 native 依賴**：adm-zip 純 JS；ws 既有。
11. **身分扁平化與遊戲不變式（Phase 0-2 附錄）全部沿用**：prompt/snapshot 無任何改動。
12. **sidecar 啟動失敗不進入遊戲**：MODEL_STATUS error → shutdown（不開局、不留半啟動狀態）。

## 附錄 B：Phase 3.5 預留（本階段不實作）

- **GPU 支援**：llama-server 目前用 CPU build（win-cpu-x64）；未來可依硬體偵測切換 `win-cuda-12.4-x64` / `win-vulkan-x64`（下載 URL 已是參數化模式，只需加偵測邏輯）。
- **模型選擇 UI**：首次啟動頁讓使用者選模型（Qwen3-4B / 更小模型如 Qwen3-1.7B）；`LLM_MODEL_URI` 已參數化。
- **自動更新**：llama-server release 版本檢查（`LLAMA_SERVER_RELEASE` 已參數化）。
- **exe 圖示/版本資訊**：pkg 支援 `--icon`；Windows 版本資訊需 resource 編輯器（如 rcedit）。
- **多實例互斥**：目前雙開會重用同一 sidecar 但各自開局（共用 3001 推理）；未來可加單實例鎖（named mutex）。