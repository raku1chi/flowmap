import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionKey, externalRoute, isIdLike, normalizeDigits, normalizeRoute, planActions, proposeDataSegments, scrub,
  signatureOf, structureDiff, type NormalizeContext,
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
