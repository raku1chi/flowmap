// ブラウザを使うテストの共通部品。Chromium は FLOWMAP_CHROMIUM_PATH があればそれを使う（本体と同じ）。

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function launch(): Promise<Browser> {
  return chromium.launch({ executablePath: process.env.FLOWMAP_CHROMIUM_PATH || undefined });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export interface Demo {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

/** デモアプリを空いているポートで起動する。外部サイトのリンクは別オリジン（127.0.0.1）の同じサーバーに向ける（ネットワークに出ない） */
export async function startDemo(env: Record<string, string> = {}): Promise<Demo> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ['demo/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DEMO_EXTERNAL_URL: `http://127.0.0.1:${port}/external-site`, ...env },
    stdio: 'ignore',
  });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${url}/api/version`);
      if (r.ok) break;
    } catch { /* まだ起動していない */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    port,
    stop: () => new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill(); }),
  };
}
