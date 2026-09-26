// ブラウザ内で動く関数（操作対象の列挙・範囲を絞った自動入力・落ち着き待ち）の検証。固定の HTML を使う。

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { fillScopeInBrowser, installTracker, NAME_SHIM, snapshotInBrowser, type EnumerateOptions } from '../../src/inpage.js';
import { Session } from '../../src/session.js';
import { launch } from './helpers.js';

const OPTS: EnumerateOptions = {
  denyText: DEFAULT_CONFIG.denyText,
  denySelectors: DEFAULT_CONFIG.denySelectors,
  denyUrlPatterns: DEFAULT_CONFIG.denyUrlPatterns,
  allowSubmit: true,
  volatileSelectors: DEFAULT_CONFIG.volatileSelectors,
};

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

async function open(html: string, routes: Record<string, (url: URL) => Promise<{ body: string; delay?: number }>> = {}): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript(NAME_SHIM);
  await context.addInitScript(installTracker, { hideSelectors: ['.cookie-banner'], volatileSelectors: DEFAULT_CONFIG.volatileSelectors });
  await context.route('http://fixture.test/**', async (route) => {
    const url = new URL(route.request().url());
    const handler = routes[url.pathname];
    if (handler) {
      const r = await handler(url);
      if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
      return route.fulfill({ status: 200, contentType: 'application/json', body: r.body });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  });
  const page = await context.newPage();
  await page.goto('http://fixture.test/page');
  return page;
}

test('操作対象の列挙: 除外・覆われた要素・無効・shadow DOM・開閉・ナビゲーション・volatile', async () => {
  const page = await open(`<!doctype html><html><body>
    <header><nav><a href="/items">商品一覧</a><a href="/logout">ログアウトする</a></nav>
      <details><summary>表示順: 標準</summary><button>在庫あり優先</button></details>
      <button aria-haspopup="menu" aria-expanded="false">メニュー</button></header>
    <main>
      <h1>一覧</h1>
      <button>保存する</button><button disabled>送れない</button><button>アカウントを削除</button>
      <button data-flowmap-ignore>無視される</button>
      <a href="mailto:x@example.com">メール</a>
      <div data-flowmap-volatile><a href="/items/9">最近見た: マウス</a><h2>おすすめ</h2></div>
      <x-card></x-card>
      <div class="cookie-banner" style="position:fixed;inset:0;background:#fff">同意する <button>OK</button></div>
    </main>
    <script>
      customElements.define('x-card', class extends HTMLElement {
        connectedCallback() { const r = this.attachShadow({ mode: 'open' }); r.innerHTML = '<button>shadow の中</button>'; }
      });
    </script>
  </body></html>`);
  const snap = await page.evaluate(snapshotInBrowser, OPTS);
  const labels = snap.actions.map((a) => a.label);
  assert.ok(labels.includes('商品一覧'));
  assert.ok(labels.includes('保存する'));
  assert.ok(labels.includes('shadow の中'), 'shadow DOM の中も辿る');
  for (const denied of ['ログアウトする', '送れない', 'アカウントを削除', '無視される', 'メール', 'OK']) assert.ok(!labels.includes(denied), denied);
  const summary = snap.actions.find((a) => a.role === 'summary')!;
  assert.equal(summary.toggle, true);
  assert.equal(summary.inNav, true);
  assert.equal(snap.actions.find((a) => a.label === 'メニュー')!.toggle, true);
  assert.equal(snap.actions.find((a) => a.label === '最近見た: マウス')!.volatile, true);
  assert.deepEqual(snap.headings, ['一覧'], 'volatile の中の見出しは入れない');
  await page.context().close();
});

test('ダイアログ・選択中のタブ・開いた開閉を読み取る', async () => {
  const page = await open(`<!doctype html><html><body>
    <div role="tablist"><button role="tab" aria-selected="false">一般</button><button role="tab" aria-selected="true">通知 (3)</button></div>
    <details open><summary>詳細</summary><p>中身</p></details>
    <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff"><h2>保存しました</h2><button>閉じる</button></div>
  </body></html>`);
  const snap = await page.evaluate(snapshotInBrowser, OPTS);
  assert.equal(snap.dialog, '保存しました');
  assert.deepEqual(snap.selectedTabs, ['通知 (3)']);
  assert.deepEqual(snap.expanded, ['詳細']);
  // ダイアログに覆われたタブは押せない
  assert.deepEqual(snap.actions.map((a) => a.label), ['閉じる']);
  await page.context().close();
});

