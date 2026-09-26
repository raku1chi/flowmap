// 探索のワーカー 1 つ分。ブラウザコンテキストの作り直し（起点からの再現のたびに最初の状態へ戻す）、
// 画面が落ち着くまでの待ち、操作対象の再特定とクリック、撮影、エラーの収集を受け持つ（DESIGN.md §4）。

import { createHash } from 'node:crypto';
import type { Browser, BrowserContext, Page, Request } from 'playwright';
import type { ActionDesc, FlowmapConfig } from './types.js';
import {
  fillScopeInBrowser, installTracker, NAME_SHIM, quietForInBrowser, snapshotInBrowser, storageDigestInBrowser,
  type EnumerateOptions, type RawAction, type Snapshot,
} from './inpage.js';
import { actionKey, normalizeDigits, type NormalizeContext } from './normalize.js';

/** 長く開いたままの通信（ロングポーリング等）は、この時間を過ぎたら「通信中」に数えない */
const LONG_REQUEST_MS = 3000;
/** 落ち着き判定で、最後の通信からこの時間は待つ（DOM の更新が通信の直後に来るため） */
const NET_QUIET_MS = 250;
const POLL_MS = 50;
const STABILIZE_INTERVAL_MS = 250;
const IGNORED_TYPES = new Set(['eventsource', 'websocket', 'media', 'manifest', 'ping', 'beacon']);
/** 画面遷移で途中の読み込みが打ち切られただけのもの。失敗したリクエストとしては数えない */
const BENIGN_FAILURE = /ERR_ABORTED|NS_BINDING_ABORTED|ERR_BLOCKED_BY_CLIENT|cancelled|canceled/i;

/** FLOWMAP_DEBUG=1 のとき、処理ごとの所要時間を集計する（遅い原因を調べる用） */
export const PROFILE = new Map<string, { n: number; ms: number }>();
const PROFILING = !!process.env.FLOWMAP_DEBUG;
async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!PROFILING) return fn();
  const t0 = performance.now();
  try { return await fn(); } finally {
    const p = PROFILE.get(name) ?? { n: 0, ms: 0 };
    p.n++; p.ms += performance.now() - t0;
    PROFILE.set(name, p);
  }
}

export type StorageStateObject = Exclude<NonNullable<Parameters<Browser['newContext']>[0]>['storageState'], string | undefined>;

export class NavigationError extends Error { override name = 'NavigationError'; }
export class ActionError extends Error { override name = 'ActionError'; }

const ROLE_JA: Record<string, string> = { link: 'リンク', button: 'ボタン', tab: 'タブ', menuitem: 'メニュー', summary: '開閉' };
export const describeAction = (a: { role: string; label: string; href?: string; nth: number }): string => {
  const base = `「${a.label || a.href}」${ROLE_JA[a.role] ?? a.role}`;
  return a.nth > 1 ? `${base}(${a.nth})` : base;
};

const firstLine = (e: unknown): string => String((e as Error)?.message ?? e).split('\n')[0];

/** Playwright のクリック失敗から、理由の行（覆われている・無効・見えない）を取り出す */
export function clickFailureReason(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  const lines = msg.split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
  const reason = [...lines].reverse().find((l) => /intercepts pointer events|element is not|element is outside|not attached|detached/.test(l));
  return (reason ?? lines[0] ?? 'unknown').slice(0, 200);
}

/** 経路の再生で、記録した操作を今の画面の操作対象から見つけ直す */
export function findTarget(actions: RawAction[], want: ActionDesc, pageUrl: string, ctx: NormalizeContext): { target?: RawAction; substituted?: boolean } {
  const exact = actions.find((a) => a.role === want.role && a.label === want.label && a.nth === want.nth);
  if (exact) return { target: exact };
  if (want.testId) {
    const byId = actions.filter((a) => a.role === want.role && a.testId === want.testId);
    if (byId.length === 1) return { target: byId[0] };
  }
  // ラベル中の数字（件数・ページ番号など）はデータで、別の操作の影響で変わることがある。数字を潰した一致で探し直す
  const shape = normalizeDigits(want.label);
  const similar = actions.filter((a) => a.role === want.role && normalizeDigits(a.label) === shape);
  if (similar.length) return { target: similar[want.nth - 1] ?? similar[0] };
  // 開閉の操作はラベルに今の値が出る。同じ役割の開閉が 1 つしか無ければそれとみなす
  if (want.toggle) {
    const toggles = actions.filter((a) => a.role === want.role && a.toggle && (!want.testId || a.testId === want.testId));
    if (toggles.length === 1) return { target: toggles[0] };
  }
  // データ区間のリンク（企業名・商品名など）は、データが入れ替わると一覧から消える。
  // 行き先が同じ形の別のリンクで代用する（合流させた画面なので、どの実例でも同じ種類の画面に着く）
  if (want.href) {
    const key = actionKey(want, pageUrl, ctx, []);
    if (key.includes('*')) {
      const sub = actions.find((a) => a.href && actionKey(a, pageUrl, ctx, []) === key);
      if (sub) return { target: sub, substituted: true };
    }
  }
  return {};
}

