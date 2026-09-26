// URL とラベルの正規化。探索エンジンから切り離した純粋関数で、ブラウザに依存しない。
//
// 目的は「同じテンプレートに違うデータを流し込んだ画面」を 1 つのノードに合流させること。
// ZAP の Data Driven Content と同じ発想で、URL の「データを表す区間」を `*` に置き換える。
// 区間の決め方は 2 つある。
//   1. 設定 pathRules（正規表現）で人が宣言する
//   2. 同じ画面に「1 区間だけ違う同じ形の href」が minSiblings 本以上あれば、その区間をデータとみなす（自動学習）

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
  /** queryParams が names のときも値を残すパラメータ名（ZAP の Structural Parameter に相当） */
  structuralParams: string[];
}

/** 数字を `#` に潰す。桁区切りや小数（`1,001` `4.5`）も 1 つの数として扱う。件数が 3 桁から 4 桁に増えても形が変わらないように */
export const normalizeDigits = (s: string): string => s.replace(/\d+(?:[,.]\d+)*/g, '#');

const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

const splitSegments = (pathname: string): string[] => pathname.split('/').filter(Boolean).map(decode);

/** 設定の pathRules をデコード済みパスに適用する */
function applyPathRules(path: string, rules: PathRule[]): string {
  let out = path;
  for (const r of rules) {
    try { out = out.replace(new RegExp(r.pattern), r.replace); } catch { /* 不正な正規表現は無視 */ }
  }
  return out;
}

/** 区間列を学習済みルールと数字正規化で畳み、データとみなした区間の元の値も返す */
function normalizeSegments(segs: string[], learned: Set<string>): { norm: string[]; dataValues: string[] } {
  const norm: string[] = [];
  const dataValues: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const prefix = '/' + norm.join('/');
    if (i >= 1 && learned.has(prefix)) {
      norm.push('*');
      dataValues.push(segs[i]);
    } else {
      norm.push(normalizeDigits(segs[i]));
    }
  }
  return { norm, dataValues };
}

function normalizeQuery(search: string, ctx: NormalizeContext): string {
  if (ctx.queryParams === 'ignore' || !search) return '';
  const params = new URLSearchParams(search);
  const parts: string[] = [];
  for (const [k, v] of params) {
    if (ctx.queryParams === 'values' || ctx.structuralParams.includes(k)) parts.push(`${k}=${normalizeDigits(v)}`);
    else parts.push(k);
  }
  return [...new Set(parts)].sort().join('&');
}

export interface Route {
  /** シグネチャに使う正規化済みのパス（+ クエリ）。例 `/companies/*?axes` */
  route: string;
  /** データとみなして `*` に置き換えた区間の元の値。見出しやラベルから同じ値を消すのに使う */
  dataValues: string[];
}

/** 同一オリジンの URL を正規化する。別オリジンなら undefined */
export function normalizeRoute(url: string, ctx: NormalizeContext): Route | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  if (u.origin !== ctx.origin) return undefined;

  const original = splitSegments(u.pathname);
  const dataValues: string[] = [];

  // 1. 設定ルール。区間数が変わらない置換なら、変わった区間の元の値をデータ値として記録する
  const ruledPath = applyPathRules('/' + original.join('/'), ctx.pathRules);
  const ruled = ruledPath.split('/').filter(Boolean);
  if (ruled.length === original.length) {
    for (let i = 0; i < ruled.length; i++) if (ruled[i] !== original[i]) dataValues.push(original[i]);
  }

  // 2. 自動学習したルールと数字の正規化
  const { norm, dataValues: learnedValues } = normalizeSegments(ruled, ctx.learnedPrefixes);
  dataValues.push(...learnedValues);

  const query = normalizeQuery(u.search, ctx);
  return { route: '/' + norm.join('/') + (query ? '?' + query : ''), dataValues };
}

export interface LinkItem {
  href: string;
  label?: string;
}

