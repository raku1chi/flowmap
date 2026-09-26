// 正解ラベル付きのケースを、動いているアプリ（8787 とデモ 3210）から組み立てて flowmap-out/jev/dataset.json に書き出す。
// Jev は呼ばないので API キーは要らない。画面は開いてクリックするだけで、送信や削除は押さない。
//
//   pnpm exec tsx experiments/jev/capture.ts

import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Snapshot } from '../../src/inpage.js';
import { learnDataSegments, normalizeRoute, signatureOf, type NormalizeContext } from '../../src/normalize.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import {
  ACTION_CASES, APPS, LEARNED_PREFIXES, LIVE_LINK_GROUPS, PAGE_PAIRS, SYNTHETIC_LINK_GROUPS,
  type Dataset, type DatasetCase, type PageRef,
} from './cases.js';
import { clip, contextFor, decode, pairState, pathOf, settle, stableSnapshot } from './page.js';

const OUT_DIR = resolve('flowmap-out/jev');

async function take(page: Page, ref: PageRef): Promise<Snapshot> {
  await page.goto(new URL(ref.url, APPS[ref.app]).href, { waitUntil: 'domcontentloaded' });
  await settle(page);
  if (ref.click) {
    await page.click(ref.click, { timeout: 4000 });
    await settle(page);
  }
  return stableSnapshot(page);
}

/** 現行の flowmap がこのリンク群を 1 つのデータ区間として合流させるか */
function linksMergeMechanically(origin: string, pageUrl: string, hrefs: string[]): boolean {
  const ctx: NormalizeContext = contextFor(origin, []);
  const base = new URL(pageUrl, origin).href;
  learnDataSegments(hrefs, base, ctx, DEFAULT_CONFIG.autoPathRulesMinSiblings);
  const routes = hrefs.map((h) => normalizeRoute(new URL(h, base).href, ctx)?.route);
  return routes.every((r) => r !== undefined && r === routes[0]);
}

const cases: DatasetCase[] = [];
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: DEFAULT_CONFIG.viewport, locale: 'ja-JP', acceptDownloads: false });
// tsx(esbuild) が挿入する __name ヘルパーはブラウザに無いので恒等関数を置く（CLAUDE.md 参照）
await context.addInitScript(() => { (globalThis as unknown as { __name?: unknown }).__name ??= (f: unknown) => f; });
const page = await context.newPage();
// 別タブが開いたら閉じる（最初のページを作ってから登録する）
context.on('page', (p) => { if (p !== page) p.close().catch(() => {}); });
page.on('dialog', (d) => { d.dismiss().catch(() => {}); });

try {
  // links（実画面）
  for (const g of LIVE_LINK_GROUPS) {
    const snap = await take(page, { app: g.app, url: g.pageUrl });
    const seen = new Set<string>();
    const links: { label: string; href: string }[] = [];
    for (const a of snap.actions) {
      if (!a.href) continue;
      const href = decode(a.href);
      if (!g.pick.test(href) || seen.has(href)) continue;
      seen.add(href);
      links.push({ label: clip(a.label), href });
      if (links.length >= g.max) break;
    }
    if (links.length < 2) throw new Error(`${g.id}: リンクが ${links.length} 件しか見つかりません（${g.pageUrl}）`);
    cases.push({
      id: `links/${g.id}`, experiment: 'links', truth: g.truth, note: g.note, source: 'live', lang: 'ja',
      baseline: linksMergeMechanically(APPS[g.app], g.pageUrl, links.map((l) => l.href)),
      state: { page: { title: snap.title, heading: snap.headings[0] ?? '', url: pathOf(snap.url) }, links },
    });
    console.log(`links/${g.id}: ${links.length} 件`);
  }

  // links（架空）
  for (const g of SYNTHETIC_LINK_GROUPS) {
    cases.push({
      id: `links/${g.id}`, experiment: 'links', truth: g.truth, note: g.note, source: 'synthetic', lang: 'ja',
      baseline: linksMergeMechanically(g.origin, g.page.url, g.links.map((l) => l.href)),
      state: { page: g.page, links: g.links },
    });
  }

  // pages
  for (const p of PAGE_PAIRS) {
    const a = await take(page, p.a);
    const b = await take(page, p.b);
    const ctx = contextFor(APPS[p.a.app], LEARNED_PREFIXES[p.a.app]);
    cases.push({
      id: `pages/${p.id}`, experiment: 'pages', truth: p.truth, note: p.note, source: 'live', lang: 'ja',
      baseline: signatureOf(a, ctx).signature === signatureOf(b, ctx).signature,
      state: pairState(a, b, ctx),
    });
    console.log(`pages/${p.id}: 操作 ${a.actions.length} / ${b.actions.length}`);
  }
} finally {
  await browser.close();
}

// actions
const deny = DEFAULT_CONFIG.denyText.map((t) => t.toLowerCase());
for (const c of ACTION_CASES) {
  cases.push({
    id: `actions/${c.id}`, experiment: 'actions', truth: c.truth, note: '', source: 'synthetic', lang: c.lang,
    baseline: deny.some((t) => c.label.toLowerCase().includes(t)),
    state: { page: c.page, element: c.element, label: c.label },
  });
}

mkdirSync(OUT_DIR, { recursive: true });
const dataset: Dataset = { createdAt: new Date().toISOString(), cases };
const out = join(OUT_DIR, 'dataset.json');
writeFileSync(out, JSON.stringify(dataset, null, 2));
const sizes = cases.map((c) => JSON.stringify(c.state).length);
console.log(`\n${cases.length} 件を書き出しました: ${out}`);
console.log(`state の大きさ（文字数）: 最大 ${Math.max(...sizes)} / 平均 ${Math.round(sizes.reduce((s, n) => s + n, 0) / sizes.length)}`);
