// デモアプリを実際に探索して、探索エンジンの約束を確かめる。
//   - 同じ画面を重複して撮らない（表示設定が localStorage に残っても、検索欄に候補が開いても）
//   - 並列数によらず結果（ノード id・シグネチャ・辺）が同じ
//   - 押してはいけない操作（ログアウト・削除・退会）を押さない
//   - 前回との差分とゲートが働く（壊れた API で新エラーと消失が出る）
//   - 生成したビューアがエラーなく開く

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { explore } from '../../src/explore.js';
import { render } from '../../src/render.js';
import { evaluateGate } from '../../src/report.js';
import type { FlowmapConfig, Graph } from '../../src/types.js';
import { launch, startDemo, type Demo } from './helpers.js';

let demo: Demo;
let outDir: string;
let first: { runDir: string; graph: Graph };

const configFor = (baseUrl: string, over: Partial<FlowmapConfig> = {}): FlowmapConfig => ({
  ...DEFAULT_CONFIG,
  baseUrl,
  outDir,
  maxStates: 40,
  maxDepth: 5,
  maxActionsPerState: 20,
  fill: { ...DEFAULT_CONFIG.fill, search: 'ノート' },
  ...over,
});

const quietLog = () => {};

before(async () => {
  demo = await startDemo();
  outDir = mkdtempSync(join(tmpdir(), 'flowmap-e2e-'));
  first = await explore({ config: configFor(demo.url, { workers: 4 }), log: quietLog });
});

after(async () => { await demo?.stop(); });

const routesOf = (g: Graph, route: string | undefined) => g.nodes.filter((n) => n.route === route);

test('同じ画面を重複して撮らない（見えている状態が同じノードは 1 つだけ）', () => {
  const g = first.graph;
  const key = (n: Graph['nodes'][number]) => JSON.stringify([n.route ?? n.url, n.dialog ?? '', n.headings, n.expanded ?? []]);
  const seen = new Map<string, string>();
  for (const n of g.nodes) {
    const k = key(n);
    assert.ok(!seen.has(k), `同じ状態が 2 つのノードに分かれました: ${seen.get(k)} と ${n.id}（${k}）`);
    seen.set(k, n.id);
  }
  assert.equal(g.edges.filter((e) => e.error).length, 0, JSON.stringify(g.edges.filter((e) => e.error), null, 1));
  assert.ok(g.nodes.length >= 15 && g.nodes.length <= 22, `画面数 ${g.nodes.length}`);
});

test('データの画面は 1 つに合流し、データ区間を学習する', () => {
  const g = first.graph;
  assert.equal(routesOf(g, '/items/*').length, 1, '商品詳細');
  assert.equal(routesOf(g, '/categories/*').length, 1, 'カテゴリの一覧');
  assert.equal(routesOf(g, '/items').length, 1, '商品一覧（ページ送り・表示順の違いを含む）');
  assert.equal(routesOf(g, '/search').length, 1, '検索結果');
  assert.ok(g.meta.learnedPathRules?.includes('/categories/*'));
  const detail = routesOf(g, '/items/*')[0];
  assert.ok((detail.samples?.length ?? 0) >= 1, '別の商品の実例を残す');
});

test('モーダル・タブ・開閉は別の状態として撮り、別タブのリンクと外部サイトも辿る', () => {
  const g = first.graph;
  assert.ok(g.nodes.some((n) => n.dialog === 'ヘルプ'));
  assert.ok(g.nodes.some((n) => n.dialog === '保存しました'));
  assert.ok(g.nodes.some((n) => n.route === '/' && n.expanded?.includes('表示順: 標準')));
  assert.equal(routesOf(g, '/settings').filter((n) => !n.dialog).length, 3, '設定の 3 つのタブ');
  assert.equal(routesOf(g, '/items/*/print').length, 1, 'target=_blank の印刷用ページ');
  assert.ok(g.nodes.some((n) => n.truncated === '外部サイト' && n.url.startsWith('http://127.0.0.1')));
  assert.ok(g.nodes.some((n) => n.route === '/thanks'), 'フォームを自動入力して送信できる');
  const about = routesOf(g, '/about')[0];
  assert.ok(about.consoleErrors.some((e) => e.includes('想定外のエラー')), '画面が変わらない操作のエラーもその画面に残す');
  const report = routesOf(g, '/report')[0];
  assert.ok(report.failedRequests.some((e) => e.startsWith('500 GET')));
});

test('共通のナビゲーションは他の画面での結果から推定し、押す回数を減らす', () => {
  const g = first.graph;
  assert.ok(g.edges.some((e) => e.inferred), '推定した辺がある');
  assert.ok((g.meta.stats?.inferredEdges ?? 0) > 20);
  assert.ok((g.meta.stats?.attempts ?? 999) < 110, `試行 ${g.meta.stats?.attempts}`);
});

test('押してはいけない操作を押さない（ログアウト・削除・退会）', async () => {
  const state = (await (await fetch(`${demo.url}/api/state`)).json()) as { loggedIn: boolean; deletedCount: number; items: unknown[]; messages: unknown[] };
  assert.equal(state.loggedIn, true);
  assert.equal(state.deletedCount, 0);
  assert.equal(state.items.length, 12);
  assert.ok(state.messages.length >= 1, 'お問い合わせは送信している');
});

test('並列数によらず同じ結果になり、前回との差分は出ない', async () => {
  const second = await explore({ config: configFor(demo.url, { workers: 2 }), log: quietLog });
  const shape = (g: Graph) => ({
    nodes: g.nodes.map((n) => [n.id, n.signature, n.depth]),
    edges: g.edges.map((e) => [e.from, e.to, e.action.role, e.action.label, e.action.nth, !!e.inferred, !!e.error]),
  });
  assert.deepEqual(shape(second.graph), shape(first.graph));
  const d = second.graph.diff!;
  assert.equal(d.previousRun, first.runDir.split(/[\\/]/).pop());
  assert.deepEqual([d.added.length, d.removed.length, d.changed.length, d.newErrors.length], [0, 0, 0, 0], JSON.stringify(d.warning));
  assert.equal(d.warning, undefined);
});

test('壊れた API は新エラーと消失として出て、ゲートに掛かる', async () => {
  const broken = await startDemo({ DEMO_BREAK: '1' });
  try {
    const r = await explore({ config: configFor(broken.url, { workers: 4, baseline: first.runDir }), log: quietLog });
    const d = r.graph.diff!;
    assert.ok(d.newErrors.length >= 1, 'items の取得失敗が新エラーになる');
    assert.ok(d.removed.length >= 1, '商品詳細などが消失になる');
    const gate = evaluateGate(r.graph, ['new-errors', 'removed']);
    assert.equal(gate.failed, true);
  } finally {
    await broken.stop();
  }
});

test('ビューアがエラーなく開き、主な表示を切り替えられる', async () => {
  const out = render(first.runDir);
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pathToFileURL(out).href);
    await page.waitForFunction(() => !!(window as unknown as { __flowmap?: unknown }).__flowmap);
    const count = await page.locator('#nodes .item').count();
    assert.ok(count >= 10, `描いたノード ${count}`);
    await page.evaluate(() => {
      const f = (window as unknown as { __flowmap: { openIssues(): void; goHome(): void; openMap(): void; scenarios: { id: string }[]; openFlow(id: string, k: number): void; chapters: { id: string }[]; openChapter(id: string): void } }).__flowmap;
      f.openIssues(); f.goHome(); f.openMap();
      if (f.scenarios.length) f.openFlow(f.scenarios[0].id, 1);
      if (f.chapters.length > 1) f.openChapter(f.chapters[1].id);
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