/** データ区間の候補。prefix の直後の区間がデータだとみなせる理由として、兄弟リンクの例を持つ */
export interface SegmentProposal {
  prefix: string;
  examples: LinkItem[];
}

/**
 * 同じ画面にある href から「1 区間だけ違う同じ形の URL」の群を探し、データ区間の候補として返す（ctx は変えない）。
 * 先頭区間（`/about` `/contact` のようなトップレベルの経路）は対象にしない。
 * exclude に入っている親パス（Jev が退けた候補など）は返さない。
 */
export function proposeDataSegments(items: LinkItem[], pageUrl: string, ctx: NormalizeContext, minSiblings = 3, exclude?: Set<string>): SegmentProposal[] {
  const groups = new Map<string, { prefix: string; values: Set<string>; examples: LinkItem[] }>();
  for (const item of items) {
    let u: URL;
    try { u = new URL(item.href, pageUrl); } catch { continue; }
    if (u.origin !== ctx.origin) continue;
    const segs = splitSegments(u.pathname);
    if (segs.length < 2) continue;
    const { norm } = normalizeSegments(segs, ctx.learnedPrefixes);
    for (let i = 1; i < segs.length; i++) {
      if (norm[i] === '*') continue; // 既に学習済み
      const prefix = '/' + norm.slice(0, i).join('/');
      if (ctx.learnedPrefixes.has(prefix) || exclude?.has(prefix)) continue;
      const shape = norm.map((s, j) => (j === i ? '*' : s)).join('/');
      const key = `${i}|${shape}`;
      const g = groups.get(key) ?? { prefix, values: new Set<string>(), examples: [] };
      if (!g.values.has(segs[i]) && g.examples.length < 8) g.examples.push({ href: u.href, label: item.label });
      g.values.add(segs[i]);
      groups.set(key, g);
    }
  }
  // 同じ親パスの群が複数あれば 1 つの候補にまとめる
  const byPrefix = new Map<string, SegmentProposal>();
  for (const g of groups.values()) {
    if (g.values.size < minSiblings) continue;
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
  for (const v of dataValues) {
    if (v.length < 2 || /^\d+$/.test(v)) continue;
    out = out.split(v).join('*');
  }
  return out;
}

export interface ActionLike {
  role: string;
  label: string;
  href?: string;
}

/**
 * 操作の「形」。同じ形の操作は同種とみなす。
 * リンクは行き先の正規化ルートで、それ以外はラベルで決める。一覧の各行のリンクはこれで 1 つに畳まれる。
 * 別オリジンへのリンクはホスト名だけで表す。外部サイトの URL に含まれる ID（EDINET の書類番号など）はこのアプリのデータであり、
 * 外部サイトは撮影しかしないので、行き先の細部で画面を区別する意味がない。
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
  actions: ActionLike[];
  formFields: string[];
}

/**
 * 画面の骨格。見出し・操作対象・フォーム項目から作る。
 * 同じ形の操作は 1 つに畳み、並べ替えるので、一覧の件数や節の順が変わっても骨格は変わらない。
 * データ区間を持つルート（`/company/*`）の h1 はデータの名前（企業名・商品名）であることが多く、
 * URL からは消せないので、文言を捨てて h1 があることだけを残す。h2 以下は残すのでタブや節の違いは区別できる。
 */
export function structureOf(snap: StructureInput, pageUrl: string, ctx: NormalizeContext, route: Route): string {
  const dataDriven = route.route.includes('*');
  return [
    ...snap.headings.map((h) => (dataDriven && h.tag === 'h1' ? 'h:h1' : `h:${h.tag}:${scrub(normalizeDigits(h.text), route.dataValues)}`)),
    ...uniqSorted(snap.actions.map((a) => `a:${actionKey(a, pageUrl, ctx, route.dataValues)}`)),
    ...uniqSorted(snap.formFields.map((f) => `f:${f}`)),
  ].join('\n');
}
