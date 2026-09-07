/**
 * worker.ts — LLM worker thread 入口（tsc 編譯為 dist/worker.js）
 *
 * - 單一 worker 載入一份模型（node-llama-cpp），context 池有限平行
 * - 與主進程以 postMessage 通訊（協定見 types.ts）
 * - mock 模式（LLM_PROVIDER=mock）：不載入模型，用 MockProvider
 * - 崩潰由主進程（WorkerDispatcher）偵測並重啟
 */
export {};
//# sourceMappingURL=worker.d.ts.map