// 画面の同定（シグネチャ）に使う正規化。探索エンジンから切り離した純粋関数で、ブラウザに依存しない（DESIGN.md §5）。
//
// 目的は 2 つ。
//   1. 同じテンプレートに違うデータを流し込んだ画面（/items/12 と /items/34、業種ごとの一覧）を 1 つのノードに合流させる
//   2. 利用者の操作で見た目だけ変わった状態（表示設定の値、入力途中の値、開いたままの候補）で同じ画面を分裂させない
//
// URL の「データを表す区間」は `*` に置き換える（ZAP の Data Driven Content と同じ発想）。決め方は 3 つある。
//   1. ID に見える区間（数字だけ・UUID・長いハッシュ）は常にデータ
//   2. 設定 pathRules（正規表現）で人が宣言する
//   3. 同じ画面に「1 区間だけ違う同じ形の href」が minSiblings 本以上あれば、その区間をデータとみなす（自動学習）
//
// 画面の中のデータ（企業名・商品名）は、見出しと操作のラベルから消す（pageData）。一覧の各行に並ぶ「〇〇を並べて比べる」の
// ようなボタンは、データを消すと同じ形になって 1 つに畳まれる。

import { createHash } from 'node:crypto';
import type { Snapshot } from './inpage.js';

export interface PathRule {
  pattern: string;
  replace: string;
}

export type QueryParamMode = 'ignore' | 'names' | 'values';

export interface NormalizeContext {
  origin: string;
  pathRules: PathRule[];
  /** 自動学習したデータ区間。正規化済みの親パス（例 `/companies`）を持ち、その直後の区間をデータとみなす */
  learnedPrefixes: Set<string>;
  queryParams: QueryParamMode;
  /** queryParams によらず値を残すパラメータ名（ZAP の Structural Parameter に相当） */
  structuralParams: string[];
  /** 値をデータとみなすパラメータ名（`?id=12` → `?id=*`） */
  dataParams?: string[];
  /**
   * 自動学習した「クエリで絞り込む一覧」のルート（`/companies`）。queryParams が ignore のとき、同じルートへの
   * クエリだけ違うリンクが 2 通り以上ある画面から学ぶ。絞り込みで変わる h1（「テレワーク制度のある会社」）はデータとみなす
   */
  queryVariantPaths?: Set<string>;
}

export const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

/** 数字を `#` に潰す。桁区切りや小数（`1,001` `4.5`）も 1 つの数として扱う。件数が 3 桁から 4 桁に増えても形が変わらないように */
export const normalizeDigits = (s: string): string => s.replace(/\d+(?:[,.]\d+)*/g, '#');

const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * レコードの ID に見える区間か。数字だけ、UUID、数字と英字の混じった 8 文字以上の英数字（書類番号・ASIN・ハッシュなど）、
 * 区切り記号を含む 16 文字以上のトークン（nanoid など）。`v2` や `item-12` のような短い語は ID とみなさない（数字だけ `#` に潰す）。
 */
export function isIdLike(seg: string): boolean {
  if (/^\d+$/.test(seg)) return true;
  if (UUID.test(seg)) return true;
  const mixed = /\d/.test(seg) && /[A-Za-z]/.test(seg);
  if (mixed && /^[0-9A-Za-z]{8,}$/.test(seg)) return true;
  if (mixed && /^[0-9A-Za-z_-]{16,}$/.test(seg)) return true;
  return false;
}

/** URL を区間に分ける。`#/` か `#!/` で始まるハッシュはハッシュルーティングとみなし、`#` の区間の後ろに続ける */
function splitUrl(u: URL): { segs: string[]; search: string } {
  const segs = u.pathname.split('/').filter(Boolean).map(decode);
  const m = u.hash.match(/^#!?(\/[^?]*)(\?.*)?$/);
  if (m) {
    segs.push('#', ...m[1].split('/').filter(Boolean).map(decode));
    return { segs, search: m[2] ?? u.search };
  }
  return { segs, search: u.search };
}

/** 設定の pathRules をデコード済みパスに適用する */
function applyPathRules(path: string, rules: PathRule[]): string {
  let out = path;
  for (const r of rules) {
    try { out = out.replace(new RegExp(r.pattern), r.replace); } catch { /* 不正な正規表現は設定の検証で弾いている */ }
  }
  return out;
}

/** 区間列を ID・学習済みルール・数字の正規化で畳み、データとみなした区間の元の値も返す */
function normalizeSegments(segs: string[], learned: Set<string>): { norm: string[]; dataValues: string[] } {
  const norm: string[] = [];
  const dataValues: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const prefix = '/' + norm.join('/');
    if (s === '*' || s === '#') norm.push(s); // pathRules で置き換え済みの区間とハッシュの区切り
    else if (isIdLike(s) || (i >= 1 && learned.has(prefix))) { norm.push('*'); dataValues.push(s); }
    else norm.push(normalizeDigits(s));
  }
  return { norm, dataValues };
}