export interface SessionOptions {
  config: FlowmapConfig;
  storageState?: StorageStateObject;
  enumerate: EnumerateOptions;
  ctx: NormalizeContext;
  /** 代用などの注意を知らせる（同じ内容は呼び出し側でまとめる） */
  warn?: (msg: string) => void;
}

/**
 * ブラウザコンテキスト 1 つ分の作業場。fresh() のたびに storageState だけを持った新しいコンテキストを作るので、
 * 前の試行で localStorage・Cookie・IndexedDB・メモリ上の状態が変わっていても、次の再現には持ち越さない。
 */
export class Session {
  private context?: BrowserContext;
  private pageRef?: Page;
  private inflight = new Map<Request, number>();
  private lastNet = 0;
  private consoleErrors: string[] = [];
  private failedRequests: string[] = [];
  private crashed = false;
  /** 読み込みに失敗したページ遷移の URL。エラーページ（chrome-error://）の代わりに行き先として記録する */
  private failedNavigation?: string;
  private readonly blockRes: RegExp[];

  constructor(private readonly browser: Browser, private readonly opts: SessionOptions) {
    this.blockRes = opts.config.blockUrlPatterns.map((p) => new RegExp(p, 'i'));
  }

  get page(): Page {
    if (!this.pageRef) throw new Error('ページがありません（fresh() を先に呼ぶ）');
    return this.pageRef;
  }

  /** 新しいコンテキストとページを作る（前のものは閉じる） */
  async fresh(): Promise<Page> {
    return timed('fresh', () => this.freshInner());
  }

