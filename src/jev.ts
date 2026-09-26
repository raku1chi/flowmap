// Jev（TypeSafe の型付き判定モデル）による判定。探索エンジンの機械的ルールの上に足す、任意の層。
//
// 使いどころは 3 つで、どれも「押さない操作を増やす」「合流を増やす」方向にだけ働く（DESIGN.md §5・§7）。
//   actions : その操作はサーバーのデータを変えるか。denyText に加えて、危険と判定した操作を押さない
//   pages   : 同じ区画の 2 画面は同じ画面か。同じと判定したら既存のノードに合流させる
//   links   : 機械的ルールが見つけたデータ区間の候補を認めるか。認めたときだけ学習する
//
// 問いと閾値の根拠は experiments/jev/README.md の試験結果。
// Jev の値は同じ入力でも実行ごとに少し揺れるので、答えはキャッシュして実行間の比較（§10）を安定させる。
// 送るのは画面のタイトル・見出し・操作のラベル・URL のパスとクエリ（機微な名前の値は伏せる）だけで、
// 認証情報・スクリーンショット・本文は送らない。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Snapshot } from './explore.js';
import { actionKey, normalizeDigits, normalizeRoute, type NormalizeContext } from './normalize.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const CONCURRENCY = 4;
const TIMEOUT_MS = 30_000;

// ---------- 問い ----------
// 1 つの問いに 1 つの条件だけを書き、境界の例は criteria に置く（公式ガイド「Literal reading」）。
// 日本語と英語の問いを同じリクエストで聞き（並列に評価されるので遅くならない）、判断の向きに合わせて組み合わせる。

export type JudgeKind = 'links' | 'pages' | 'actions';
export type Variant = 'ja' | 'en';

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

export const QUESTIONS: Record<JudgeKind, Record<Variant, NoulQuestion>> = {
  links: {
    ja: {
      type: 'noul',
      instructions: '`links` のリンクはどれも、同じ作りの画面を、別々の対象（データ）について開く',
      criteria: {
        true: 'リンク先はどれも同じ作りの画面で、違うのは表示する対象のデータだけ（例: 都道府県ごとの店舗一覧、記事ごとのページ）',
        false: 'リンク先はそれぞれ目的の違う画面（例: ヘルプ、利用規約、プライバシーポリシー）',
      },
    },
    en: {
      type: 'noul',
      instructions: 'Every link in `links` opens the same page layout for a different data record.',
      criteria: {
        true: 'All targets share one page layout; only the record shown differs (for example, a store list per prefecture, or a page per article).',
        false: 'Each target is a different page with its own purpose (for example, help, terms of service, privacy policy).',
      },
    },
  },
  // pages の 1 つの問い。探索では下の PAGE_SPLIT を使い、これは試験での比較用に残す
  pages: {
    ja: {
      type: 'noul',
      // 初版は「同じ画面に別のデータを表示したもの」と書いた。すると違いのない 2 画面が字義どおり「別のデータではない」と判定された
      instructions: '`page_a` と `page_b` は同じ画面である（表示しているデータは同じでも違ってもよい）',
      criteria: {
        true: '画面の種類と目的が同じ。違いがない、または違いが表示しているデータ（対象・件数・検索語・ページ番号・絞り込み条件）と、データの量や有無によって出たり消えたりする部品だけ',
        false: '画面の種類や目的が違う。または同じ画面でも、タブの切り替え・メニューの開閉・ダイアログの表示など、利用者の操作で UI の状態が違う',
      },
    },
    en: {
      type: 'noul',
      instructions: '`page_a` and `page_b` are the same page (the data shown may be the same or different).',
      criteria: {
        true: 'Same kind of page with the same purpose. Either nothing differs, or the only differences are the data shown (which record, how many items, search terms, page number, filters) and parts that appear or disappear depending on how much data there is.',
        false: 'Different kinds of pages or different purposes, or the same page in a different UI state caused by the user, such as another tab selected, a menu opened, or a dialog shown.',
      },
    },
  },
  actions: {
    ja: {
      type: 'noul',
      instructions: '`label` の操作を実行すると、サーバーに記録されたデータが作られる・変わる・消える、または誰かに何かが送られる',
      criteria: {
        true: '記録（注文・投稿・設定・アカウント・ログイン状態など）が作られる・変わる・消える、または相手に通知や送信が届く',
        false: '見る画面や表示のされ方が変わるだけで、記録されたデータは変わらない',
      },
    },
    en: {
      type: 'noul',
      instructions: 'Performing the action `label` creates, changes, or deletes data stored on the server, or sends something to someone.',
      criteria: {
        true: 'A stored record (an order, a post, a setting, an account, a login session) is created, changed, or deleted, or a message or notification reaches someone.',
        false: 'Only what the user is looking at or how it is displayed changes; stored data stays the same.',
      },
    },
  },
};

