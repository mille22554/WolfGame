/**
 * worker.ts — LLM worker thread 入口（tsc 編譯為 dist/worker.js）
 *
 * - 單一 worker 載入一份模型（node-llama-cpp），context 池有限平行
 * - 與主進程以 postMessage 通訊（協定見 types.ts）
 * - mock 模式（LLM_PROVIDER=mock）：不載入模型，用 MockProvider
 * - 崩潰由主進程（WorkerDispatcher）偵測並重啟
 */
import { parentPort } from 'worker_threads';
import { getLlama, LlamaChatSession, QwenChatWrapper } from 'node-llama-cpp';
import { MockProvider } from './llm.js';
function post(msg) {
    parentPort?.postMessage(msg);
}
function log(level, message) {
    post({ type: 'LOG', level, message });
}
let slots = [];
let queue = [];
let mockProvider = null;
let running = true;
function pump() {
    if (!running)
        return;
    if (mockProvider) {
        // mock 模式：序列化處理（一次一則，順序完成）
        if (queue.length === 0)
            return;
        const job = queue.shift();
        void runMockJob(job).finally(() => pump());
        return;
    }
    for (const slot of slots) {
        if (queue.length === 0)
            break;
        if (slot.busy)
            continue;
        const job = queue.shift();
        slot.busy = true;
        void runSlotJob(slot, job)
            .catch((err) => {
            post({
                type: 'RESULT',
                jobId: job.jobId,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            });
        })
            .finally(() => {
            slot.busy = false;
            pump();
        });
    }
}
async function runMockJob(job) {
    try {
        const text = await mockProvider.chat([{ role: 'user', content: job.prompt }], {
            temperature: job.temperature,
            maxTokens: job.maxTokens,
        });
        post({ type: 'RESULT', jobId: job.jobId, ok: true, text });
    }
    catch (err) {
        post({
            type: 'RESULT',
            jobId: job.jobId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
async function runSlotJob(slot, job) {
    // 無狀態架構：每個 prompt 自包含完整上下文，slot 的 chat history 必須每 job 重置。
    // 否則 history 無限累積 → prefill 越來越長 → 弱 GPU 上單次 batch 超過 Windows TDR（~2s）
    // → device lost（stage 2 長程會議連續崩潰，stage 1 因呼叫少未觸發）。
    slot.session.resetChatHistory();
    const text = await slot.session.prompt(job.prompt, {
        temperature: job.temperature,
        maxTokens: job.maxTokens,
    });
    post({ type: 'RESULT', jobId: job.jobId, ok: true, text });
}
async function handleInit(modelPath, contextSize, contextCount) {
    if (process.env.LLM_PROVIDER === 'mock') {
        mockProvider = new MockProvider();
        post({ type: 'READY' });
        pump();
        return;
    }
    try {
        const llama = await getLlama();
        const model = await llama.loadModel({ modelPath });
        for (let i = 0; i < contextCount; i++) {
            const context = await model.createContext({ contextSize });
            const session = new LlamaChatSession({
                contextSequence: context.getSequence(),
                chatWrapper: new QwenChatWrapper({ variation: '3', thoughts: 'discourage' }),
            });
            slots.push({ session, busy: false });
        }
        post({ type: 'READY' });
        pump();
    }
    catch (err) {
        log('error', `模型載入失敗（${modelPath}）：${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
parentPort?.on('message', (msg) => {
    switch (msg.type) {
        case 'INIT':
            void handleInit(msg.modelPath, msg.contextSize, msg.contextCount);
            break;
        case 'JOB':
            queue.push(msg.job);
            pump();
            break;
        case 'SHUTDOWN':
            running = false;
            queue = [];
            process.exit(0);
            break;
    }
});
//# sourceMappingURL=worker.js.map