  private async freshInner(): Promise<Page> {
    await this.close();
    const c = this.opts.config;
    const context = await this.browser.newContext({
      viewport: c.viewport,
      acceptDownloads: false,
      storageState: this.opts.storageState,
      locale: c.locale,
      timezoneId: c.timezoneId ?? undefined,
      reducedMotion: 'reduce',
      serviceWorkers: c.serviceWorkers,
    });
    this.context = context;
    await context.addInitScript(NAME_SHIM);
    await context.addInitScript(installTracker, { hideSelectors: c.hideSelectors, volatileSelectors: c.volatileSelectors });
    if (this.blockRes.length) {
      await context.route((url) => this.blockRes.some((re) => re.test(url.href)), (route) => route.abort('blockedbyclient'));
    }
    const page = await context.newPage();
    page.setDefaultTimeout(c.actionTimeoutMs);
    page.setDefaultNavigationTimeout(c.navigationTimeoutMs);
    // 別タブが開いたら閉じる（最初のページを作ってから登録する）
    context.on('page', (p) => { if (p !== page) p.close().catch(() => {}); });
    this.inflight = new Map();
    this.lastNet = Date.now();
    this.consoleErrors = [];
    this.failedRequests = [];
    this.crashed = false;
    this.failedNavigation = undefined;
    page.on('framenavigated', (f) => { if (f === page.mainFrame() && !f.url().startsWith('chrome-error:')) this.failedNavigation = undefined; });
    page.on('request', (r) => {
      this.lastNet = Date.now();
      if (!IGNORED_TYPES.has(r.resourceType())) this.inflight.set(r, Date.now());
    });
    const done = (r: Request) => { this.inflight.delete(r); this.lastNet = Date.now(); };
    page.on('requestfinished', done);
    page.on('requestfailed', (r) => {
      done(r);
      const why = r.failure()?.errorText ?? 'failed';
      if (!BENIGN_FAILURE.test(why)) {
        this.failedRequests.push(`${r.method()} ${r.url()} (${why})`);
        if (r.isNavigationRequest() && r.frame() === page.mainFrame()) this.failedNavigation = r.url();
      }
    });
    page.on('response', (r) => { if (r.status() >= 400) this.failedRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
    page.on('console', (m) => { if (m.type() === 'error') this.consoleErrors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => this.consoleErrors.push(String(e.message ?? e).slice(0, 300)));
    page.on('dialog', (d) => { (c.dialogs === 'dismiss' && d.type() !== 'alert' ? d.dismiss() : d.accept()).catch(() => {}); });
    page.on('crash', () => { this.crashed = true; });
    this.pageRef = page;
    return page;
  }

  async close(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    this.pageRef = undefined;
    if (ctx) await ctx.close().catch(() => {});
  }

  /** 収集したエラーを読み出して空にする */
  drain(): { consoleErrors: string[]; failedRequests: string[] } {
    const r = { consoleErrors: [...new Set(this.consoleErrors)], failedRequests: [...new Set(this.failedRequests)] };
    this.consoleErrors = [];
    this.failedRequests = [];
    return r;
  }

  private pendingRequests(): number {
    const now = Date.now();
    let n = 0;
    for (const t of this.inflight.values()) if (now - t < LONG_REQUEST_MS) n++;
    return n;
  }

  /**
   * 画面が落ち着くまで待つ。通信が途切れ（NET_QUIET_MS）、DOM の変化が quietMs 止まったら落ち着いたとみなす。
   * 操作の直後は変化がまだ始まっていないことがあるので、最低 quietMs は待つ。上限は settleTimeoutMs。
   * 落ち着いたら true、上限に達したら false。
   */
  settle(): Promise<boolean> {
    return timed('settle', () => this.settleInner());
  }

  private async settleInner(): Promise<boolean> {
    const c = this.opts.config;
    const start = Date.now();
    const deadline = start + c.settleTimeoutMs;
    const page = this.page;
    try { await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadline - Date.now()) }); } catch { /* 上限まで待った */ }
    let quiet = false;
    while (Date.now() < deadline) {
      if (this.crashed) break;
      const now = Date.now();
      let domQuiet = 0;
      try { domQuiet = await page.evaluate(quietForInBrowser); } catch { domQuiet = 0; /* 遷移中 */ }
      if (now - start >= c.quietMs && this.pendingRequests() === 0 && now - this.lastNet >= NET_QUIET_MS && domQuiet >= c.quietMs) { quiet = true; break; }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (c.settleMs) await page.waitForTimeout(c.settleMs);
    return quiet;
  }

  /** page.evaluate を、遷移中で実行文脈が壊れたときだけ少し待って再試行する */
  private async evaluate<A, R>(fn: (arg: A) => R, arg: A): Promise<R> {
    for (let attempt = 0; ; attempt++) {
      try {
        // Playwright の evaluate の型は総称の引数を受け付けないので、呼び出しの形だけ合わせる
        return await (this.page.evaluate as unknown as (f: (a: A) => R, a: A) => Promise<R>).call(this.page, fn, arg);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (attempt < 3 && /Execution context was destroyed|Cannot find context|navigat|Target closed.*frame|detached/i.test(msg) && !this.crashed) {
          try { await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch { /* 次の試行で分かる */ }
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  async snapshot(mark?: { index: number; expect: { role: string; label: string } }): Promise<Snapshot> {
    const snap = await timed('snapshot', () => this.evaluate(snapshotInBrowser, { ...this.opts.enumerate, markIndex: mark?.index, markExpect: mark?.expect }));
    // 開けなかったページ（DNS・証明書の失敗など）はブラウザのエラーページになる。行き先の URL で記録する
    if (snap.url.startsWith('chrome-error:') && this.failedNavigation) snap.url = this.failedNavigation;
    return snap;
  }

  /**
   * 撮影用のスナップショット。落ち着き待ちが上限に達した画面（読み込み途中かもしれない）は、
   * 骨格の指紋が 2 回続けて同じになるまで stabilizeMs を上限に撮り直す。
   */
  async stableSnapshot(settled: boolean): Promise<Snapshot> {
    let snap = await this.snapshot();
    if (settled) return snap;
    const fingerprint = (s: Snapshot) => JSON.stringify([s.url, s.headings, s.actions.map((a) => [a.role, a.label, a.href]), s.formFields, s.dialog, s.bodyText.length]);
    let prev = fingerprint(snap);
    const deadline = Date.now() + this.opts.config.stabilizeMs;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(STABILIZE_INTERVAL_MS);
      snap = await this.snapshot();
      const cur = fingerprint(snap);
      if (cur === prev) break;
      prev = cur;
    }
    return snap;
  }

  /** 起点を開いて落ち着くまで待つ。開けなければ NavigationError */
  async gotoRoot(): Promise<boolean> {
    try {
      const res = await timed('goto', () => this.page.goto(this.opts.config.baseUrl, { waitUntil: 'domcontentloaded' }));
      if (res && res.status() >= 500) this.failedRequests.push(`${res.status()} GET ${res.url()}`);
    } catch (e) {
      throw new NavigationError(`起点を開けません: ${firstLine(e)}`);
    }
    return this.settle();
  }

  /**
   * 操作を 1 つ実行する。列挙と同じ規則で対象を見つけ直して印を付け、送信系の操作ならそのフォームだけを自動入力してからクリックし、
   * 落ち着くまで待つ。戻り値は落ち着いたかどうかと、別のリンクで代用したかどうか。
   */
  async perform(action: ActionDesc): Promise<{ settled: boolean; substituted: boolean }> {
    let found: { target?: RawAction; substituted?: boolean } = {};
    let marked = false;
    for (let attempt = 0; attempt < 3 && !marked; attempt++) {
      if (attempt > 0) await this.page.waitForTimeout(150);
      const snap = await this.snapshot();
      found = findTarget(snap.actions, action, snap.url, this.opts.ctx);
      if (!found.target) throw new ActionError(`操作対象が見つかりません: ${describeAction(action)}`);
      const m = await this.snapshot({ index: found.target.index, expect: { role: found.target.role, label: found.target.label } });
      marked = !!m.marked;
    }
    if (!marked || !found.target) throw new ActionError(`操作対象を特定できません（画面が描き変わり続けています）: ${describeAction(action)}`);
    const t = found.target;
    const submitter = t.kind === 'submit' || (t.role === 'button' && !t.href && !t.toggle);
    if (submitter) await this.evaluate(fillScopeInBrowser, this.opts.config.fill);
    try {
      await timed('click', () => this.page.locator('[data-flowmap-target="1"]').first().click({ timeout: this.opts.config.actionTimeoutMs }));
    } catch (e) {
      throw new ActionError(`クリック失敗: ${describeAction(action)}（${clickFailureReason(e)}）`);
    }
    const settled = await this.settle();
    if (this.crashed) throw new ActionError(`操作のあとでページがクラッシュしました: ${describeAction(action)}`);
    return { settled, substituted: !!found.substituted };
  }

  /** ブラウザの「戻る」を 1 回使う。URL が変わったら落ち着くまで待って true */
  async goBack(): Promise<{ moved: boolean; settled: boolean }> {
    const before = this.page.url();
    try { await timed('goBack', () => this.page.goBack({ waitUntil: 'domcontentloaded' })); } catch { /* pushState 型の SPA では応答が無いことがある */ }
    if (this.page.url() === before) return { moved: false, settled: false };
    return { moved: true, settled: await this.settle() };
  }

  /** localStorage・sessionStorage・Cookie（HttpOnly を含む）の指紋。操作が状態を変えたかの判定に使う */
  storageDigest(): Promise<string> {
    return timed('storageDigest', () => this.storageDigestInner());
  }

  private async storageDigestInner(): Promise<string> {
    let inPage = '';
    try { inPage = await this.evaluate(storageDigestInBrowser, undefined); } catch { inPage = '?'; }
    const cookies = await this.context!.cookies().catch(() => []);
    const text = cookies.map((ck) => `${ck.domain}|${ck.path}|${ck.name}=${ck.value}`).sort().join('\n');
    return `${inPage}|${createHash('sha1').update(text).digest('hex').slice(0, 12)}`;
  }

  async screenshot(path: string): Promise<void> {
    await timed('screenshot', () => this.page.screenshot({ path, animations: 'disabled', fullPage: this.opts.config.fullPageScreenshots, timeout: 15000 }));
  }

  url(): string { return this.pageRef?.url() ?? ''; }
}
