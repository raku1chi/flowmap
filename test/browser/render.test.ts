// ビューアの表示だけの処理を、手で作った graph.json で確かめる（探索をしないので速い）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHtml } from '../../src/render.js';
import { SCHEMA_VERSION, SIGNATURE_VERSION, type Edge, type Graph, type StateNode } from '../../src/types.js';
import { launch } from './helpers.js';

const node = (id: string, path: string, title: string, over: Partial<StateNode> = {}): StateNode => ({
  id, signature: `sig-${id}`, url: `http://app.test${path}`, title, depth: 1, screenshot: `shots/${id}.png`, textHash: 'h', headings: [],
  consoleErrors: [], failedRequests: [], actionsTotal: 0, actionsTried: 0, ...over,
});
const link = (from: string, to: string, label: string, href: string): Edge => ({ from, to, action: { label, kind: 'click', role: 'link', text: label, nth: 1, href } });

test('ビューア: ページ内のアンカー違いは別の実例に数えず、1 社しか撮っていない企業の画面も名前を〇〇にする', async () => {
  // 古い graph.json では、同じ企業のページ内リンク（#breakdown）で着いた状態が実例（samples）に入っている
  const company = 'あいおいニッセイ同和損害保険株式会社';
  const title = `${company}の残業時間・有給取得率（公的データ） — app`;
  const nodes = [
    node('s001', '/', 'トップ — app', { depth: 0, route: '/' }),
    node('s002', '/companies', '収録企業の一覧 — app', { route: '/companies', headings: ['収録企業の一覧'] }),
    node('s003', '/company/3011001027739', title, {
      depth: 2, route: '/company/*', headings: [company, 'ひと目でわかる数字'],
      samples: ['#breakdown', '#axis-time'].map((h) => ({ url: `http://app.test/company/3011001027739${h}`, title, heading: company })),
      mergedUrls: ['http://app.test/company/3011001027739#breakdown', 'http://app.test/company/3011001027739#axis-time'],
    }),
  ];
  const graph: Graph = {
    meta: { schemaVersion: SCHEMA_VERSION, signatureVersion: SIGNATURE_VERSION, baseUrl: 'http://app.test', startedAt: '2026-09-27T00:00:00.000Z', finishedAt: '2026-09-27T00:01:00.000Z', totalStates: 3, totalEdges: 2 },
    root: 's001',
    nodes,
    edges: [link('s001', 's002', '企業一覧', '/companies'), link('s002', 's003', company, '/company/3011001027739')],
  };
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent(buildHtml(graph, 'test'));
    await page.waitForFunction(() => !!(window as unknown as { __flowmap?: unknown }).__flowmap);
    const shown = await page.evaluate(() => {
      const f = (window as unknown as { __flowmap: { openMap(): void; E: { to: string; short: string }[] } }).__flowmap;
      f.openMap();
      return {
        titles: [...document.querySelectorAll('#nodes .item .title')].map((x) => x.textContent ?? ''),
        edge: f.E.find((d) => d.to === 's003')?.short,
        panel: document.body.textContent ?? '',
      };
    });
    assert.deepEqual(errors, []);
    assert.ok(shown.titles.includes('〇〇の残業時間・有給取得率（公的データ） — app'), shown.titles.join(' / '));
    assert.equal(shown.edge, '〇〇');
    assert.ok(!shown.panel.includes('ほか 2 件'), 'アンカー違いを別の実例に数えている');
  } finally {
    await browser.close();
  }
});