function normalizeQuery(search: string, ctx: NormalizeContext): { query: string; dataValues: string[]; dataDriven: boolean } {
  if (!search) return { query: '', dataValues: [], dataDriven: false };
  const params = new URLSearchParams(search);
  const parts: string[] = [];
  const dataValues: string[] = [];
  let dataDriven = false;
  for (const [k, v] of params) {
    if (ctx.structuralParams.includes(k)) parts.push(`${k}=${normalizeDigits(v)}`);
    else if (ctx.dataParams?.includes(k)) { parts.push(`${k}=*`); dataValues.push(v); dataDriven = true; }
    else if (ctx.queryParams === 'values') parts.push(`${k}=${normalizeDigits(v)}`);
    else if (ctx.queryParams === 'names') { parts.push(k); if (v) dataValues.push(v); }
  }
  return { query: [...new Set(parts)].sort().join('&'), dataValues, dataDriven };
}

export interface Route {
  /** シグネチャに使う正規化済みのパス（+ クエリ）。例 `/companies/*` `/search?q` */
  route: string;
  /** データとみなして `*` に置き換えた区間・パラメータの元の値。見出しやラベルから同じ値を消すのに使う */
  dataValues: string[];
  /** データの区間を持つ（レコードごとの画面）。h1 はレコードの名前であることが多いので、骨格では文言を見ない */
  dataDriven: boolean;
}

/** 同一オリジンの URL を正規化する。別オリジンや http(s) でなければ undefined */
export function normalizeRoute(url: string, ctx: NormalizeContext): Route | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  if (u.origin !== ctx.origin) return undefined;
  const { segs: original, search } = splitUrl(u);
  const dataValues: string[] = [];

  // 1. 設定ルール。区間数が変わらない置換なら、変わった区間の元の値をデータ値として記録する
  const ruledPath = applyPathRules('/' + original.join('/'), ctx.pathRules);
  const ruled = ruledPath.split('/').filter(Boolean);
  if (ruled.length === original.length) {
    for (let i = 0; i < ruled.length; i++) if (ruled[i] !== original[i]) dataValues.push(original[i]);
  }

  // 2. ID・自動学習したルール・数字の正規化
  const { norm, dataValues: learnedValues } = normalizeSegments(ruled, ctx.learnedPrefixes);
  dataValues.push(...learnedValues);

  const q = normalizeQuery(search, ctx);
  dataValues.push(...q.dataValues);
  const path = '/' + norm.join('/');
  return { route: path + (q.query ? '?' + q.query : ''), dataValues, dataDriven: norm.includes('*') || q.dataDriven };
}

/** 別オリジンの画面の同定に使う形。ホストと、ID を潰したパス（クエリとハッシュは見ない） */
export function externalRoute(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean).map(decode).map((s) => (isIdLike(s) ? '*' : normalizeDigits(s)));
    return `//${u.host}/${segs.join('/')}`;
  } catch {
    return url;
  }
}

export interface LinkItem {
  href: string;
  label?: string;
  /** ナビゲーション（nav 要素）の中のリンクか */
  inNav?: boolean;
}

/** データ区間の候補。prefix の直後の区間がデータだとみなせる理由として、兄弟リンクの例を持つ */
export interface SegmentProposal {
  prefix: string;
  examples: LinkItem[];
}

/**
 * 同じ画面にある href から「1 区間だけ違う同じ形の URL」の群を探し、データ区間の候補として返す（ctx は変えない）。
 * 先頭区間（`/about` `/contact` のようなトップレベルの経路）は対象にしない。
 * ナビゲーションの中に並ぶ、語だけの少数のリンク（`/settings/profile` `/settings/security`）は別々の画面のことが多いので候補にしない。
 * exclude に入っている親パス（Jev が退けた候補など）は返さない。
 */
