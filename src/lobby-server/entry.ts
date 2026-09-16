/**
 * entry.ts — 多房大廳 server 入口（ubuntu 分支）
 *
 * PORT env（預設 2640）；SIGINT/SIGTERM → 乾淨關閉。
 */
import { createLobbyServer } from './server.js';

const port = Number(process.env.PORT) || 2640;

createLobbyServer({ port }).then((h) => {
  console.log(`[lobby-server] listening on ${h.url} (public: ubuntu-web/)`);
  const shutdown = (): void => {
    console.log('[lobby-server] shutting down');
    void h.shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}).catch((e) => {
  console.error('[lobby-server] failed to start', e);
  process.exit(1);
});
