// flowmap デモ用の小さな SPA サーバー。ビルド不要で `node demo/server.mjs` だけで動く。
// 静的ファイル + JSON API + SPA フォールバック（未知のパスは index.html を返す）。
//
//   PORT=3210                     待ち受けるポート
//   DEMO_BREAK=1                  商品 API を壊す（flowmap の差分: 新エラー・消失・追加を見せる）
//   DEMO_EXTERNAL_URL=<URL>       「外部サイト」リンクの行き先（既定 https://example.com/。テストでは別オリジンのローカル URL を渡す）
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 3210);
const EXTERNAL_URL = process.env.DEMO_EXTERNAL_URL ?? 'https://example.com/';
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const CATEGORIES = ['パソコン', 'ディスプレイ', '周辺機器', 'アクセサリ'];
// インメモリの状態。探索で「削除」「ログアウト」が押されると壊れる（= 押されていないことの証拠になる）。
const state = {
  items: [
    { id: 1, name: 'ノートPC', category: 'パソコン', price: 128000, stock: 4 },
    { id: 2, name: 'モニター 27"', category: 'ディスプレイ', price: 42000, stock: 11 },
    { id: 3, name: 'キーボード', category: '周辺機器', price: 9800, stock: 0 },
    { id: 4, name: 'デスクトップPC', category: 'パソコン', price: 158000, stock: 2 },
    { id: 5, name: 'モニター 24"', category: 'ディスプレイ', price: 26800, stock: 7 },
    { id: 6, name: 'マウス', category: '周辺機器', price: 3980, stock: 25 },
    { id: 7, name: 'USB ハブ', category: 'アクセサリ', price: 2480, stock: 0 },
    { id: 8, name: 'ノートPC スタンド', category: 'アクセサリ', price: 4580, stock: 9 },
    { id: 9, name: 'Web カメラ', category: '周辺機器', price: 6980, stock: 3 },
    { id: 10, name: 'モバイルモニター', category: 'ディスプレイ', price: 31800, stock: 1 },
    { id: 11, name: 'ヘッドセット', category: '周辺機器', price: 8800, stock: 6 },
    { id: 12, name: 'ケーブルセット', category: 'アクセサリ', price: 1980, stock: 40 },
  ],
  messages: [],
  loggedIn: true,
  deletedCount: 0,
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // ---- API ----
  // DEMO_BREAK=1 で起動すると商品 API が壊れる。flowmap の差分（新エラー・消失・追加）を見せるためのスイッチ
  if (p === '/api/items' && req.method === 'GET') return process.env.DEMO_BREAK ? json(res, 500, { error: 'items service down' }) : json(res, 200, state.items);
  if (p === '/api/categories') return json(res, 200, CATEGORIES);
  if (p === '/api/search') {
    const q = (url.searchParams.get('q') ?? '').trim();
    return json(res, 200, q ? state.items.filter((i) => i.name.includes(q)) : []);
  }
  const m = p.match(/^\/api\/items\/(\d+)$/);
  if (m && req.method === 'GET') {
    const item = state.items.find((i) => i.id === Number(m[1]));
    return item ? json(res, 200, item) : json(res, 404, { error: 'not found' });
  }
  if (m && req.method === 'DELETE') {
    state.items = state.items.filter((i) => i.id !== Number(m[1]));
    state.deletedCount++;
    return json(res, 200, { ok: true });
  }
  if (p === '/api/contact' && req.method === 'POST') {
    const body = await readBody(req);
    state.messages.push({ ...body, at: new Date().toISOString() });
    return json(res, 201, { ok: true, count: state.messages.length });
  }
  if (p === '/api/report') return json(res, 500, { error: 'report service unavailable' }); // 失敗リクエストのデモ
  if (p === '/api/logout' && req.method === 'POST') { state.loggedIn = false; return json(res, 200, { ok: true }); }
  if (p === '/api/version') return json(res, 200, { version: process.env.DEMO_BREAK ? '0.2.0-rc1' : '0.1.0' });
  if (p === '/api/state') return json(res, 200, state); // 検証用
  if (p.startsWith('/api/')) return json(res, 404, { error: 'no such api' });

  // ---- 静的ファイル / SPA フォールバック ----
  let file = normalize(p).replace(/^\/+/, '');
  if (!file || !extname(file)) file = 'index.html';
  try {
    let data = await readFile(join(PUBLIC, file));
    if (file === 'index.html') data = Buffer.from(data.toString('utf8').replace('__EXTERNAL_URL__', EXTERNAL_URL.replace(/"/g, '&quot;')));
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

server.listen(PORT, () => console.log(`demo app: http://localhost:${PORT}`));
