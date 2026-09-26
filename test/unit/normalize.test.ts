import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionKey, externalRoute, isIdLike, isLocalChange, labelKey, lineMatcher, normalizeDigits, normalizeRoute, pageData, planActions, proposeDataSegments,
  proposeQueryVariantPaths, scrub, signatureOf, structureDiff, variantOf, type NormalizeContext,
} from '../../src/normalize.js';
import type { RawAction, Snapshot } from '../../src/inpage.js';

const ctx = (over: Partial<NormalizeContext> = {}): NormalizeContext => ({
  origin: 'http://app.test',
  pathRules: [],
  learnedPrefixes: new Set<string>(),
  queryParams: 'ignore',
  structuralParams: [],
  dataParams: [],
  ...over,
});

let idx = 0;
const act = (label: string, over: Partial<RawAction> = {}): RawAction => ({ role: 'button', label, text: label, kind: 'click', nth: 1, index: idx++, ...over });
const link = (label: string, href: string, over: Partial<RawAction> = {}): RawAction => act(label, { role: 'link', href, ...over });

const snap = (url: string, over: Partial<Snapshot> = {}): Snapshot => ({
  url,
  title: 't',
  headings: [],
  headingTags: [],
  actions: [],
  formFields: [],
  bodyText: '',
  selectedTabs: [],
  expanded: [],
  hasPassword: false,
  ...over,
});

test('normalizeDigits は桁区切りと小数を 1 つの数にする', () => {
  assert.equal(normalizeDigits('1,234 件 / 4.5 点'), '# 件 / # 点');
});