export function proposeDataSegments(items: LinkItem[], pageUrl: string, ctx: NormalizeContext, minSiblings = 3, exclude?: Set<string>): SegmentProposal[] {
  const groups = new Map<string, { prefix: string; values: Set<string>; examples: LinkItem[]; allInNav: boolean }>();
  for (const item of items) {
    let u: URL;
    try { u = new URL(item.href, pageUrl); } catch { continue; }
    if (u.origin !== ctx.origin) continue;
    const { segs } = splitUrl(u);
    const ruled = applyPathRules('/' + segs.join('/'), ctx.pathRules).split('/').filter(Boolean);
    if (ruled.length !== segs.length) continue;
    const { norm } = normalizeSegments(ruled, ctx.learnedPrefixes);
    for (let i = 1; i < segs.length; i++) {
      if (norm[i] === '*' || norm[i] === '#' || norm[i - 1] === '#') continue; // 既にデータ・ハッシュの区切り・ハッシュ側の先頭区間
      const prefix = '/' + norm.slice(0, i).join('/');
      if (ctx.learnedPrefixes.has(prefix) || exclude?.has(prefix)) continue;
      const shape = norm.map((s, j) => (j === i ? '*' : s)).join('/');
      const key = `${i}|${shape}`;
      const g = groups.get(key) ?? { prefix, values: new Set<string>(), examples: [], allInNav: true };
      if (!g.values.has(segs[i]) && g.examples.length < 8) g.examples.push({ href: u.href, label: item.label, inNav: item.inNav });
      g.values.add(segs[i]);
      g.allInNav &&= !!item.inNav;
      groups.set(key, g);
    }
  }
  // 同じ親パスの群が複数あれば 1 つの候補にまとめる
  const byPrefix = new Map<string, SegmentProposal>();
  for (const g of groups.values()) {
    if (g.values.size < minSiblings) continue;
    const wordsOnly = [...g.values].every((v) => !/\d/.test(v));
    if (g.allInNav && wordsOnly && g.values.size <= 12) continue; // 設定の各セクションのようなナビゲーション
    const p = byPrefix.get(g.prefix);
    if (p) p.examples.push(...g.examples.slice(0, 8 - p.examples.length));
    else byPrefix.set(g.prefix, { prefix: g.prefix, examples: [...g.examples] });
  }
  return [...byPrefix.values()];
}

/**
 * データ区間の候補を全部そのまま学習する（Jev を使わないときの動き）。
 * 戻り値は新しく学習した親パスの一覧。
 */
export function learnDataSegments(hrefs: string[], pageUrl: string, ctx: NormalizeContext, minSiblings = 3): string[] {
  const proposals = proposeDataSegments(hrefs.map((href) => ({ href })), pageUrl, ctx, minSiblings);
  for (const p of proposals) ctx.learnedPrefixes.add(p.prefix);
  return proposals.map((p) => p.prefix);
}

/**
 * クエリだけが違う同じルートへのリンクが 2 通り以上ある画面から、「クエリで絞り込む一覧」のルートを見つける（ctx は変えない）。
 * queryParams が ignore のときだけ（names・values ではクエリがルートに入るので、そもそも別の画面になる）。
 * `/companies?has=telework` と `/companies?has=flextime` は、h1 だけが違う同じ一覧なので、h1 をデータとみなして合流させる。
 * structuralParams・dataParams に挙げたパラメータは数えない
 */
export function proposeQueryVariantPaths(items: LinkItem[], pageUrl: string, ctx: NormalizeContext): string[] {
  if (ctx.queryParams !== 'ignore') return [];
  const byRoute = new Map<string, Set<string>>();
  const add = (href: string) => {
    let u: URL;
    try { u = new URL(href, pageUrl); } catch { return; }
    const r = normalizeRoute(u.href, ctx);
    if (!r) return;
    const params = new URLSearchParams(splitUrl(u).search);
    const rest = [...params].filter(([k]) => !ctx.structuralParams.includes(k) && !ctx.dataParams?.includes(k)).map(([k, v]) => `${k}=${v}`).sort().join('&');
    if (!rest) return;
    const set = byRoute.get(r.route) ?? new Set<string>();
    byRoute.set(r.route, set);
    set.add(rest);
  };
  add(pageUrl);
  for (const it of items) add(it.href);
  return [...byRoute].filter(([route, qs]) => qs.size >= 2 && !ctx.queryVariantPaths?.has(route)).map(([route]) => route);
}

