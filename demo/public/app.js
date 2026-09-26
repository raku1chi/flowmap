// pushState ルーティングの素朴な SPA。flowmap の設計要素を一通り踏むための画面と、実アプリで探索を惑わせた仕掛けを持つ。
//  - ヘッダの「表示順」は localStorage に保存され、summary に今の値が出る（起点を開き直しても残る）
//  - ヘッダの検索欄は入力すると候補が開く（押していないフォームまで埋めると画面が変わる）
//  - 商品一覧はページ送り（?page=）と、業種ならぬカテゴリ（/categories/<名前>）の一覧を持つ
const app = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');
const EXTERNAL_URL = document.querySelector('meta[name="demo-external"]')?.content || 'https://example.com/';
const PAGE_SIZE = 6;

const routes = [
  { re: /^\/$/, view: home },
  { re: /^\/items$/, view: items },
  { re: /^\/items\/(\d+)$/, view: itemDetail },
  { re: /^\/items\/(\d+)\/print$/, view: itemPrint },
  { re: /^\/categories\/([^/]+)$/, view: category },
  { re: /^\/search$/, view: search },
  { re: /^\/contact$/, view: contact },
  { re: /^\/thanks$/, view: thanks },
  { re: /^\/settings$/, view: settings },
  { re: /^\/report$/, view: report },
  { re: /^\/about$/, view: about },
];

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function navigate(path) {
  history.pushState({}, '', path);
  render();
}

// ---- 表示順（localStorage に保存） ----
const PREFS = { standard: '標準', stock: '在庫あり優先', cheap: '価格の安い順' };
const getPref = () => { try { return localStorage.getItem('demo.pref') || 'standard'; } catch { return 'standard'; } };
function drawPref() {
  document.getElementById('pref-label').textContent = PREFS[getPref()];
  document.getElementById('pref-options').innerHTML = Object.entries(PREFS)
    .map(([k, v]) => `<button type="button" class="ghost${k === getPref() ? ' on' : ''}" data-pref="${k}">${v}</button>`).join('');
}
document.getElementById('pref-options').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pref]');
  if (!b) return;
  localStorage.setItem('demo.pref', b.dataset.pref);
  drawPref();
  render({ keepPref: true });
});
function sortItems(list) {
  const pref = getPref();
  if (pref === 'stock') return [...list].sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0) || a.id - b.id);
  if (pref === 'cheap') return [...list].sort((a, b) => a.price - b.price);
  return list;
}

async function render(opts = {}) {
  modalRoot.innerHTML = '';
  if (!opts.keepPref) document.getElementById('pref').open = false;
  drawPref();
  hideSuggest();
  const path = location.pathname;
  document.querySelectorAll('.top nav a').forEach((a) => a.classList.toggle('active', path.startsWith(a.getAttribute('href'))));
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) { await r.view(m); return; }
  }
  document.title = '見つかりません - Inventory Demo';
  app.innerHTML = `<h1>ページが見つかりません</h1><p class="muted">${esc(path)}</p><a class="btn" href="/" data-link>トップへ戻る</a>`;
}

// ---- 画面 ----
function home() {
  document.title = 'ダッシュボード - Inventory Demo';
  app.innerHTML = `
    <h1>ダッシュボード</h1>
    <div class="card">
      <p>flowmap のデモアプリです。ヘッダのリンクとボタンから各画面に遷移できます。</p>
      <div class="row">
        <a class="btn" href="/items" data-link>商品一覧を見る</a>
        <button id="open-help" class="ghost">ヘルプを開く</button>
        <button class="ghost" data-flowmap-ignore id="secret">flowmap に無視される操作</button>
      </div>
    </div>
    <div class="card">
      <h2>外部リンク</h2>
      <a href="${esc(EXTERNAL_URL)}">外部サイトを開く</a> ・
      <a href="mailto:support@example.com">メールで問い合わせ</a>
    </div>`;
  document.getElementById('open-help').addEventListener('click', () => openModal('ヘルプ', '商品は一覧から詳細に進めます。お問い合わせフォームは送信すると完了画面に遷移します。'));
  document.getElementById('secret').addEventListener('click', () => alert('ignored'));
}

async function loadItems() {
  const res = await fetch('/api/items');
  if (!res.ok) {
    console.error(`商品一覧の取得に失敗しました: ${res.status}`);
    app.innerHTML = `<h1>商品一覧</h1><div class="card"><p class="err">商品を読み込めませんでした（${res.status}）</p><a class="btn ghost" href="/" data-link>トップへ戻る</a></div>`;
    return undefined;
  }
  return sortItems(await res.json());
}

const itemTable = (list) => `
  <table>
    <thead><tr><th>ID</th><th>商品名</th><th>価格</th><th>在庫</th><th></th></tr></thead>
    <tbody>${list.map((i) => `
      <tr>
        <td>${i.id}</td><td>${esc(i.name)}</td><td>¥${i.price.toLocaleString()}</td><td>${i.stock}</td>
        <td><a href="/items/${i.id}" data-link>詳細</a></td>
      </tr>`).join('')}
    </tbody>
  </table>`;