/**
 * pages の判断を 2 つの問いに分けたもの（公式ガイド「解釈が避けられないときは 2 つの字義どおりの問いに分け、コードで組み合わせる」）。
 * 合流の度合い = min(same_kind, 1 - ui_state)。種類が同じで、かつ違いが UI 操作によるものではないときだけ高くなる。
 * 違いのない 2 画面はコードで「同じ」と決めるので、ここには来ない。
 */
export const PAGE_SPLIT: Record<'same_kind' | 'ui_state', NoulQuestion> = {
  same_kind: {
    type: 'noul',
    instructions: '`page_a` と `page_b` は、種類と目的が同じ画面である',
    criteria: {
      true: '同じ作りの画面で、違いは表示している対象・件数・検索語・ページ番号・絞り込み条件などのデータと、データの量や有無で出たり消えたりする部品だけ',
      false: '画面の種類や目的が違う',
    },
  },
  ui_state: {
    type: 'noul',
    instructions: '`differences` の違いは、利用者が同じ画面の中で UI を操作して表示を切り替えたことによるものである',
    criteria: {
      true: 'タブの切り替え、メニューや折りたたみの開閉、ダイアログの表示など、画面の中の UI の操作で出たり消えたりした違い',
      false: '表示しているデータの違い、または別の画面であることによる違い',
    },
  },
};

/** pages の state の差分が空か（空ならコードで「同じ画面」と決める） */
export function hasNoDifference(state: unknown): boolean {
  const d = (state as { differences?: { only_in_page_a: unknown[]; only_in_page_b: unknown[] } }).differences;
  return !!d && d.only_in_page_a.length === 0 && d.only_in_page_b.length === 0;
}

/** 分けた 2 つの問いを 1 つの「合流してよい度合い」にまとめる */
export function mergeScore(state: unknown, sameKind: number, uiState: number): number {
  return hasNoDifference(state) ? 1 : Math.min(sameKind, 1 - uiState);
}

// ---------- Jev に渡す形 ----------

const ROLE_JA: Record<string, string> = { link: 'リンク', button: 'ボタン', tab: 'タブ', menuitem: 'メニュー', summary: '開閉' };
/** 値を伏せるクエリの名前。外部に送る URL から認証トークンなどを落とす */
const SENSITIVE_PARAM = /token|key|secret|pass|session|auth|code|sig|jwt|otp|nonce|email|mail/i;

const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
export const clip = (s: string, n = 40): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const formLabel = (f: string): string => { const [tag, type, name] = f.split(':'); return [type || tag, name].filter(Boolean).join(' '); };

/** URL をパスとクエリの読める形にする。機微な名前のクエリは値を伏せる */
export function maskedPath(url: string, base?: string): string {
  let u: URL;
  try { u = new URL(url, base); } catch { return url; }
  const params = [...u.searchParams].map(([k, v]) => `${k}=${SENSITIVE_PARAM.test(k) ? '***' : v}`);
  return decode(u.pathname) + (params.length ? `?${params.join('&')}` : '');
}

