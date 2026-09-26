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

/** データ値をテキストから消す。見出し「サービス業の企業一覧」を「*の企業一覧」にして、業種違いの画面を合流させる */
export function scrub(text: string, dataValues: string[]): string {
  let out = text;
  for (const v of [...dataValues].sort((a, b) => b.length - a.length)) {
    if (v.length < 2 || /^\d+$/.test(v)) continue;
    out = out.split(v).join('*');
  }
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
export function actionKey(a: ActionLike, pageUrl: string, ctx: NormalizeContext, dataValues: string[]): string {
  if (a.href) {
    let abs: URL | undefined;
    try { abs = new URL(a.href, pageUrl); } catch { abs = undefined; }
    if (abs && /^https?:$/.test(abs.protocol)) {
      const r = normalizeRoute(abs.href, ctx);
      return `${a.role}|${r ? r.route : `//${abs.host}`}`;
    }
  }
  if (a.toggle) return `${a.role}|~`;
  return `${a.role}|${scrub(normalizeDigits(a.label), dataValues)}`;
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
 * - 今の画面と同じルートへのリンク（ページ送り・絞り込み・ページ内リンク）は画面の見方を変えるだけなので入れない。
 * - 開閉の操作はラベルを見ない（actionKey）。
 * - データ区間を持つルート（`/company/*`）の h1 はデータの名前（企業名・商品名）であることが多く、URL からは消せないので、
 *   文言を捨てて h1 があることだけを残し、その文言を他の見出しとラベルからも消す。h2 以下は残すのでタブや節の違いは区別できる。
 * - volatileSelectors の中の要素は入れない（在庫の少ない商品、最近見たもの、時計など）。
 */
export function structureOf(snap: StructureInput, pageUrl: string, ctx: NormalizeContext, route: Route): string {
  const values = [...route.dataValues];
  const h1 = snap.headings.find((h) => h.tag === 'h1');
  if (route.dataDriven && h1 && h1.text.trim().length >= 2) values.push(h1.text.trim());
  const clean = (s: string) => scrub(normalizeDigits(s), values);
  const lines: string[] = [];
  if (snap.dialog !== undefined) lines.push(`d:${clean(snap.dialog)}`);
  for (const t of uniqSorted((snap.selectedTabs ?? []).map(clean))) lines.push(`t:${t}`);
  for (const h of snap.headings) lines.push(route.dataDriven && h.tag === 'h1' ? 'h:h1' : `h:${h.tag}:${clean(h.text)}`);
  const acts: string[] = [];
  for (const a of snap.actions) {
    if (a.volatile) continue;
    const key = actionKey(a, pageUrl, ctx, values);
    if (a.href && key === `${a.role}|${route.route}`) continue; // 同じルートへのリンク
    acts.push(`a:${key}`);
  }
  lines.push(...uniqSorted(acts));
  lines.push(...uniqSorted(snap.formFields.map((f) => `f:${normalizeDigits(f)}`)));
  return lines.join('\n');
}

export interface SignatureResult {
  signature: string;
  /** 同一オリジンなら正規化ルート。別オリジンなら undefined */
  route?: string;
  dataValues: string[];
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
    return { signature: sha1(`ext|${ext}`).slice(0, 12), dataValues: [], structure: ext };
  }
  const headings = snap.headings.map((text, i) => ({ tag: snap.headingTags[i] ?? 'h2', text }));
  const structure = structureOf({ headings, actions: snap.actions, formFields: snap.formFields, dialog: snap.dialog, selectedTabs: snap.selectedTabs }, snap.url, ctx, r);
  return { signature: sha1(`${r.route}||${structure}`).slice(0, 12), route: r.route, dataValues: r.dataValues, structure };
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