async function items() {
  document.title = '商品一覧 - Inventory Demo';
  const list = await loadItems();
  if (!list) return;
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number(new URLSearchParams(location.search).get('page')) || 1));
  const cats = await (await fetch('/api/categories')).json();
  const pager = Array.from({ length: pages }, (_, i) => i + 1)
    .map((p) => (p === page ? `<b>${p}</b>` : `<a href="/items?page=${p}" data-link>${p}</a>`)).join(' ');
  app.innerHTML = `
    <h1>商品一覧</h1>
    <p class="muted">${list.length} 件中 ${(page - 1) * PAGE_SIZE + 1}〜${Math.min(page * PAGE_SIZE, list.length)} 件（表示順: ${PREFS[getPref()]}）</p>
    <p class="row">カテゴリ: ${cats.map((c) => `<a href="/categories/${encodeURIComponent(c)}" data-link>${esc(c)}</a>`).join(' ')}</p>
    ${itemTable(list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE))}
    <p class="pager">ページ: ${page > 1 ? `<a href="/items?page=${page - 1}" data-link>前へ</a> ` : ''}${pager}${page < pages ? ` <a href="/items?page=${page + 1}" data-link>次へ</a>` : ''}</p>`;
}

async function category([, raw]) {
  const name = decodeURIComponent(raw);
  document.title = `${name} - Inventory Demo`;
  const list = await loadItems();
  if (!list) return;
  const inCat = list.filter((i) => i.category === name);
  app.innerHTML = `
    <h1>${esc(name)}の商品</h1>
    <p class="muted">${inCat.length} 件</p>
    ${itemTable(inCat)}
    <p><a href="/items" data-link>すべての商品へ</a></p>`;
}

async function itemDetail([, id]) {
  const res = await fetch(`/api/items/${id}`);
  if (!res.ok) { app.innerHTML = `<h1>商品が見つかりません</h1><a class="btn" href="/items" data-link>一覧へ</a>`; document.title = '商品なし - Inventory Demo'; return; }
  const item = await res.json();
  document.title = `${item.name} - Inventory Demo`;
  app.innerHTML = `
    <h1>商品詳細</h1>
    <div class="card">
      <p><strong style="font-size:18px">${esc(item.name)}</strong></p>
      <p>ID: ${item.id} / カテゴリ: <a href="/categories/${encodeURIComponent(item.category)}" data-link>${esc(item.category)}</a> / 価格: ¥${item.price.toLocaleString()} / 在庫: ${item.stock}</p>
      ${item.stock === 0 ? '<p class="err">在庫切れ</p>' : ''}
      <div class="row">
        <a class="btn ghost" href="/items" data-link>一覧へ戻る</a>
        <a class="btn ghost" href="/items/${item.id}/print" target="_blank">印刷用ページを開く</a>
        <button id="delete" class="danger">この商品を削除</button>
      </div>
    </div>`;
  document.getElementById('delete').addEventListener('click', async () => {
    if (!confirm('本当に削除しますか？')) return;
    await fetch(`/api/items/${id}`, { method: 'DELETE' });
    navigate('/items');
  });
}

async function itemPrint([, id]) {
  const res = await fetch(`/api/items/${id}`);
  const item = res.ok ? await res.json() : { name: '不明な商品', price: 0, stock: 0 };
  document.title = `印刷用 ${item.name} - Inventory Demo`;
  app.innerHTML = `<h1>印刷用ページ</h1><div class="card"><p><strong>${esc(item.name)}</strong></p><p>価格: ¥${item.price.toLocaleString()} / 在庫: ${item.stock}</p><button id="print" class="ghost">印刷する</button></div>`;
  document.getElementById('print').addEventListener('click', () => {});
}

async function search() {
  const q = new URLSearchParams(location.search).get('q') ?? '';
  document.title = '検索結果 - Inventory Demo';
  const list = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
  app.innerHTML = `
    <h1>「${esc(q)}」の検索結果</h1>
    ${list.length ? itemTable(list) : '<div class="card"><p class="muted">該当する商品はありません。</p></div>'}`;
}

function contact() {
  document.title = 'お問い合わせ - Inventory Demo';
  app.innerHTML = `
    <h1>お問い合わせ</h1>
    <form id="contact-form" class="card">
      <label for="email">メールアドレス</label>
      <input id="email" name="email" type="email" required />
      <label for="subject">件名</label>
      <input id="subject" name="subject" type="text" required />
      <label for="kind">種別</label>
      <select id="kind" name="kind"><option value="">選択してください</option><option value="bug">不具合</option><option value="other">その他</option></select>
      <label for="body">内容</label>
      <textarea id="body" name="body" rows="3"></textarea>
      <label class="check"><input type="checkbox" name="agree" required /> 個人情報の取り扱いに同意する</label>
      <div class="row" style="margin-top:12px">
        <button type="submit">送信する</button>
        <button type="button" id="clear" class="ghost">クリア</button>
      </div>
    </form>`;
  const form = document.getElementById('contact-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    await fetch('/api/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    navigate('/thanks');
  });
  document.getElementById('clear').addEventListener('click', () => form.reset());
}

