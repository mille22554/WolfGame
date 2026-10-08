/**
 * LLM Client — SGLang (Qwen3.8-27B) HTTP client
 *
 * 同機 localhost:9090，Bearer auth。
 * OpenAI-compatible /v1/chat/completions API。
 */
const SGLANG_HOST = process.env.SGLANG_HOST ?? '127.0.0.1';
const SGLANG_PORT = process.env.SGLANG_PORT ?? '9090';
const SGLANG_API_KEY = process.env.SGLANG_API_KEY ?? '';
const LLM_MODEL = process.env.LLM_MODEL ?? 'qwen3.8-27b';
/** Qwen3.8 reasoning variant（xhigh / medium / low）；per-call 未指定時的 fallback，僅對目前 process 的請求生效 */
const LLM_REASONING_EFFORT = process.env.LLM_REASONING_EFFORT ?? '';
/**
 * 呼叫 SGLang /v1/chat/completions，回傳 assistant 回覆文字。
 * 不設 timeout：等待 LLM 回傳（reasoning model 長 prompt 可能 >60s）。
 * 失敗回 null。
 */
export async function chat(messages, options = {}) {
    const { temperature = 1.0, priority, reasoningEffort } = options;
    try {
        const body = {
            model: LLM_MODEL,
            messages,
            temperature,
        };
        // 逐次指定（reasoningEffort）優於 env LLM_REASONING_EFFORT；兩者皆無則不送
        const effort = reasoningEffort || LLM_REASONING_EFFORT;
        if (effort)
            body.reasoning_effort = effort;
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SGLANG_API_KEY}`,
        };
        if (priority !== undefined)
            headers['x-override-priority'] = String(priority);
        const res = await fetch(`http://${SGLANG_HOST}:${SGLANG_PORT}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            console.error(`[llm] SGLang error ${res.status}: ${await res.text()}`);
            return null;
        }
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        return content ?? null;
    }
    catch (err) {
        console.error('[llm] error:', err);
        return null;
    }
}
//# sourceMappingURL=llm.js.map