/** 画面の要約。Jev は関係のない情報が多いと精度が落ちるので、同じ形のリンクは 2 件の例だけにする */
export function summarize(snap: Snapshot, ctx: NormalizeContext) {
  const dataValues = normalizeRoute(snap.url, ctx)?.dataValues ?? [];
  const linkShapes = new Map<string, string[]>();
  const controls: string[] = [];
  for (const a of snap.actions) {
    const label = clip(a.label);
    if (a.role === 'link') {
      const k = actionKey(a, snap.url, ctx, dataValues);
      const list = linkShapes.get(k) ?? [];
      if (list.length < 2 && !list.includes(label)) list.push(label);
      linkShapes.set(k, list);
    } else {
      const c = `${ROLE_JA[a.role] ?? a.role}「${label}」`;
      if (!controls.includes(c)) controls.push(c);
    }
  }
  return {
    title: snap.title,
    url: maskedPath(snap.url),
    headings: snap.headings.slice(0, 8).map((h) => clip(h, 60)),
    links: [...linkShapes.values()].flat().slice(0, 24),
    controls: controls.slice(0, 12),
    form_fields: [...new Set(snap.formFields.map(formLabel))],
  };
}

/** 2 画面の差分を人が読める形にする。リンクは行き先の形で束ねるので、一覧の行の違いは差分に出ない */
function readableItems(snap: Snapshot, ctx: NormalizeContext): Map<string, string> {
  const dataValues = normalizeRoute(snap.url, ctx)?.dataValues ?? [];
  const items = new Map<string, string>();
  snap.headings.forEach((h, i) => items.set(`h|${snap.headingTags[i] ?? 'h2'}|${normalizeDigits(h)}`, `見出し「${clip(h, 60)}」`));
  for (const a of snap.actions) {
    const k = `a|${actionKey(a, snap.url, ctx, dataValues)}`;
    if (!items.has(k)) items.set(k, `${ROLE_JA[a.role] ?? a.role}「${clip(a.label)}」`);
  }
  for (const f of snap.formFields) items.set(`f|${f}`, `入力欄「${formLabel(f)}」`);
  return items;
}

export function differences(a: Snapshot, b: Snapshot, ctx: NormalizeContext) {
  const A = readableItems(a, ctx);
  const B = readableItems(b, ctx);
  return {
    only_in_page_a: [...A].filter(([k]) => !B.has(k)).map(([, v]) => v).slice(0, 12),
    only_in_page_b: [...B].filter(([k]) => !A.has(k)).map(([, v]) => v).slice(0, 12),
  };
}

/** pages の問いに渡す state */
export function pairState(a: Snapshot, b: Snapshot, ctx: NormalizeContext) {
  return { page_a: summarize(a, ctx), page_b: summarize(b, ctx), differences: differences(a, b, ctx) };
}

// ---------- API ----------

/** 環境変数 TYPESAFE_API_KEY か、カレントの .env から読む。見つからなければ undefined */
export function loadApiKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  if (!existsSync('.env')) return undefined;
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/);
    if (m && m[1]) return m[1].replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

export interface NoulAnswer { type: 'noul'; noul: number }
export interface ApiResult { model: string; answers: Record<string, NoulAnswer>; usage: { input_tokens: number; output_tokens: number }; ms: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HTTP API を 1 回呼ぶ。429（レート制限）・529（混雑）・5xx・通信失敗は指数バックオフで 4 回まで再試行する（公式の推奨） */
export async function callJev(key: string, body: unknown): Promise<ApiResult> {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt < 4) { await sleep(500 * 2 ** attempt); continue; }
      throw e;
    }
    if (res.ok) return { ...((await res.json()) as Omit<ApiResult, 'ms'>), ms: Date.now() - t0 };
    const text = await res.text();
    if ([429, 500, 502, 503, 504, 529].includes(res.status) && attempt < 4) { await sleep(500 * 2 ** attempt); continue; }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

// ---------- 判定 ----------