function thanks() {
  document.title = '送信完了 - Inventory Demo';
  app.innerHTML = `<h1>送信しました</h1><div class="card"><p>お問い合わせを受け付けました。</p><a class="btn" href="/" data-link>トップへ</a></div>`;
}

function settings() {
  document.title = '設定 - Inventory Demo';
  const tabs = { general: '一般設定', notify: '通知設定', danger: '危険な操作' };
  const bodies = {
    general: `<label>表示名</label><input name="displayName" type="text" value="demo user" /><label>言語</label><select name="lang"><option>日本語</option><option>English</option></select><div style="margin-top:12px"><button id="save">保存する</button></div>`,
    notify: `<label><input type="checkbox" name="mail" checked style="width:auto" /> メール通知を受け取る</label><label><input type="checkbox" name="push" style="width:auto" /> プッシュ通知を受け取る</label>`,
    danger: `<p class="muted">アカウントに関する取り消せない操作です。</p><button class="danger" id="withdraw">退会する</button>`,
  };
  let current = 'general';
  const draw = () => {
    app.innerHTML = `
      <h1>設定</h1>
      <div class="tabs" role="tablist">
        ${Object.entries(tabs).map(([k, v]) => `<button role="tab" aria-selected="${k === current}" data-tab="${k}">${v}</button>`).join('')}
      </div>
      <div class="card" role="tabpanel"><h2>${tabs[current]}</h2>${bodies[current]}</div>`;
    app.querySelectorAll('[role=tab]').forEach((b) => b.addEventListener('click', () => { current = b.dataset.tab; draw(); }));
    app.querySelector('#save')?.addEventListener('click', () => openModal('保存しました', '設定を保存しました。'));
    app.querySelector('#withdraw')?.addEventListener('click', () => { alert('退会処理が走りました（デモ）'); });
  };
  draw();
}

async function report() {
  document.title = 'レポート - Inventory Demo';
  app.innerHTML = `<h1>レポート</h1><div class="card"><p id="status">集計を読み込んでいます…</p></div>`;
  const res = await fetch('/api/report');
  if (!res.ok) {
    console.error(`レポート API が失敗しました: ${res.status}`);
    document.getElementById('status').innerHTML = `<span class="err">集計を取得できませんでした（${res.status}）</span> <button id="retry" class="ghost">再試行</button>`;
    document.getElementById('retry').addEventListener('click', () => render());
  }
}

async function about() {
  document.title = 'このアプリについて - Inventory Demo';
  const { version } = await (await fetch('/api/version')).json();
  app.innerHTML = `
    <h1>このアプリについて</h1>
    <div class="card">
      <p>flowmap の探索対象として用意したデモです。</p>
      <p class="muted">バージョン ${esc(version)}</p>
      <details><summary>バージョン情報を表示</summary><p>Inventory Demo v0.1.0</p></details>
      <button id="crash" class="ghost">わざとエラーを出す</button>
    </div>`;
  document.getElementById('crash').addEventListener('click', () => { throw new Error('ユーザー操作で発生した想定外のエラー'); });
}

function openModal(title, text) {
  modalRoot.innerHTML = `
    <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="mt">
      <div class="dialog">
        <h2 id="mt">${esc(title)}</h2>
        <p>${esc(text)}</p>
        <div class="row"><button id="modal-close">閉じる</button></div>
      </div>
    </div>`;
  document.getElementById('modal-close').addEventListener('click', () => { modalRoot.innerHTML = ''; });
}

// ---- ヘッダの検索（入力すると候補が開く） ----
const searchForm = document.getElementById('search-form');
const suggest = document.getElementById('suggest');
function hideSuggest() { suggest.hidden = true; suggest.innerHTML = ''; }
searchForm.q.addEventListener('input', async () => {
  const q = searchForm.q.value.trim();
  if (!q) { hideSuggest(); return; }
  const list = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
  suggest.innerHTML = list.length
    ? list.slice(0, 5).map((i) => `<a href="/items/${i.id}" data-link>${esc(i.name)}</a>`).join('')
    : '<span class="muted">該当する商品はありません</span>';
  suggest.hidden = false;
});
searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = searchForm.q.value.trim();
  searchForm.q.value = '';
  navigate(`/search?q=${encodeURIComponent(q)}`);
});

// ---- 配線 ----
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  app.innerHTML = '<h1>ログアウトしました</h1>';
});
const pad = (n) => String(n).padStart(2, '0');
setInterval(() => { const d = new Date(); document.getElementById('clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }, 1000);
window.addEventListener('popstate', () => render());
render();
