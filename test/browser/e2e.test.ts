// デモアプリを実際に探索して、探索エンジンの約束を確かめる。
//   - 同じ画面を重複して撮らない（表示設定が localStorage に残っても、検索欄に候補が開いても）
//   - 画面の中で完結する変化（開閉・比較トレイ）は別の画面にせず、現れた操作は続けて押して探索する
//   - 比較トレイが開いたまま他の画面に移っても、既存の画面に合流する
//   - 外部サイトは撮らず、リンクの一覧だけ残す
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
  assert.ok(g.nodes.length >= 14 && g.nodes.length <= 20, `画面数 ${g.nodes.length}`);
});

test('データの画面は 1 つに合流し、データ区間を学習する', () => {
  const g = first.graph;
  assert.equal(routesOf(g, '/items/*').length, 1, '商品詳細');
  assert.equal(routesOf(g, '/categories/*').length, 1, 'カテゴリの一覧');
  assert.equal(routesOf(g, '/items').length, 1, '商品一覧（ページ送り・表示順の違いを含む）');
  assert.equal(routesOf(g, '/search').length, 1, '検索結果');
  assert.ok(g.meta.learnedPathRules?.includes('/categories/*'));
  assert.ok(g.meta.learnedQueryVariants?.includes('/items'), 'ページ送りのクエリ違いを学習する');
  const detail = routesOf(g, '/items/*')[0];
  assert.ok((detail.samples?.length ?? 0) >= 1, '別の商品の実例を残す');
});

test('モーダルとタブは別の画面にし、別タブのリンクも辿る。外部サイトは撮らずにリンクだけ残す', () => {
  const g = first.graph;
  assert.ok(g.nodes.some((n) => n.dialog === 'ヘルプ'));
  assert.ok(g.nodes.some((n) => n.dialog === '保存しました'));
  assert.equal(routesOf(g, '/settings').filter((n) => !n.dialog).length, 3, '設定の 3 つのタブ');
  assert.equal(routesOf(g, '/items/*/print').length, 1, 'target=_blank の印刷用ページ');
  assert.ok(!g.nodes.some((n) => n.truncated === '外部サイト'), '外部サイトは撮らない');
  assert.ok(g.nodes.find((n) => n.id === g.root)!.externalLinks?.some((l) => l.href.startsWith('http://127.0.0.1')));
  assert.ok(g.nodes.some((n) => n.route === '/thanks'), 'フォームを自動入力して送信できる');
  const about = routesOf(g, '/about')[0];
  assert.ok(about.consoleErrors.some((e) => e.includes('想定外のエラー')), '画面が変わらない操作のエラーもその画面に残す');
  const report = routesOf(g, '/report')[0];
  assert.ok(report.failedRequests.some((e) => e.startsWith('500 GET')));
});

test('開閉と比較トレイは画面の中の操作として記録し、現れた操作を続けて押して比較ページに着く', () => {
  const g = first.graph;
  assert.ok(!g.nodes.some((n) => n.expanded?.length), '開閉を開いた状態を別の画面にしない');
  const root = g.nodes.find((n) => n.id === g.root)!;
  const pref = root.localActions?.find((l) => l.action.toggle);
  assert.ok(pref?.changed && pref.revealed?.includes('在庫あり優先'), JSON.stringify(root.localActions));
  const items = routesOf(g, '/items')[0];
  const add = items.localActions?.find((l) => l.pattern === '*を比較に追加');
  assert.ok(add, JSON.stringify(items.localActions));
  assert.ok(add.count >= 2 && add.tried === 1, '一覧の各行の同じボタンは 1 件だけ押す');
  assert.ok(add.revealed?.includes('比較ページで開く'));
  assert.ok(add.screenshot, '変化のあとの画面を 1 枚だけ撮る');
  const compare = routesOf(g, '/compare');
  assert.ok(compare.length >= 1 && compare.length <= 2, `比較ページ ${compare.length}（商品ありと空）`);
  const via = g.edges.find((e) => e.to === compare[0].id && e.via?.length);
  assert.ok(via && /を比較に追加$/.test(via.via![0].label) && via.action.label === '比較ページで開く', '「比較に追加 → 比較ページで開く」で着く');
});

