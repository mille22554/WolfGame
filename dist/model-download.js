/**
 * model-download.ts — 純 fetch GGUF 下載器（無 node-llama-cpp）
 */
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
/** 'hf:owner/repo:file' → HF resolve URL；'https://...' 直通 */
export function parseModelUri(uri) {
    if (uri.startsWith('hf:')) {
        const rest = uri.slice(3); // 'owner/repo:file'
        const colon = rest.lastIndexOf(':');
        if (colon <= 0)
            throw new Error(`無效 hf URI：${uri}`);
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
export async function downloadModelFile(uri, modelsDir, onProgress, fetchImpl = fetch) {
    const { url, fileName } = parseModelUri(uri);
    if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
    }
    const target = path.join(modelsDir, fileName);
    if (fs.existsSync(target))
        return target;
    // 向後相容：既有 hf_ 前綴檔（任一 .gguf）即視為已下載
    try {
        const entries = fs.readdirSync(modelsDir);
        const found = entries.find((e) => e.toLowerCase().endsWith('.gguf'));
        if (found)
            return path.join(modelsDir, found);
    }
    catch {
        /* fallthrough：繼續下載 */
    }
    const res = await fetchImpl(url);
    if (!res.ok) {
        throw new Error(`下載失敗（HTTP ${res.status}）`);
    }
    const total = Number(res.headers.get('content-length') ?? 0);
    const tmp = target + '.tmp';
    let downloaded = 0;
    try {
        if (!res.body)
            throw new Error('下載失敗：回應無 body');
        const source = Readable.fromWeb(res.body);
        const dest = fs.createWriteStream(tmp);
        dest.on('data', () => undefined);
        // 手動計數：監聽 source data
        source.on('data', (chunk) => {
            downloaded += chunk.length;
            onProgress?.(downloaded, total);
        });
        await pipeline(source, dest);
        // content-length 未提供時補一次最終回呼
        onProgress?.(downloaded, total);
        fs.renameSync(tmp, target);
        return target;
    }
    catch (err) {
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch {
            /* ignore */
        }
        throw err;
    }
}
//# sourceMappingURL=model-download.js.map