// Jev（任意の補助）の経路が壊れていないことを、API をモックして確かめる。実際の typesafe.ai には送らない。
//   - 危険と判定された操作は押さず、ノードに記録する
//   - 答えはキャッシュされ、2 回目は問い合わせない
//   - 既定では画面の合流・データ区間の判定を聞かない（同定を外部の判定に依存させない）

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { explore } from '../../src/explore.js';
import { JEV_ENDPOINT } from '../../src/jev.js';
import type { FlowmapConfig } from '../../src/types.js';
import { startDemo, type Demo } from './helpers.js';

let demo: Demo;
let outDir: string;
const realFetch = globalThis.fetch;
const asked: string[] = [];

before(async () => {
  demo = await startDemo();
  outDir = mkdtempSync(join(tmpdir(), 'flowmap-jev-'));
  process.env.TYPESAFE_API_KEY = 'test-key';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== JEV_ENDPOINT) return realFetch(input, init);
    const body = JSON.parse(String(init?.body)) as { model: string; state: unknown; questions: Record<string, unknown> };
    const state = body.state as { label?: string; links?: unknown; page_a?: unknown };
    asked.push(state && typeof state === 'object' ? (state.label !== undefined ? 'actions' : state.links ? 'links' : state.page_a ? 'pages' : 'other') : 'check');
    const v = state && typeof state === 'object' && typeof state.label === 'string' && state.label.includes('保存') ? 0.92 : 0.05;
    const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: 'noul', noul: v }]));
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.TYPESAFE_API_KEY;
  await demo?.stop();
});

const config = (): FlowmapConfig => ({
  ...DEFAULT_CONFIG,
  baseUrl: demo.url,
  outDir,
  maxDepth: 2,
  maxStates: 30,
  jev: { ...DEFAULT_CONFIG.jev, enabled: true },
});

test('危険と判定された操作は押さず、答えはキャッシュする', async () => {
  const r = await explore({ config: config(), log: () => {} });
  const settings = r.graph.nodes.find((n) => n.route === '/settings' && !n.dialog && n.headings.includes('一般設定'))!;
  assert.ok(settings.jevSkipped?.some((k) => k.label === '保存する'), JSON.stringify(settings.jevSkipped));
  assert.ok(!r.graph.nodes.some((n) => n.dialog === '保存しました'), '押さなかったので保存のモーダルは無い');
  assert.ok((r.graph.meta.jev?.skippedActions ?? 0) >= 1);
  assert.ok(existsSync(join(outDir, 'jev-cache.json')));
  assert.ok(!asked.includes('pages') && !asked.includes('links'), '既定では合流とデータ区間の判定を聞かない');

  const before2 = asked.length;
  const again = await explore({ config: config(), log: () => {} });
  assert.equal(again.graph.meta.jev?.requests, 0, '2 回目はキャッシュから答える');
  assert.ok((again.graph.meta.jev?.cacheHits ?? 0) > 0);
  assert.equal(asked.length - before2, 1, '接続確認だけ問い合わせる');
  assert.deepEqual(again.graph.nodes.map((n) => n.signature), r.graph.nodes.map((n) => n.signature));
});