/** データとして扱える文字列か。数字・記号・空白を除いて 2 文字以上（「2」や「#」で無関係な部分を消さないため） */
const isDataText = (v: string): boolean => v.replace(/[#\d\s\p{P}\p{S}]/gu, '').length >= 2;

/**
 * データ値をテキストから消す。見出し「サービス業の企業一覧」を「*の企業一覧」にして、業種違いの画面を合流させる。
 * text は数字を潰したもの（normalizeDigits）を渡す。値の数字も同じように潰して比べる
 */
export function scrub(text: string, dataValues: string[]): string {
  const values = [...new Set(dataValues.map((v) => normalizeDigits(v.trim())))].filter(isDataText).sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of values) out = out.split(v).join('*');
  return out;
}

export interface ActionLike {
  role: string;
  label: string;
  href?: string;
  toggle?: boolean;
}

/**
 * 操作の「形」。同じ形の操作は同種とみなす。
 * リンクは行き先の正規化ルートで、それ以外はラベルで決める。一覧の各行のリンクはこれで 1 つに畳まれる。
 * 別オリジンへのリンクはホスト名だけで表す。外部サイトの URL に含まれる ID（EDINET の書類番号など）はこのアプリのデータであり、
 * 外部サイトは撮影しかしないので、行き先の細部で画面を区別する意味がない。
 * 開閉・ポップアップの操作（summary、aria-expanded など）はラベルに今の値（「表示: 在庫あり優先 ▾」）が出るので、ラベルを見ない。
 */
export function actionKey(a: ActionLike, pageUrl: string, ctx: NormalizeContext, dataValues: string[], fold?: Map<string, string>): string {
  if (a.href) {
    let abs: URL | undefined;
    try { abs = new URL(a.href, pageUrl); } catch { abs = undefined; }
    if (abs && /^https?:$/.test(abs.protocol)) {
      const r = normalizeRoute(abs.href, ctx);
      return `${a.role}|${r ? r.route : `//${abs.host}`}`;
    }
  }
  if (a.toggle) return `${a.role}|~`;
  return `${a.role}|${labelKey(a, dataValues, fold)}`;
}

/**
 * ラベルの形。数字を潰し、データの値を * にし、行ごとの同種の操作（fold）はデータの部分を * にした形にする。
 * 開閉の操作もラベルで区別したいとき（同じ画面の別々の開閉を数えるとき）に使う
 */
export function labelKey(a: Pick<ActionLike, 'role' | 'label'>, dataValues: string[], fold?: Map<string, string>): string {
  const pre = scrub(normalizeDigits(a.label), dataValues);
  return fold?.get(`${a.role}|${pre}`) ?? pre;
}

/** 画面の中のデータ（pageData の結果） */
export interface PageData {
  /** データとみなして見出しとラベルから消す値（URL のデータ区間の値、データの見出し、データのルートへのリンクのラベル） */
  values: string[];
  /** 行ごとの同種の操作のラベル（`role|数字を潰したラベル`）→ データの部分を * にした形（`*を並べて比べる`） */
  fold: Map<string, string>;
}

/** 行ごとの同種の操作とみなす群の最小の大きさ・共通部分の最短の長さ・違う部分の最短の長さ */
const MIN_FAMILY = 4;
const MIN_AFFIX = 3;
const MIN_VARYING = 2;

/**
 * 画面の中のデータを見つける（DESIGN.md §5）。
 * 1. データのルート（`/company/*`）へのリンクのラベルのうち、1 つの行き先にだけ使われているもの（企業名・商品名）。
 *    同じルートにそういうラベルが 2 つ以上あるときだけ（一覧の各行）。「詳細」のように全行で同じラベルはデータではない
 * 2. リンクでない操作（ボタンなど）で、共通の前置きか後置きを持つラベルの群（「ＡＩＡＩを並べて比べる」「ＩＨＩを並べて比べる」…）。
 *    MIN_FAMILY 個以上あれば、違う部分をデータとみなして `*を並べて比べる` に畳む。共通部分は、群の大きさが最大の 8 割以上ある
 *    ものから最も長いものを選ぶ（単独の「並べて比べる」ボタンに引きずられて「*比べる」まで縮まないように）
 * base は先に分かっているデータの値（URL のデータ区間の値など）。
 */
export function pageData(actions: ActionLike[], pageUrl: string, ctx: NormalizeContext, base: string[] = []): PageData {
  const values = [...base];
  const byRoute = new Map<string, Map<string, Set<string>>>();
  const hrefValues = new Map<string, string[]>();
  for (const a of actions) {
    if (!a.href) continue;
    let u: URL;
    try { u = new URL(a.href, pageUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const r = normalizeRoute(u.href, ctx);
    const label = a.label.trim();
    if (!r?.dataDriven || !isDataText(label)) continue;
    const labels = byRoute.get(r.route) ?? new Map<string, Set<string>>();
    byRoute.set(r.route, labels);
    const hrefs = labels.get(label) ?? new Set<string>();
    labels.set(label, hrefs);
    hrefs.add(u.href);
    hrefValues.set(u.href, r.dataValues);
  }
  for (const labels of byRoute.values()) {
    const named = [...labels].filter(([, hrefs]) => hrefs.size === 1);
    // 行が 1 件だけだと「詳しく見る」も 1 つの行き先にしか使われないので、行き先が 2 件以上ある一覧だけを見る
    if (named.length < 2 || new Set(named.map(([, hrefs]) => [...hrefs][0])).size < 2) continue;
    for (const [label, hrefs] of named) values.push(label, ...(hrefValues.get([...hrefs][0]) ?? []));
  }

  const byRole = new Map<string, Set<string>>();
  for (const a of actions) {
    if (a.href || a.toggle) continue;
    const pre = scrub(normalizeDigits(a.label), values);
    if (pre.includes('*') || pre.length < MIN_AFFIX + MIN_VARYING) continue;
    const set = byRole.get(a.role) ?? new Set<string>();
    byRole.set(a.role, set);
    set.add(pre);
  }
  const fold = new Map<string, string>();
  const affixes = (l: string): string[] => {
    const out: string[] = [];
    for (let k = MIN_AFFIX; k <= l.length - MIN_VARYING; k++) out.push('S' + l.slice(l.length - k), 'P' + l.slice(0, k));
    return out;
  };
  for (const [role, set] of byRole) {
    if (set.size < MIN_FAMILY) continue;
    const count = new Map<string, number>();
    for (const l of set) for (const x of new Set(affixes(l))) count.set(x, (count.get(x) ?? 0) + 1);
    for (const l of set) {
      const cands = affixes(l).filter((x) => count.get(x)! >= MIN_FAMILY);
      if (!cands.length) continue;
      const max = Math.max(...cands.map((x) => count.get(x)!));
      const best = cands.filter((x) => count.get(x)! >= max * 0.8).sort((x, y) => y.length - x.length || (x < y ? -1 : x > y ? 1 : 0))[0];
      fold.set(`${role}|${l}`, best[0] === 'S' ? '*' + best.slice(1) : best.slice(1) + '*');
    }
  }
  return { values, fold };
}

/**
 * 試す操作の順番と件数を決める。
 * 同じ形の操作は maxPerPattern 件まで（0 で無制限）に絞り、形ごとに 1 件ずつ順繰りに並べる。
 * 先頭 N 件が一覧の同種リンクで埋まって他の操作に予算が回らない、という事態を避けるため。
 */
export function planActions<T>(actions: T[], keyOf: (a: T) => string, maxPerPattern: number): T[] {
  const groups = new Map<string, T[]>();
  for (const a of actions) {
    const k = keyOf(a);
    const g = groups.get(k) ?? [];
    if (maxPerPattern <= 0 || g.length < maxPerPattern) g.push(a);
    groups.set(k, g);
  }
  const lists = [...groups.values()];
  const out: T[] = [];
  for (let r = 0; ; r++) {
    let any = false;
    for (const g of lists) if (r < g.length) { out.push(g[r]); any = true; }
    if (!any) break;
  }
  return out;
}

/** 重複を除いて並べ替える。骨格を DOM の出現順に依存させない（同じテンプレートでもデータ次第で節の順が入れ替わるため） */
const uniqSorted = (xs: string[]): string[] => [...new Set(xs)].sort();

export interface StructureInput {
  headings: { tag: string; text: string }[];
  actions: (ActionLike & { volatile?: boolean })[];
  formFields: string[];
  dialog?: string;
  selectedTabs?: string[];
}

/**
 * 画面の骨格。開いているダイアログ・選ばれているタブ・見出し・操作対象・フォーム項目から作る。
 * - 同じ形の操作は 1 つに畳み、並べ替えるので、一覧の件数や節の順が変わっても骨格は変わらない。
 * - 画面の中のデータ（pageData: 企業名・商品名）は見出しとラベルから消し、行ごとの同種のボタンは 1 つの形に畳む。
 * - 同じ見出しが繰り返されても 1 行にする（カードごとの見出しがデータを消して同じになったとき、件数で骨格が変わらないように）。
 * - 今の画面と同じルートへのリンク（ページ送り・絞り込み・ページ内リンク）は画面の見方を変えるだけなので入れない。
 * - 開閉の操作はラベルを見ない（actionKey）。
 * - データ区間を持つルート（`/company/*`）と、クエリで絞り込む一覧のルートの h1 はデータの名前（企業名・絞り込みの条件）で
 *   あることが多いので、文言を捨てて h1 があることだけを残し、その文言を他の見出しとラベルからも消す。h2 以下は残す。
 * - volatileSelectors の中の要素は入れない（在庫の少ない商品、最近見たもの、時計など）。
 */
export function analyzePage(snap: StructureInput, pageUrl: string, ctx: NormalizeContext, route: Route): { structure: string } & PageData {
  const dataLike = route.dataDriven || !!ctx.queryVariantPaths?.has(route.route);
  const base = [...route.dataValues];
  const h1 = snap.headings.find((h) => h.tag === 'h1');
  if (dataLike && h1 && isDataText(h1.text.trim())) base.push(h1.text.trim());
  const actions = snap.actions.filter((a) => !a.volatile);
  const { values, fold } = pageData(actions, pageUrl, ctx, base);
  const clean = (s: string) => scrub(normalizeDigits(s), values);
  const lines: string[] = [];
  if (snap.dialog !== undefined) lines.push(`d:${clean(snap.dialog)}`);
  for (const t of uniqSorted((snap.selectedTabs ?? []).map(clean))) lines.push(`t:${t}`);
  lines.push(...new Set(snap.headings.map((h) => (dataLike && h.tag === 'h1' ? 'h:h1' : `h:${h.tag}:${clean(h.text)}`))));
  const acts: string[] = [];
  for (const a of actions) {
    const key = actionKey(a, pageUrl, ctx, values, fold);
    if (a.href && key === `${a.role}|${route.route}`) continue; // 同じルートへのリンク
    acts.push(`a:${key}`);
  }
  lines.push(...uniqSorted(acts));
  lines.push(...uniqSorted(snap.formFields.map((f) => `f:${normalizeDigits(f)}`)));
  return { structure: lines.join('\n'), values, fold };
}

export function structureOf(snap: StructureInput, pageUrl: string, ctx: NormalizeContext, route: Route): string {
  return analyzePage(snap, pageUrl, ctx, route).structure;
}

export interface SignatureResult {
  signature: string;
  /** 同一オリジンなら正規化ルート。別オリジンなら undefined */
  route?: string;
  /** 画面の中のデータとみなした値（URL のデータ区間の値、データの見出し、データのリンクのラベル） */
  dataValues: string[];
  /** 行ごとの同種の操作を畳んだ形（pageData） */
  fold: Map<string, string>;
  structure: string;
}

/**
 * 画面のシグネチャ（§5）。同一オリジンなら sha1(正規化ルート ‖ 骨格)、別オリジンならホストと ID を潰したパスだけ。
 * 実行間の比較はこの値で行う。ノード id を突き合わせてはいけない。
 */
export function signatureOf(snap: Pick<Snapshot, 'url' | 'headings' | 'headingTags' | 'actions' | 'formFields' | 'dialog' | 'selectedTabs'>, ctx: NormalizeContext): SignatureResult {
  const r = normalizeRoute(snap.url, ctx);
  if (!r) {
    const ext = externalRoute(snap.url);
    return { signature: sha1(`ext|${ext}`).slice(0, 12), dataValues: [], fold: new Map(), structure: ext };
  }
  const headings = snap.headings.map((text, i) => ({ tag: snap.headingTags[i] ?? 'h2', text }));
  const a = analyzePage({ headings, actions: snap.actions, formFields: snap.formFields, dialog: snap.dialog, selectedTabs: snap.selectedTabs }, snap.url, ctx, r);
  return { signature: sha1(`${r.route}||${a.structure}`).slice(0, 12), route: r.route, dataValues: a.values, fold: a.fold, structure: a.structure };
}

/** 骨格の行を、ダイアログ・選ばれたタブ・見出しと、それ以外（操作・入力欄）に分ける */
function splitLines(structure: string): { d: string[]; t: string[]; h: string[]; rest: string[] } {
  const out = { d: [] as string[], t: [] as string[], h: [] as string[], rest: [] as string[] };
  for (const line of structure.split('\n')) {
    if (!line) continue;
    const k = line.slice(0, 2);
    if (k === 'd:') out.d.push(line);
    else if (k === 't:') out.t.push(line);
    else if (k === 'h:') out.h.push(line);
    else out.rest.push(line);
  }
  return out;
}

const sameLines = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** その場の変化とみなすとき、元の画面の操作と入力欄のうち残っていなければならない割合 */
export const LOCAL_RETAIN = 0.8;

/**
 * to が from の画面の中の変化か（DESIGN.md §4。ルートが同じことは呼び出し側で確かめる）。
 * ダイアログと選ばれたタブが同じで、元の見出しを 1 つも失わず、元の操作と入力欄の retain 以上が残っているもの。
 * 比較パネルへの追加・開閉を開く・並べ替え・その場のページ送りのように、画面はそのままで一部が増えたり変わったりした状態で、
 * 別のノードにせず元の画面に吸収する。ダイアログ（モーダル）とタブの切り替えは別の画面として残す。
 */
export function isLocalChange(from: string, to: string, retain = LOCAL_RETAIN): boolean {
  const A = splitLines(from);
  const B = splitLines(to);
  if (!A.h.length && !A.rest.length) return false;
  if (!sameLines(A.d, B.d) || !sameLines(A.t, B.t)) return false;
  const bh = new Set(B.h);
  if (!A.h.every((x) => bh.has(x))) return false;
  if (!A.rest.length) return true;
  const br = new Set(B.rest);
  return A.rest.filter((x) => br.has(x)).length >= A.rest.length * retain;
}

/**
 * variant が base に「部品」（どこかの画面でその場の変化として現れた行）が加わっただけの状態か。
 * 比較パネルのようにストレージに残って他の画面にも出る部品が開いた状態を、元の画面と同じとみなすのに使う。
 * 部品として見たことのない行（カートの「購入手続きへ」など）が 1 つでも増えていれば別の画面とする
 */
export function variantOf(base: string, variant: string, isWidget: (line: string) => boolean): boolean {
  if (!isLocalChange(base, variant, 0.9)) return false;
  const A = new Set(base.split('\n'));
  const extra = variant.split('\n').filter((x) => x && !A.has(x));
  return extra.length > 0 && extra.every(isWidget);
}

/**
 * 骨格の行の一覧から、ある行がそのどれかに当たるかを調べる関数を作る。
 * 行の中の * （消したデータ）は 1 文字以上の任意の文字列に当たる。別の画面では同じ企業名がデータとして消えないことがあるため
 */
export function lineMatcher(lines: Iterable<string>): (line: string) => boolean {
  const exact = new Set<string>();
  const patterns: RegExp[] = [];
  const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const l of lines) {
    exact.add(l);
    const head = /^(a:[^|]*\||h:[^:]*:|[dtf]:)/.exec(l)?.[0];
    if (!head) continue;
    const body = l.slice(head.length);
    if (!body.includes('*') || body.replace(/\*/g, '').trim().length < 2) continue;
    patterns.push(new RegExp('^' + escape(head) + body.split('*').map(escape).join('.+') + '$'));
  }
  return (line) => exact.has(line) || patterns.some((re) => re.test(line));
}

/** 2 つの骨格の違い（人が読む用）。再現した画面が元と違ったときや、なぜ別の画面になったかの説明に使う */
export function structureDiff(a: string, b: string, limit = 8): { onlyA: string[]; onlyB: string[] } {
  const A = new Set(a.split('\n'));
  const B = new Set(b.split('\n'));
  return {
    onlyA: [...A].filter((x) => !B.has(x)).slice(0, limit),
    onlyB: [...B].filter((x) => !A.has(x)).slice(0, limit),
  };
}