test('isIdLike: 数字・UUID・ハッシュ・長いトークンは ID、語は ID でない', () => {
  for (const s of ['12', '6010601048836', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', '5f1d7a9c3b2e', '01HZX3M9K2Q8W7E6R5T4Y3U2I1', 'S100TR7I', 'B08N5WRWNW', 'V1StGXR8_Z5jdHi6B-myT']) assert.ok(isIdLike(s), s);
  for (const s of ['v2', 'item-12', 'settings', 'サービス業', 'deadbeef', 'abcdefabcdef']) assert.ok(!isIdLike(s), s);
});

test('normalizeRoute: ID の区間はデータ（*）になり、データの画面として扱う', () => {
  const r = normalizeRoute('http://app.test/items/12', ctx())!;
  assert.equal(r.route, '/items/*');
  assert.ok(r.dataDriven);
  assert.deepEqual(r.dataValues, ['12']);
  assert.equal(normalizeRoute('http://app.test/v2/help', ctx())!.route, '/v#/help');
  assert.equal(normalizeRoute('http://other.test/items/1', ctx()), undefined);
});

test('normalizeRoute: クエリは既定で見ない。structuralParams は値を、dataParams はデータとして残す', () => {
  assert.equal(normalizeRoute('http://app.test/items?page=2&sort=price', ctx())!.route, '/items');
  assert.equal(normalizeRoute('http://app.test/settings?tab=notify', ctx({ structuralParams: ['tab'] }))!.route, '/settings?tab=notify');
  const r = normalizeRoute('http://app.test/item?id=abc', ctx({ dataParams: ['id'] }))!;
  assert.equal(r.route, '/item?id=*');
  assert.ok(r.dataDriven);
  assert.equal(normalizeRoute('http://app.test/search?q=x&page=2', ctx({ queryParams: 'names' }))!.route, '/search?page&q');
  assert.equal(normalizeRoute('http://app.test/search?q=x', ctx({ queryParams: 'values' }))!.route, '/search?q=x');
});

test('normalizeRoute: pathRules と学習済みの区間、ハッシュルーティング', () => {
  assert.equal(normalizeRoute('http://app.test/users/hanako/posts', ctx({ pathRules: [{ pattern: '^/users/[^/]+', replace: '/users/*' }] }))!.route, '/users/*/posts');
  const c = ctx();
  c.learnedPrefixes.add('/companies');
  const r = normalizeRoute('http://app.test/companies/%E5%B0%8F%E5%A3%B2%E6%A5%AD', c)!;
  assert.equal(r.route, '/companies/*');
  assert.deepEqual(r.dataValues, ['小売業']);
  assert.equal(normalizeRoute('http://app.test/#/users/42', ctx())!.route, '/#/users/*');
  assert.equal(normalizeRoute('http://app.test/page#section', ctx())!.route, '/page');
});

test('externalRoute はホストと ID を潰したパスだけを見る', () => {
  assert.equal(externalRoute('https://docs.example.com/doc/S100ABCD1234/view?x=1'), '//docs.example.com/doc/*/view');
});

test('proposeDataSegments: 1 区間だけ違う同じ形のリンクが 3 本以上あれば候補にする', () => {
  const items = ['/companies/サービス業', '/companies/小売業', '/companies/情報・通信業'].map((href) => ({ href }));
  const [p] = proposeDataSegments(items, 'http://app.test/companies', ctx());
  assert.equal(p.prefix, '/companies');
  assert.equal(proposeDataSegments(items.slice(0, 2), 'http://app.test/', ctx()).length, 0);
});

test('proposeDataSegments: ナビゲーションの中の語だけのリンク（設定の各セクション）は候補にしない', () => {
  const nav = ['/settings/profile', '/settings/security', '/settings/billing', '/settings/notifications'].map((href) => ({ href, inNav: true }));
  assert.equal(proposeDataSegments(nav, 'http://app.test/settings', ctx()).length, 0);
  const inMain = nav.map((x) => ({ ...x, inNav: false }));
  assert.equal(proposeDataSegments(inMain, 'http://app.test/settings', ctx()).length, 1);
});

test('proposeDataSegments: 先頭の区間とハッシュの先頭区間は対象にしない', () => {
  const top = ['/about', '/contact', '/help', '/terms'].map((href) => ({ href }));
  assert.equal(proposeDataSegments(top, 'http://app.test/', ctx()).length, 0);
});

test('actionKey: リンクは行き先のルート、開閉はラベルを見ない、外部はホストだけ', () => {
  assert.equal(actionKey({ role: 'link', label: 'ノートPC', href: '/items/1' }, 'http://app.test/items', ctx(), []), 'link|/items/*');
  assert.equal(actionKey({ role: 'summary', label: '表示順: 標準', toggle: true }, 'http://app.test/', ctx(), []), 'summary|~');
  assert.equal(actionKey({ role: 'link', label: 'EDINET', href: 'https://disclosure.example.jp/doc/123' }, 'http://app.test/', ctx(), []), 'link|//disclosure.example.jp');
  assert.equal(actionKey({ role: 'button', label: '3 件を表示' }, 'http://app.test/', ctx(), []), 'button|# 件を表示');
});

test('scrub はデータの値を消す（2 文字以上、数字だけの値は消さない）', () => {
  assert.equal(scrub('サービス業の企業一覧', ['サービス業']), '*の企業一覧');
  assert.equal(scrub('2 件', ['2']), '2 件');
  // 値の中の数字もテキストと同じように潰して比べる
  assert.equal(scrub(normalizeDigits('モニター 27" の詳細'), ['モニター 27"']), '* の詳細');
});

test('planActions: 同じ形は maxPerPattern 件まで、形ごとに順繰り', () => {
  const xs = ['a1', 'a2', 'a3', 'a4', 'b1', 'c1', 'c2'];
  assert.deepEqual(planActions(xs, (x) => x[0], 2), ['a1', 'b1', 'c1', 'a2', 'c2']);
  assert.deepEqual(planActions(xs, (x) => x[0], 0), ['a1', 'b1', 'c1', 'a2', 'c2', 'a3', 'a4']);
});

// ---------- シグネチャ（§5） ----------

const header = [link('トップ', '/'), link('商品一覧', '/items'), act('表示順: 標準', { role: 'summary', toggle: true })];

test('開閉のラベルに出る今の値（表示設定）が変わってもシグネチャは同じ', () => {
  const a = signatureOf(snap('http://app.test/', { actions: [...header], headings: ['ダッシュボード'], headingTags: ['h1'] }), ctx());
  const changed = header.map((x) => (x.toggle ? { ...x, label: '表示順: 在庫あり優先' } : x));
  const b = signatureOf(snap('http://app.test/', { actions: changed, headings: ['ダッシュボード'], headingTags: ['h1'] }), ctx());
  assert.equal(a.signature, b.signature);
});

test('一覧の件数・ページ送り・並び順が違ってもシグネチャは同じ', () => {
  const rows = (ids: number[]) => ids.map((i) => link('詳細', `/items/${i}`, { nth: i }));
  const p1 = snap('http://app.test/items', { actions: [...header, ...rows([1, 2, 3]), link('2', '/items?page=2'), link('次へ', '/items?page=2')], headings: ['商品一覧'], headingTags: ['h1'] });
  const p2 = snap('http://app.test/items?page=2', { actions: [...header, ...rows([9, 7]), link('1', '/items?page=1'), link('前へ', '/items?page=1')], headings: ['商品一覧'], headingTags: ['h1'] });
  assert.equal(signatureOf(p1, ctx()).signature, signatureOf(p2, ctx()).signature);
});

test('データの画面は h1（レコード名）を見ず、その名前を含むラベルからも消す', () => {
  const detail = (name: string, id: number) => snap(`http://app.test/company/${id}`, {
    headings: [name, 'ひと目でわかる数字'], headingTags: ['h1', 'h2'],
    actions: [...header, act(`${name}を比較に追加`)],
  });
  assert.equal(signatureOf(detail('ＡＩＡＩグループ株式会社', 6010601048836), ctx()).signature, signatureOf(detail('株式会社オービック', 1010001114006), ctx()).signature);
});

test('タブの選択・ダイアログ・フォーム項目の違いは別の画面になる', () => {
  const base = { headings: ['設定'], headingTags: ['h1'], actions: [...header, act('一般設定', { role: 'tab' }), act('通知設定', { role: 'tab' })] };
  const general = signatureOf(snap('http://app.test/settings', { ...base, selectedTabs: ['一般設定'] }), ctx()).signature;
  const notify = signatureOf(snap('http://app.test/settings', { ...base, selectedTabs: ['通知設定'] }), ctx()).signature;
  const modal = signatureOf(snap('http://app.test/settings', { ...base, selectedTabs: ['一般設定'], dialog: '保存しました' }), ctx()).signature;
  const form = signatureOf(snap('http://app.test/settings', { ...base, selectedTabs: ['一般設定'], formFields: ['input:text:displayName'] }), ctx()).signature;
  assert.equal(new Set([general, notify, modal, form]).size, 4);
});

test('volatile の中の操作は骨格に入れない', () => {
  const a = signatureOf(snap('http://app.test/', { actions: [...header] }), ctx()).signature;
  const b = signatureOf(snap('http://app.test/', { actions: [...header, link('最近見た: ノートPC', '/items/1', { volatile: true })] }), ctx()).signature;
  assert.equal(a, b);
});

test('外部サイトのシグネチャは URL のクエリや ID の違いで分かれない', () => {
  const a = signatureOf(snap('https://ext.example/doc/S100AB12CD34?lang=ja'), ctx());
  const b = signatureOf(snap('https://ext.example/doc/S100XY98ZW76'), ctx());
  assert.equal(a.route, undefined);
  assert.equal(a.signature, b.signature);
});

test('structureDiff は片方にだけある行を返す', () => {
  assert.deepEqual(structureDiff('a\nb\nc', 'b\nc\nd'), { onlyA: ['a'], onlyB: ['d'] });
});

// ---------- 画面の中のデータ（行ごとの同種の操作） ----------

const companyRows = (rows: [string, number][]) => rows.flatMap(([name, id]) => [link(name, `/company/${id}`), link('詳細', `/company/${id}`), act(`${name}を並べて比べる`)]);

test('pageData: データのルートへのリンクのラベル（企業名）を消し、行ごとのボタンを 1 つの形に畳む', () => {
  const page = (rows: [string, number][]) => snap('http://app.test/companies', { actions: [...header, ...companyRows(rows)], headings: ['収録企業の一覧'], headingTags: ['h1'] });
  const a = signatureOf(page([['ＡＩＡＩグループ株式会社', 6010601048836], ['株式会社ＩＨＩ', 7010401079733]]), ctx());
  const b = signatureOf(page([['アイコム株式会社', 1120001077009], ['愛眼株式会社', 5120001077011], ['株式会社アイ・エス・ビー', 7011101019434]]), ctx());
  assert.equal(a.signature, b.signature);
  assert.ok(a.structure.includes('a:button|*を並べて比べる'), a.structure);
  assert.ok(a.dataValues.includes('株式会社ＩＨＩ'));
  assert.ok(!a.dataValues.includes('詳細'), '全行で同じラベルはデータではない');
});

test('pageData: 空白の表記が違う企業名・同名の別会社・名前のリンクが無い行のボタンも、他の行と同じ形に畳む', () => {
  // リンクのラベルは innerText（空白を詰める）、ボタンは aria-label（全角空白のまま）から取る
  const rows = (names: [string, number][]) => names.flatMap(([name, id]) => [link(name.replace(/\s+/g, ' '), `/company/${id}`), link('詳細', `/company/${id}`), act(`${name}を並べて比べる`)]);
  const page = (names: [string, number][], extra: RawAction[] = []) => snap('http://app.test/companies', { actions: [...header, ...rows(names), ...extra], headings: ['収録企業の一覧'], headingTags: ['h1'] });
  const base: [string, number][] = [['株式会社ＩＨＩ', 1], ['愛眼株式会社', 2], ['アイコム株式会社', 3], ['株式会社アイ・エス・ビー', 4], ['ＡＩＡＩグループ株式会社', 5]];
  const plain = signatureOf(page(base), ctx());
  assert.equal(signatureOf(page([...base, ['アクシアル　リテイリング株式会社', 6]]), ctx()).structure, plain.structure);
  assert.equal(signatureOf(page([...base, ['株式会社アルファ', 7], ['株式会社アルファ', 8]]), ctx()).structure, plain.structure);
  assert.equal(signatureOf(page(base, [act('名無し商事株式会社を並べて比べる')]), ctx()).structure, plain.structure);
});

test('pageData: 行き先が 1 件だけなら、リンクのラベルをデータとみなさない', () => {
  assert.deepEqual(pageData([link('ノートPC', '/items/1'), link('詳しく見る', '/items/1')], 'http://app.test/compare', ctx()).values, []);
});

test('pageData: 名前のリンクが無くても、共通の後置きを持つボタンの群（4 つ以上）は 1 つの形に畳む', () => {
  const names = ['ノートPC', 'キーボード', 'デスクトップPC', 'マウス', 'ヘッドセット'];
  const p = pageData([...names.map((n) => act(`${n}を比較に追加`)), act('並べて比べる'), act('保存する')], 'http://app.test/items', ctx());
  for (const n of names) assert.equal(labelKey({ role: 'button', label: `${n}を比較に追加` }, p.values, p.fold), '*を比較に追加');
  assert.equal(labelKey({ role: 'button', label: '保存する' }, p.values, p.fold), '保存する');
  assert.equal(labelKey({ role: 'button', label: '並べて比べる' }, p.values, p.fold), '並べて比べる');
  const few = pageData(['Aa', 'Bb', 'Cc'].map((n) => act(`${n}を外す`)), 'http://app.test/', ctx());
  assert.equal(few.fold.size, 0, '3 つでは群とみなさない');
});

test('同じ見出しの繰り返しは 1 行にする（カードの数で骨格が変わらない）', () => {
  const a = signatureOf(snap('http://app.test/news', { headings: ['お知らせ', '記事', '記事'], headingTags: ['h1', 'h3', 'h3'] }), ctx());
  const b = signatureOf(snap('http://app.test/news', { headings: ['お知らせ', '記事'], headingTags: ['h1', 'h3'] }), ctx());
  assert.equal(a.signature, b.signature);
});

// ---------- その場の変化・部品・絞り込みの一覧 ----------

const listBase = ['h:h1:商品一覧', 'a:button|*を比較に追加', 'a:link|/', 'a:link|/items/*', 'a:link|/contact', 'a:summary|~', 'f:input:search:q'].join('\n');
const trayLines = ['h:h2:比較する商品（#）', 'a:button|*を外す', 'a:link|/compare', 'a:button|すべて外す'];

test('isLocalChange: 見出しを失わず、操作の大半が残る変化だけを画面の中の変化とみなす', () => {
  assert.ok(isLocalChange(listBase, listBase + '\n' + trayLines.join('\n')), '比較トレイが開いた');
  assert.ok(!isLocalChange(listBase, listBase.replace('h:h1:商品一覧', 'h:h1:お問い合わせ')), '見出しが変われば別の画面');
  assert.ok(!isLocalChange(listBase, 'd:ヘルプ\n' + listBase), 'ダイアログ（モーダル）は別の画面');
  assert.ok(!isLocalChange(listBase, 't:通知設定\n' + listBase), 'タブの切り替えは別の画面');
  assert.ok(!isLocalChange(listBase, 'h:h1:商品一覧\na:button|購入する'), '操作の大半が入れ替われば別の画面');
  assert.ok(!isLocalChange('', 'h:h1:x'), '空の画面からの変化は判断しない');
});

test('variantOf: 部品として見たことのある行だけが増えた画面は、元の画面の変形とみなす', () => {
  const widget = lineMatcher(trayLines);
  const top = ['h:h1:ダッシュボード', 'a:link|/', 'a:link|/items', 'a:link|/contact', 'a:summary|~'].join('\n');
  // 別の画面では企業名が消えずに残ることがある（* は任意の文字列に当たる）
  const withTray = top + '\n' + ['h:h2:比較する商品（#）', 'a:button|ノートPCを外す', 'a:link|/compare', 'a:button|すべて外す'].join('\n');
  assert.ok(variantOf(top, withTray, widget));
  assert.ok(!variantOf(top, withTray + '\na:button|購入手続きへ', widget), '部品でない行が増えれば別の画面');
  assert.ok(!variantOf(top, top, widget), '何も増えていなければ変形ではない');
  assert.ok(!lineMatcher(['a:button|*'])('a:button|何か'), '中身が * だけの行は何にでも当たるので使わない');
});

test('proposeQueryVariantPaths: クエリだけ違う同じルートへのリンクが 2 通り以上あれば、絞り込みの一覧とみなす', () => {
  const items = [{ href: '/companies?has=telework' }, { href: '/companies?has=flextime' }, { href: '/about' }, { href: '/settings?tab=a' }];
  assert.deepEqual(proposeQueryVariantPaths(items, 'http://app.test/', ctx()), ['/companies']);
  assert.deepEqual(proposeQueryVariantPaths(items, 'http://app.test/', ctx({ queryParams: 'names' })), [], 'クエリをルートに入れる設定では別の画面になる');
  assert.deepEqual(proposeQueryVariantPaths([{ href: '/settings?tab=a' }, { href: '/settings?tab=b' }], 'http://app.test/', ctx({ structuralParams: ['tab'] })), []);
});

test('クエリで絞り込む一覧のルートでは、h1 の違いで画面を分けない', () => {
  const page = (url: string, h1: string) => snap(url, { headings: [h1, '並べて比べる'], headingTags: ['h1', 'h2'], actions: [...header] });
  const c = ctx();
  const telework = () => signatureOf(page('http://app.test/companies?has=telework', 'テレワーク制度のある会社'), c).signature;
  const all = () => signatureOf(page('http://app.test/companies', '収録企業の一覧'), c).signature;
  assert.notEqual(telework(), all());
  c.queryVariantPaths = new Set(['/companies']);
  assert.equal(telework(), all());
});