export interface JevStats {
  requests: number;
  cacheHits: number;
  errors: number;
  lastError?: string;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/**
 * 探索エンジンから使う判定。答えは (モデル, 問い, state) のハッシュでファイルにキャッシュする。
 * 問い合わせに失敗した判定は undefined を返し、呼び出し側は機械的ルールだけで進める。
 */
export class JevJudge {
  readonly stats: JevStats = { requests: 0, cacheHits: 0, errors: 0 };
  private cache: Record<string, Record<string, number>> = {};
  private dirty = false;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  private constructor(private readonly key: string, readonly model: string, private readonly cachePath: string) {}

  /** キーを確かめ、キャッシュを読み込む。キーが無い・通らないときは探索の前に止める */
  static async open(opts: { model: string; cachePath: string }): Promise<JevJudge> {
    const key = loadApiKey();
    if (!key) throw new Error('Jev を使うには TYPESAFE_API_KEY が必要です。.env.example を .env にコピーしてキーを入れてください。');
    const judge = new JevJudge(key, opts.model, opts.cachePath);
    if (existsSync(opts.cachePath)) {
      try {
        const saved = JSON.parse(readFileSync(opts.cachePath, 'utf8')) as { version?: number; entries?: Record<string, Record<string, number>> };
        if (saved.version === 1 && saved.entries) judge.cache = saved.entries;
      } catch { /* 壊れたキャッシュは捨てて作り直す */ }
    }
    try {
      await callJev(key, { model: opts.model, state: 'flowmap connection check', questions: { ok: { type: 'noul', instructions: 'This is a connection check.' } } });
    } catch (e) {
      throw new Error(`Jev に接続できません（${(e as Error).message.split('\n')[0]}）。キーとネットワークを確認してください。`);
    }
    return judge;
  }

  /** 操作がサーバーのデータを変える度合い。日英の問いの大きいほうを採る（押さない側に倒す） */
  async actionScore(page: string, action: { role: string; label: string }): Promise<number | undefined> {
    const r = await this.safe(() => this.ask({ page, element: action.role, label: clip(action.label, 80) }, QUESTIONS.actions));
    return r ? Math.max(r.ja, r.en) : undefined;
  }

  /** 2 画面が同じ画面である度合い。差分が無ければ聞かずに 1 */
  async sameScreenScore(a: Snapshot, b: Snapshot, ctx: NormalizeContext): Promise<number | undefined> {
    const state = pairState(a, b, ctx);
    if (hasNoDifference(state)) return 1;
    const r = await this.safe(() => this.ask(state, PAGE_SPLIT));
    return r ? mergeScore(state, r.same_kind, r.ui_state) : undefined;
  }

  /** リンク群が同じ作りの画面を別データについて開く度合い。日英の問いの小さいほうを採る（合流しない側に倒す） */
  async dataGroupScore(page: { title: string; heading: string; url: string }, links: { label: string; href: string }[]): Promise<number | undefined> {
    const r = await this.safe(() => this.ask({ page, links }, QUESTIONS.links));
    return r ? Math.min(r.ja, r.en) : undefined;
  }

  /** キャッシュを書き出す */
  save(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify({ version: 1, entries: this.cache }));
    this.dirty = false;
  }

  private async safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = (e as Error).message.split('\n')[0];
      return undefined;
    }
  }

  private async ask(state: unknown, questions: Record<string, NoulQuestion>): Promise<Record<string, number>> {
    const cacheKey = sha1(JSON.stringify({ model: this.model, questions, state }));
    const hit = this.cache[cacheKey];
    if (hit) {
      this.stats.cacheHits++;
      return hit;
    }
    await this.acquire();
    try {
      const r = await callJev(this.key, { model: this.model, state, questions });
      this.stats.requests++;
      const answers = Object.fromEntries(Object.entries(r.answers).map(([k, v]) => [k, v.noul]));
      this.cache[cacheKey] = answers;
      this.dirty = true;
      return answers;
    } finally {
      this.release();
    }
  }

  // 同時に投げるリクエストを CONCURRENCY 本までに抑える
  private async acquire(): Promise<void> {
    if (this.active < CONCURRENCY) { this.active++; return; }
    await new Promise<void>((resolve) => this.waiting.push(resolve)); // release から枠を直接受け取る
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