test('比較トレイが開いたまま他の画面に移っても、既存の画面に合流する', () => {
  const g = first.graph;
  for (const route of ['/', '/items', '/contact', '/about', '/report', '/search', '/items/*']) {
    assert.equal(routesOf(g, route).filter((n) => !n.dialog).length, 1, route);
  }
  assert.ok((g.meta.stats?.variantJoins ?? 0) >= 1);
});

test('共通のナビゲーションは他の画面での結果から推定し、押す回数を減らす', () => {
  const g = first.graph;
  assert.ok(g.edges.some((e) => e.inferred), '推定した辺がある');
  assert.ok((g.meta.stats?.inferredEdges ?? 0) > 20);
  assert.ok((g.meta.stats?.attempts ?? 999) < 125, `試行 ${g.meta.stats?.attempts}`);
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
    nodes: g.nodes.map((n) => [n.id, n.signature, n.depth, (n.localActions ?? []).map((l) => [l.key, l.tried, l.changed])]),
    edges: g.edges.map((e) => [e.from, e.to, e.action.role, e.action.label, e.action.nth, !!e.inferred, !!e.error, (e.via ?? []).map((v) => v.label)]),
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
    const rootId = first.graph.root;
    const panelText = await page.evaluate((root) => {
      const f = (window as unknown as { __flowmap: { openIssues(): void; goHome(): void; openMap(): void; scenarios: { id: string }[]; openFlow(id: string, k: number): void; chapters: { id: string }[]; openChapter(id: string, selectId?: string): void } }).__flowmap;
      f.openIssues(); f.goHome(); f.openMap();
      if (f.scenarios.length) f.openFlow(f.scenarios[0].id, 1);
      if (f.chapters.length > 1) f.openChapter(f.chapters[1].id);
      f.openChapter(root, root);
      return document.getElementById('panel')!.textContent ?? '';
    }, rootId);
    assert.deepEqual(errors, []);
    assert.match(panelText, /この画面の中の操作/);
    assert.match(panelText, /外部リンク（撮影していません）/);

    // 商品名（データ）は画面名・辺のラベル・フロー名・この画面の中の操作に出さず、〇〇にする
    const itemsId = routesOf(first.graph, '/items')[0].id;
    const shown = await page.evaluate((items) => {
      const f = (window as unknown as { __flowmap: { openMap(): void; openChapter(id: string, selectId?: string): void; E: { short: string; error?: string }[]; scenarios: { name: string }[] } }).__flowmap;
      f.openMap();
      const titles = [...document.querySelectorAll('#nodes .item .title')].map((x) => x.textContent ?? '');
      f.openChapter(items, items);
      const panel = document.getElementById('panel')!.textContent ?? '';
      const local = panel.slice(panel.indexOf('この画面の中の操作'), panel.indexOf('ここへ来る操作'));
      return { texts: [...titles, ...f.E.filter((d) => !d.error).map((d) => d.short), ...f.scenarios.map((s) => s.name)], local };
    }, itemsId);
    const names = ['ノートPC', 'モニター', 'キーボード', 'デスクトップPC', 'マウス', 'Web カメラ', 'ヘッドセット', 'USB ハブ', 'ケーブルセット'];
    const leaked = shown.texts.filter((t) => names.some((n) => t.includes(n)));
    assert.deepEqual(leaked, [], '商品名がそのまま出ている');
    assert.ok(shown.texts.some((t) => t.includes('〇〇')));
    assert.match(shown.local, /〇〇を比較に追加/);
    assert.match(shown.local, /〇〇を外す/);
    assert.ok(!names.some((n) => shown.local.includes(n)), shown.local);
  } finally {
    await browser.close();
  }
});