test('自動入力は押すボタンのフォームだけ。値のある項目・他のフォーム・選択済みの select は触らない', async () => {
  const page = await open(`<!doctype html><html><body>
    <form id="search" role="search"><input type="search" name="q"><button id="go">検索</button></form>
    <form id="contact">
      <input type="email" name="email"><input type="text" name="subject" value="既存">
      <select name="kind"><option value="">選択してください</option><option value="bug">不具合</option></select>
      <select name="lang"><option>日本語</option><option>English</option></select>
      <input type="number" name="qty" min="5">
      <input type="text" name="zip" maxlength="3">
      <input type="checkbox" name="agree" required><input type="checkbox" name="news">
      <input type="radio" name="plan" value="a" required><input type="radio" name="plan" value="b">
      <textarea name="body"></textarea>
      <button id="send">送信</button>
    </form>
    <div class="panel"><input name="free"><button id="apply" type="button">適用</button></div>
  </body></html>`);
  const mark = async (id: string) => page.evaluate((sel) => { document.querySelectorAll('[data-flowmap-target]').forEach((e) => e.removeAttribute('data-flowmap-target')); document.querySelector(sel)!.setAttribute('data-flowmap-target', '1'); }, `#${id}`);
  const fill = { ...DEFAULT_CONFIG.fill, 'name=zip': '1000001' };
  await mark('send');
  await page.evaluate(fillScopeInBrowser, fill);
  const v = await page.evaluate(() => {
    const f = document.querySelector('#contact') as HTMLFormElement;
    const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value;
    return {
      email: val('email'), subject: val('subject'), kind: val('kind'), lang: val('lang'), qty: val('qty'), zip: val('zip'), body: val('body'),
      agree: (f.elements.namedItem('agree') as HTMLInputElement).checked, news: (f.elements.namedItem('news') as HTMLInputElement).checked,
      plan: (f.querySelector('input[name=plan]:checked') as HTMLInputElement | null)?.value ?? null,
      q: (document.querySelector('#search input') as HTMLInputElement).value,
      free: (document.querySelector('.panel input') as HTMLInputElement).value,
    };
  });
  assert.deepEqual(v, { email: DEFAULT_CONFIG.fill.email, subject: '既存', kind: 'bug', lang: '日本語', qty: '5', zip: '100', body: DEFAULT_CONFIG.fill.text, agree: true, news: false, plan: 'a', q: '', free: '' });
  // フォームの外のボタンは、近い祖先の入力欄だけを埋める
  await mark('apply');
  await page.evaluate(fillScopeInBrowser, fill);
  assert.equal(await page.evaluate(() => (document.querySelector('.panel input') as HTMLInputElement).value), DEFAULT_CONFIG.fill.text);
  assert.equal(await page.evaluate(() => (document.querySelector('#search input') as HTMLInputElement).value), '');
  await page.context().close();
});

test('落ち着き待ち: 通信の後に描画する画面でも描画が終わってから読む', async () => {
  const session = new Session(browser, {
    config: { ...DEFAULT_CONFIG, baseUrl: 'http://fixture.test/page' },
    enumerate: OPTS,
    ctx: { origin: 'http://fixture.test', pathRules: [], learnedPrefixes: new Set(), queryParams: 'ignore', structuralParams: [] },
  });
  const page = await session.fresh();
  await page.context().route('http://fixture.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/list') {
      await new Promise((r) => setTimeout(r, 700));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['a', 'b', 'c']) });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body><h1>一覧</h1><ul id="list"></ul>
      <script>setTimeout(async () => { const xs = await (await fetch('/api/list')).json(); setTimeout(() => { document.getElementById('list').innerHTML = xs.map((x) => '<li><a href="/items/' + x + '">' + x + '</a></li>').join(''); }, 150); }, 100);</script>
    </body></html>` });
  });
  const settled = await session.gotoRoot();
  const snap = await session.stableSnapshot(settled);
  assert.equal(settled, true);
  assert.deepEqual(snap.actions.map((a) => a.label), ['a', 'b', 'c']);
  await session.close();
});
