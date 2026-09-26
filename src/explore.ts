import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ActionDesc, Diff, Edge, FlowmapConfig, Graph, RemovedNode, StateNode } from './types.js';
import { actionKey, normalizeDigits, normalizeRoute, planActions, proposeDataSegments, structureOf, type NormalizeContext } from './normalize.js';
import { clip, JevJudge, maskedPath } from './jev.js';

// ---------- ブラウザ内で実行する関数 ----------
// page.evaluate に渡すため、外側のスコープを参照しない自己完結の関数として書く。

interface RawAction {
  role: string;
  label: string;
  text: string;
  href?: string;
  kind: 'click' | 'submit';
  nth: number;
  index: number; // 列挙時の DOM 順。印を付けるときに使う
}

export interface Snapshot {
  url: string;
  title: string;
  headings: string[];
  headingTags: string[]; // headings と同じ順の h1/h2/h3
  actions: RawAction[];
  formFields: string[];
  bodyText: string;
}

export interface EnumerateOptions {
  denyText: string[];
  denySelectors: string[];
  denyUrlPatterns: string[];
  allowSubmit: boolean;
  markIndex?: number; // 指定した index の要素に data-flowmap-target を付ける
}

export function snapshotInBrowser(opts: EnumerateOptions): Snapshot {
  const SELECTOR = 'a[href], button, [role="button"], [role="tab"], [role="menuitem"], [role="link"], input[type="submit"], input[type="button"], summary, [onclick]';
  const denyText = opts.denyText.map((t) => t.toLowerCase());
  const denyUrl = opts.denyUrlPatterns.map((p) => new RegExp(p, 'i'));

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none') return false;
    if ((el as HTMLButtonElement).disabled) return false;
    // 中心点が他の要素（モーダルのオーバーレイ等）で覆われていれば押せないので除外する。
    // この検査はビューポート内の要素にだけ行う。外の要素は elementFromPoint で調べられず、
    // 画面端の座標で代用すると開閉やスクロールのたびに結果が変わって骨格が不安定になる
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return true;
    const top = document.elementFromPoint(cx, cy);
    if (!top) return false;
    return el === top || el.contains(top) || top.contains(el);
  };

  const labelOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const text = (el as HTMLElement).innerText?.trim().replace(/\s+/g, ' ');
    if (text) return text.slice(0, 60);
    const value = (el as HTMLInputElement).value;
    if (value && value.trim()) return value.trim();
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    const img = el.querySelector('img[alt]');
    if (img) return (img.getAttribute('alt') ?? '').trim();
    return '';
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'input') return 'button';
    return tag;
  };

  const kindOf = (el: Element): 'click' | 'submit' => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'input' && type === 'submit') return 'submit';
    if (tag === 'button' && (type === 'submit' || (!type && el.closest('form')))) return 'submit';
    return 'click';
  };

  const all = Array.from(document.querySelectorAll(SELECTOR));
  const counter = new Map<string, number>();
  const actions: RawAction[] = [];
  all.forEach((el, index) => {
    if (!isVisible(el)) return;
    const label = labelOf(el);
    const role = roleOf(el);
    const href = el.getAttribute('href') ?? undefined;
    const kind = kindOf(el);
    if (!label && !href) return;
    if (denyText.some((t) => label.toLowerCase().includes(t))) return;
    if (opts.denySelectors.some((s) => { try { return el.matches(s) || !!el.closest(s); } catch { return false; } })) return;
    if (href && denyUrl.some((re) => re.test(href))) return;
    if (href && /^javascript:/i.test(href) && !el.hasAttribute('onclick')) return;
    if (!opts.allowSubmit && kind === 'submit') return;
    const key = `${role}|${label}`;
    const nth = (counter.get(key) ?? 0) + 1;
    counter.set(key, nth);
    actions.push({ role, label, text: label, href, kind, nth, index });
  });

  if (opts.markIndex !== undefined) {
    document.querySelectorAll('[data-flowmap-target]').forEach((el) => el.removeAttribute('data-flowmap-target'));
    const target = all[opts.markIndex];
    if (target) target.setAttribute('data-flowmap-target', '1');
  }

  const headingEls = Array.from(document.querySelectorAll('h1, h2, h3'))
    .filter((h) => { const r = h.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const headings = headingEls.map((h) => (h as HTMLElement).innerText.trim().replace(/\s+/g, ' '));
  const headingTags = headingEls.map((h) => h.tagName.toLowerCase());
  const formFields = Array.from(document.querySelectorAll('input, select, textarea'))
    .filter((f) => (f as HTMLInputElement).type !== 'hidden')
    .map((f) => `${f.tagName.toLowerCase()}:${(f as HTMLInputElement).type ?? ''}:${f.getAttribute('name') ?? ''}`);

  return {
    url: location.href,
    title: document.title,
    headings,
    headingTags,
    actions,
    formFields,
    bodyText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim(),
  };
}

export function fillFormsInBrowser(fill: Record<string, string>): void {
  const fields = Array.from(document.querySelectorAll('input, textarea, select')) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
  const setValue = (el: HTMLElement, value: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, value) : ((el as HTMLInputElement).value = value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  for (const el of fields) {
    if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) continue;
    if (el instanceof HTMLSelectElement) {
      if (el.selectedIndex <= 0 && el.options.length > 1) setValue(el, el.options[1].value);
      continue;
    }
    const type = (el as HTMLInputElement).type;
    if (['checkbox', 'radio', 'hidden', 'file', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
    if (el.value && el.value.trim()) continue;
    const value = fill[type] ?? fill.text;
    if (value !== undefined) setValue(el, value);
  }
}

// ---------- ユーティリティ ----------

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const STABILIZE_INTERVAL_MS = 250;
/** Jev の操作判定で、リンク（GET の遷移）を止める閾値。ボタンなどは設定の jev.actionThreshold */
const LINK_ACTION_THRESHOLD = 0.7;
/** ノードごとに残す、同じルートで合流した実例の数 */
const MAX_SAMPLES = 20;

function timestampDir(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/**
 * 画面のシグネチャ。同一オリジンなら sha1(正規化ルート ‖ 骨格)、別オリジンなら URL だけ。
 * ルートの正規化と骨格の作り方は normalize.ts を参照。
 */
export function signatureOf(snap: Snapshot, ctx: NormalizeContext): { signature: string; route?: string; dataValues: string[]; structure: string } {
  const r = normalizeRoute(snap.url, ctx);
  if (!r) return { signature: sha1(snap.url).slice(0, 12), dataValues: [], structure: '' };
  const headings = snap.headings.map((text, i) => ({ tag: snap.headingTags[i] ?? 'h2', text }));
  const structure = structureOf({ ...snap, headings }, snap.url, ctx, r);
  return { signature: sha1(`${r.route}||${structure}`).slice(0, 12), route: r.route, dataValues: r.dataValues, structure };
}

/** 別 URL を表示用に読める形にする（パーセントエンコードを戻す） */
const readableUrl = (u: string): string => { try { return decodeURI(u); } catch { return u; } };

const describe = (a: { role: string; label: string; href?: string; nth: number }): string => {
  const roleJa: Record<string, string> = { link: 'リンク', button: 'ボタン', tab: 'タブ', menuitem: 'メニュー', summary: '開閉' };
  const base = `「${a.label || a.href}」${roleJa[a.role] ?? a.role}`;
  return a.nth > 1 ? `${base}(${a.nth})` : base;
};

// ---------- 探索 ----------

export interface ExploreOptions {
  config: FlowmapConfig;
  log?: (msg: string) => void;
}

export interface ExploreResult {
  runDir: string;
  graph: Graph;
}

export async function explore({ config, log = console.log }: ExploreOptions): Promise<ExploreResult> {
  const startedAt = new Date();
  const runsDir = resolve(config.outDir, 'runs');
  const runName = timestampDir(startedAt);
  const runDir = join(runsDir, runName);
  mkdirSync(join(runDir, 'shots'), { recursive: true });

  const origin = new URL(config.baseUrl).origin;
  const ctx: NormalizeContext = {
    origin,
    pathRules: config.pathRules,
    learnedPrefixes: new Set<string>(),
    queryParams: config.queryParams,
    structuralParams: config.structuralParams,
  };
  const learnedPathRules: string[] = [];
  // FLOWMAP_DEBUG=1 のとき、撮影ごとの骨格を runDir/debug-structures.json に残す（「なぜ別ノードになったか」を調べる用）
  const debugStructures: { url: string; signature: string; route?: string; structure: string }[] = [];
  const enumerateOpts: EnumerateOptions = {
    denyText: config.denyText,
    denySelectors: config.denySelectors,
    denyUrlPatterns: config.denyUrlPatterns,
    allowSubmit: config.allowSubmit,
  };

  // Jev は任意。有効なら、キーの確認とキャッシュの読み込みをブラウザを開く前に済ませる（キーが通らなければここで止める）
  let judge: JevJudge | undefined;
  if (config.jev.enabled) {
    judge = await JevJudge.open({ model: config.jev.model, cachePath: join(resolve(config.outDir), 'jev-cache.json') });
    log(`Jev を使います（${config.jev.model}）。画面のタイトル・見出し・操作のラベル・URL のパスを typesafe.ai に送ります`);
  }
  const rejectedPrefixes = new Set<string>(); // Jev が認めなかったデータ区間の候補（同じ候補を何度も聞かない）
  const jevCounts = { skippedActions: 0, mergedStates: 0 };
  const snapsById = new Map<string, Snapshot>(); // 合流の判定に使う、各ノードの代表のスナップショット
  const aliasScore = new Map<string, number>(); // Jev が合流させたシグネチャ → そのときの値
  const round2 = (x: number) => Math.round(x * 100) / 100;

  const browser: Browser = await chromium.launch();
  const context: BrowserContext = await browser.newContext({
    viewport: config.viewport,
    acceptDownloads: false,
    storageState: config.storageState ?? undefined,
    locale: 'ja-JP',
  });
  // tsx(esbuild) の keepNames が挿入する __name ヘルパーは page.evaluate 先には存在しないので、ブラウザ側に恒等関数として用意する
  await context.addInitScript(() => { (globalThis as unknown as { __name?: unknown }).__name ??= (f: unknown) => f; });
  const page: Page = await context.newPage();

  // エラーの収集。操作のたびに読み出して空にする
  let consoleErrors: string[] = [];
  let failedRequests: string[] = [];
  const drain = () => {
    const r = { consoleErrors, failedRequests };
    consoleErrors = [];
    failedRequests = [];
    return r;
  };
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => consoleErrors.push(String(e.message ?? e).slice(0, 300)));
  page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} (${r.failure()?.errorText ?? 'failed'})`));
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  context.on('page', (p) => { if (p !== page) p.close().catch(() => {}); });

  const settle = async () => {
    try { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch { /* ignore */ }
    try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch { /* ignore */ }
    await page.waitForTimeout(config.settleMs);
  };

  const snapshot = (markIndex?: number) => page.evaluate(snapshotInBrowser, { ...enumerateOpts, markIndex });

  /**
   * 画面が落ち着くまで待ってからスナップショットを取る。
   * networkidle の後に一覧を描画するアプリでは、待ち時間だけでは骨格が読み込み途中で撮れて同じ画面が分裂する。
   * 骨格の指紋が 2 回続けて同じになるまで、stabilizeMs を上限に短い間隔で撮り直す。
   */
  const stableSnapshot = async (): Promise<Snapshot> => {
    const fingerprint = (s: Snapshot) => JSON.stringify([s.url, s.headings, s.actions.map((a) => [a.role, a.label, a.href]), s.formFields, s.bodyText.length]);
    let snap = await snapshot();
    let prev = fingerprint(snap);
    const deadline = Date.now() + config.stabilizeMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(STABILIZE_INTERVAL_MS);
      snap = await snapshot();
      const cur = fingerprint(snap);
      if (cur === prev) break;
      prev = cur;
    }
    return snap;
  };

  const substituted = new Set<string>(); // 代用したリンクの形（ログを 1 回にする）
  /** 列挙と同じ規則で対象を見つけ直し、印を付けてクリックする */
  const perform = async (action: ActionDesc): Promise<void> => {
    await page.evaluate(fillFormsInBrowser, config.fill);
    const snap = await snapshot();
    let target = snap.actions.find((a) => a.role === action.role && a.label === action.label && a.nth === action.nth);
    if (!target) {
      // ラベル中の数字（件数・ページ番号など）はデータで、別の操作の影響で変わることがある。数字を潰した一致で探し直す
      const want = normalizeDigits(action.label);
      const candidates = snap.actions.filter((a) => a.role === action.role && normalizeDigits(a.label) === want);
      target = candidates[action.nth - 1] ?? candidates[0];
    }
    if (!target && action.href) {
      // データ区間のリンク（企業名・商品名など）は、データが入れ替わると一覧から消える。
      // 行き先が同じ形の別のリンクで代用する（合流させた画面なので、どの実例でも同じ種類の画面に着く）
      const want = actionKey(action, snap.url, ctx, []);
      if (want.includes('*')) {
        target = snap.actions.find((a) => a.href && actionKey(a, snap.url, ctx, []) === want);
        if (target && !substituted.has(want)) {
          substituted.add(want);
          log(`   ≒ ${describe(action)} が見つからないため、同じ形のリンク「${clip(target.label)}」で代用します`);
        }
      }
    }
    if (!target) throw new Error(`操作対象が見つかりません: ${describe(action)}`);
    await snapshot(target.index);
    try {
      await page.click('[data-flowmap-target="1"]', { timeout: 4000, noWaitAfter: true });
    } catch (e) {
      throw new Error(`クリック失敗: ${describe(action)} (${(e as Error).message.split('\n')[0]})`);
    }
    await settle();
  };

  const nodes: StateNode[] = [];
  const edges: Edge[] = [];
  // 全画面にある開閉 UI（ヘッダのドロップダウン等）を画面ごとに開いて回らないための記録。
  // リンクでない操作を role|ラベル で束ね、どの画面から試したか・結果が毎回「同じルート内の状態変化」だったかを持つ
  const localActions = new Map<string, { from: Set<string>; onlyLocal: boolean }>();
  const localKey = (a: ActionDesc): string | undefined => (a.href ? undefined : `${a.role}|${normalizeDigits(a.label)}`);
  let replays = 0; // 起点から経路を再現した回数
  let cheapReturns = 0; // 「戻る」で元の画面に戻れた回数

  const bySignature = new Map<string, StateNode>();
  const paths = new Map<string, ActionDesc[]>(); // id → 起点からの操作列
  const actionsOf = new Map<string, ActionDesc[]>(); // id → 列挙した操作
  const queue: string[] = [];
  let stoppedBecause: string | undefined;

  const capture = async (depth: number): Promise<{ node: StateNode; isNew: boolean }> => {
    const snap = await stableSnapshot();
    const sameOrigin = (() => { try { return new URL(snap.url).origin === origin; } catch { return false; } })();
    // この画面の href から「同じ形の兄弟リンク」を学習してから、シグネチャを計算する。
    // Jev が有効なら、候補を認めたときだけ学習する（設定の各セクションのような別々の画面を合流させないため）
    if (sameOrigin && config.autoPathRules) {
      const items = snap.actions.flatMap((a) => (a.href ? [{ href: a.href, label: a.label }] : []));
      for (const p of proposeDataSegments(items, snap.url, ctx, config.autoPathRulesMinSiblings, rejectedPrefixes)) {
        if (judge && config.jev.dataSegments) {
          const score = await judge.dataGroupScore(
            { title: snap.title, heading: snap.headings[0] ?? '', url: maskedPath(snap.url) },
            p.examples.map((e) => ({ label: clip(e.label ?? ''), href: maskedPath(e.href) })),
          );
          if (score !== undefined && score < config.jev.mergeThreshold) {
            rejectedPrefixes.add(p.prefix);
            log(`   ≉ データ区間の候補を見送り: ${p.prefix}/* （Jev ${score.toFixed(2)}。リンク先はそれぞれ別の画面と判定）`);
            continue;
          }
        }
        ctx.learnedPrefixes.add(p.prefix);
        learnedPathRules.push(`${p.prefix}/*`);
        log(`   ≈ データ区間を学習: ${p.prefix}/* （同じ形のリンクが ${config.autoPathRulesMinSiblings} 本以上）`);
      }
    }
    const { signature, route, dataValues, structure } = signatureOf(snap, ctx);
    if (process.env.FLOWMAP_DEBUG) debugStructures.push({ url: snap.url, signature, route, structure });
    const errs = drain();
    const joinKnown = (known: StateNode): { node: StateNode; isNew: false } => {
      // 既知の画面でもエラーは追記する
      for (const e of errs.consoleErrors) if (!known.consoleErrors.includes(e)) known.consoleErrors.push(e);
      for (const f of errs.failedRequests) if (!known.failedRequests.includes(f)) known.failedRequests.push(f);
      // 別 URL から合流した場合は記録する（ビューアで「何が畳まれたか」を見せる）。Jev による合流は値と一緒に別に持つ
      if (snap.url !== known.url) {
        const u = readableUrl(snap.url);
        // 同じルートの実例は、ビューアが画面名からデータの部分を見分けるために、タイトルと先頭の見出しも残す
        if (route && route === known.route) {
          const samples = known.samples ?? (known.samples = []);
          if (!samples.some((x) => x.url === u) && samples.length < MAX_SAMPLES) samples.push({ url: u, title: snap.title, heading: snap.headings[0] });
        }
        if (signature !== known.signature) {
          const merged = known.jevMerged ?? (known.jevMerged = []);
          if (!merged.some((m) => m.url === u) && merged.length < 50) merged.push({ url: u, score: aliasScore.get(signature) ?? 0 });
        } else {
          const merged = known.mergedUrls ?? (known.mergedUrls = []);
          if (!merged.includes(u) && merged.length < 50) merged.push(u);
        }
      }
      return { node: known, isNew: false };
    };
    const known = bySignature.get(signature);
    if (known) return joinKnown(known);
    // Jev: 同じ区画の既存画面と比べ、同じ画面なら合流させる（シグネチャは別名として残す）
    if (judge && config.jev.pages && route) {
      const found = await findSameScreen(snap, route);
      if (found) {
        bySignature.set(signature, found.node);
        aliasScore.set(signature, found.score);
        (found.node.aliasSignatures ??= []).push(signature);
        jevCounts.mergedStates++;
        log(`   ≡ Jev が同じ画面と判定して合流: ${readableUrl(snap.url)} → [${found.node.id}] （${found.score.toFixed(2)}）`);
        return joinKnown(found.node);
      }
    }
    const id = `s${String(nodes.length + 1).padStart(3, '0')}`;
    const screenshot = `shots/${id}.png`;
    await page.screenshot({ path: join(runDir, screenshot) });
    const enumerated: ActionDesc[] = sameOrigin
      ? snap.actions.map(({ role, label, text, href, kind, nth }) => ({ role, label, text, href, kind, nth }))
      : [];
    // 同じ形の操作は maxActionsPerPattern 件までに畳み、形ごとに順繰りに並べる
    let actions = planActions(enumerated, (a) => actionKey(a, snap.url, ctx, dataValues), config.maxActionsPerPattern);
    // Jev: サーバーのデータを変えると判定した操作は押さない（denyText による除外に加える）。辿らない画面では聞かない。
    // タブと開閉（summary）は要素の性質上、表示を切り替えるだけなので聞かない。「危険な操作」という名前のタブを
    // ラベルの意味につられて危険と判定したことがあるため（コードで決められることはコードで決める）
    // リンクは GET の遷移で、HTTP の約束ではデータを変えない（GET でデータを変えるログアウトや削除は denyText・denyUrlPatterns で止まる）。
    // 「お問い合わせ」のように行為に読めるラベルのリンクを危険と判定したことがあるため、リンクは LINK_ACTION_THRESHOLD 以上のときだけ止める
    const jevSkipped: { role: string; label: string; score: number }[] = [];
    if (judge && config.jev.actions && sameOrigin && depth < config.maxDepth && actions.length) {
      const uiOnly = (a: ActionDesc) => a.role === 'tab' || a.role === 'summary';
      const scores = await Promise.all(actions.map((a) => (uiOnly(a) ? Promise.resolve(undefined) : judge!.actionScore(snap.title, a))));
      actions = actions.filter((a, i) => {
        const score = scores[i];
        const threshold = a.role === 'link' ? Math.max(config.jev.actionThreshold, LINK_ACTION_THRESHOLD) : config.jev.actionThreshold;
        if (score === undefined || score < threshold) return true;
        jevSkipped.push({ role: a.role, label: a.label, score: round2(score) });
        return false;
      });
      for (const k of jevSkipped) log(`   ⊘ Jev が危険と判定して押しません: ${describe({ ...k, nth: 1 })} （${k.score.toFixed(2)}）`);
      jevCounts.skippedActions += jevSkipped.length;
    }
    const node: StateNode = {
      id,
      signature,
      url: snap.url,
      route,
      title: snap.title,
      depth,
      screenshot,
      textHash: sha1(snap.bodyText).slice(0, 12),
      headings: snap.headings.slice(0, 8),
      consoleErrors: errs.consoleErrors,
      failedRequests: errs.failedRequests,
      actionsTotal: enumerated.length,
      actionsPlanned: actions.length,
      actionsTried: 0,
    };
    if (jevSkipped.length) node.jevSkipped = jevSkipped;
    if (!sameOrigin) node.truncated = '外部サイト';
    else if (depth >= config.maxDepth) node.truncated = '深さ上限';
    nodes.push(node);
    bySignature.set(signature, node);
    actionsOf.set(id, actions);
    if (judge && route) snapsById.set(id, snap);
    return { node, isNew: true };
  };

  /**
   * Jev で、同じ区画（先頭のパス区間が同じ）の既存ノードから同じ画面を探す。
   * 同じルートのノードを先に、最大 8 件と比べ、mergeThreshold 以上で最も高いものを返す。
   * 比べる相手は各ノードの代表（最初に撮った状態）なので、A≈B・B≈C から A と C が繋がることはない。
   */
  const findSameScreen = async (snap: Snapshot, route: string): Promise<{ node: StateNode; score: number } | undefined> => {
    const sectionOf = (r: string) => r.split('?')[0].split('/')[1] ?? '';
    const section = sectionOf(route);
    const candidates = nodes
      .filter((n) => n.route && sectionOf(n.route) === section && snapsById.has(n.id))
      .sort((a, b) => Number(b.route === route) - Number(a.route === route))
      .slice(0, 8);
    const scores = await Promise.all(candidates.map((n) => judge!.sameScreenScore(snapsById.get(n.id)!, snap, ctx)));
    let best: { node: StateNode; score: number } | undefined;
    scores.forEach((score, i) => {
      if (score !== undefined && score >= config.jev.mergeThreshold && (!best || score > best.score)) best = { node: candidates[i], score: round2(score) };
    });
    return best;
  };

  /**
   * 操作のあと、起点から再現せずに元の画面へ戻れるか試す。
   * URL が変わっていればブラウザの「戻る」を 1 回だけ使い、戻った先のシグネチャが元のノードと一致したときだけ成功とする。
   * SPA では履歴の戻りが状態を正しく戻さないことがあるので、一致しなければ次の操作の前に起点から経路を再現する。
   */
  const returnToSource = async (node: StateNode): Promise<boolean> => {
    if (!config.useBackNavigation) return false;
    try {
      const before = page.url();
      if (before === node.url) return false; // 同じ URL 上の状態変化（モーダル等）は「戻る」では戻せない
      // pushState 型の SPA では goBack が応答を返さず null になるので、戻り値ではなく URL の変化で判定する
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 });
      if (page.url() === before) return false;
      await settle();
      const snap = await stableSnapshot();
      const sig = signatureOf(snap, ctx).signature;
      const ok = sig === node.signature || (node.aliasSignatures?.includes(sig) ?? false);
      if (ok) cheapReturns++;
      return ok;
    } catch {
      return false;
    }
  };

  log(`探索開始: ${config.baseUrl} → ${runDir}`);
  drain();
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
  await settle();
  const { node: root } = await capture(0);
  paths.set(root.id, []);
  queue.push(root.id);

  try {
  outer: while (queue.length > 0) {
    const id = queue.shift()!;
    const node = nodes.find((n) => n.id === id)!;
    if (node.truncated) continue;
    const path = paths.get(id)!;
    const actionsAll = actionsOf.get(id)!;
    // 他の画面から maxLocalActionRepeats 回試して毎回その場の状態変化（開閉・モーダル）しか起きなかった操作は、共通の開閉 UI とみなして省く
    const actions = actionsAll.filter((a) => {
      const k = localKey(a);
      const h = k ? localActions.get(k) : undefined;
      return !(h && h.onlyLocal && !h.from.has(id) && h.from.size >= config.maxLocalActionRepeats);
    });
    if (actions.length < actionsAll.length) node.actionsSkippedCommon = actionsAll.length - actions.length;
    const limit = Math.min(actions.length, config.maxActionsPerState);
    const collapsed = node.actionsTotal > actions.length ? `${node.actionsTotal} 件を同種で ${actions.length} 件に畳み、` : '';
    if (actions.length > limit) node.truncated = `操作数上限（${collapsed}${limit} 件のみ試行）`;
    log(`[${id}] ${node.title || node.url}  深さ ${node.depth}  操作 ${limit}/${actions.length}${node.actionsTotal > actions.length ? `（列挙 ${node.actionsTotal}）` : ''}${node.actionsSkippedCommon ? `（共通の開閉操作 ${node.actionsSkippedCommon} 件は省略）` : ''}`);
    let atSource = false; // 今ブラウザがこのノードの状態にいるか

    for (let i = 0; i < limit; i++) {
      const action = actions[i];
      // 元の画面に戻る。直前の操作のあと、検証付きの「戻る」で元の画面に戻れていればそのまま使い、
      // 戻れていなければ起点から経路を再現する
      if (!atSource) {
        try {
          await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
          await settle();
          for (const step of path) await perform(step);
          replays++;
        } catch (e) {
          edges.push({ from: id, to: id, action, error: `経路再現失敗: ${(e as Error).message}` });
          node.actionsTried++;
          continue;
        }
      }
      atSource = false;
      drain();
      try {
        await perform(action);
      } catch (e) {
        edges.push({ from: id, to: id, action, error: (e as Error).message });
        node.actionsTried++;
        log(`   ✗ ${describe(action)}: ${(e as Error).message}`);
        atSource = await returnToSource(node);
        continue;
      }
      node.actionsTried++;
      const { node: to, isNew } = await capture(node.depth + 1);
      {
        const k = localKey(action);
        if (k) {
          const h = localActions.get(k) ?? { from: new Set<string>(), onlyLocal: true };
          h.from.add(id);
          if (to.route !== node.route) h.onlyLocal = false;
          localActions.set(k, h);
        }
      }
      // 同じノードでも URL が違えば（合流させた別データの画面に移った）、元の画面にはいない
      atSource = to.id === id && page.url() === node.url ? true : await returnToSource(node);
      if (to.id === id) continue; // 変化なしの自己遷移は記録しない
      edges.push({ from: id, to: to.id, action });
      log(`   ${isNew ? '＋' : '→'} ${describe(action)} → [${to.id}] ${to.title || to.url}`);
      if (isNew) {
        paths.set(to.id, [...path, action]);
        queue.push(to.id);
        if (nodes.length >= config.maxStates) {
          stoppedBecause = `画面数上限 ${config.maxStates} に到達`;
          log(`停止: ${stoppedBecause}`);
          break outer;
        }
      }
    }
  }

  } catch (e) {
    // 途中で落ちても graph.json は書き出し、理由を残す
    stoppedBecause = `探索中にエラー: ${(e as Error).message.split("\n")[0]}`;
    log(`停止: ${stoppedBecause}`);
  }

  await browser.close();
  judge?.save();

  const graph: Graph = {
    meta: {
      baseUrl: config.baseUrl,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      totalStates: nodes.length,
      totalEdges: edges.length,
      stoppedBecause,
      learnedPathRules: learnedPathRules.length ? learnedPathRules : undefined,
      jev: judge
        ? {
          model: judge.model,
          ...judge.stats,
          skippedActions: jevCounts.skippedActions,
          mergedStates: jevCounts.mergedStates,
          rejectedPathRules: [...rejectedPrefixes].map((p) => `${p}/*`),
        }
        : undefined,
    },
    root: root.id,
    nodes,
    edges,
  };
  const diff = computeDiff(runsDir, runName, graph);
  if (diff) graph.diff = diff;

  writeFileSync(join(runDir, 'graph.json'), JSON.stringify(graph, null, 2));
  if (process.env.FLOWMAP_DEBUG) writeFileSync(join(runDir, 'debug-structures.json'), JSON.stringify(debugStructures, null, 2));
  log(`経路再現 ${replays} 回 / 「戻る」で復帰 ${cheapReturns} 回`);
  if (judge) {
    const j = judge.stats;
    log(`Jev: 問い合わせ ${j.requests} 回（キャッシュ ${j.cacheHits} 回）/ 押さなかった操作 ${jevCounts.skippedActions} / 合流 ${jevCounts.mergedStates} / 見送ったデータ区間 ${rejectedPrefixes.size}${j.errors ? ` / 失敗 ${j.errors} 回（${j.lastError}）` : ''}`);
  }
  log(`完了: 画面 ${nodes.length} / 操作 ${edges.length}${diff ? ` / 前回比 追加 ${diff.added.length} 消失 ${diff.removed.length} 変化 ${diff.changed.length} 新エラー ${diff.newErrors.length}` : ''}`);
  return { runDir, graph };
}

// ---------- 差分 ----------

/**
 * 同じ outDir 内の直前の実行と比較する。比較キーはシグネチャで、id は突き合わせない。
 * Jev が合流させた画面の別名シグネチャ（aliasSignatures）も、そのノードのシグネチャとして突き合わせる。
 * 代表が別のデータの実例になっていることがあるので、「変化」は代表のシグネチャどうしが一致したときだけ見る。
 */
export function computeDiff(runsDir: string, currentRun: string, graph: Graph, baseline?: string): Diff | undefined {
  let previousRun = baseline;
  if (!previousRun) {
    if (!existsSync(runsDir)) return undefined;
    const runs = readdirSync(runsDir).filter((d) => d !== currentRun && existsSync(join(runsDir, d, 'graph.json'))).sort();
    previousRun = runs.at(-1);
  }
  if (!previousRun) return undefined;
  const prevPath = existsSync(join(runsDir, previousRun, 'graph.json')) ? join(runsDir, previousRun, 'graph.json') : join(previousRun, 'graph.json');
  if (!existsSync(prevPath)) return undefined;
  const prev = JSON.parse(readFileSync(prevPath, 'utf8')) as Graph;
  const sigsOf = (n: StateNode) => [n.signature, ...(n.aliasSignatures ?? [])];
  const prevBySig = new Map<string, StateNode>();
  for (const p of prev.nodes) for (const sig of sigsOf(p)) if (!prevBySig.has(sig)) prevBySig.set(sig, p);
  const curSigs = new Set(graph.nodes.flatMap(sigsOf));

  const added: string[] = [];
  const changed: string[] = [];
  const newErrors: string[] = [];
  const previous: NonNullable<Diff['previous']> = {};
  for (const n of graph.nodes) {
    const p = sigsOf(n).map((sig) => prevBySig.get(sig)).find((x) => x !== undefined);
    if (!p) {
      added.push(n.id);
      if (n.consoleErrors.length > 0) newErrors.push(n.id); // 新しい画面のエラーも前回になかったエラーとして扱う
      continue;
    }
    previous[n.id] = { screenshot: `../${previousRun}/${p.screenshot}`, textHash: p.textHash };
    if (p.signature === n.signature && p.textHash !== n.textHash) changed.push(n.id);
    if (n.consoleErrors.some((e) => !p.consoleErrors.includes(e))) newErrors.push(n.id);
  }
  const removed: RemovedNode[] = prev.nodes
    .filter((p) => !sigsOf(p).some((sig) => curSigs.has(sig)))
    .map((p) => ({ url: p.url, title: p.title, signature: p.signature, screenshot: `../${previousRun}/${p.screenshot}` }));

  // Jev の有無が前回と違うと、合流のしかたが変わって「消失」「追加」が出る。CI の合否に使う前に気づけるよう注意書きを付ける
  const warning = !!prev.meta.jev !== !!graph.meta.jev
    ? `比較対象と Jev の設定が違います（前回 ${prev.meta.jev ? 'あり' : 'なし'}・今回 ${graph.meta.jev ? 'あり' : 'なし'}）。合流のしかたが変わるので、消失と追加は設定の違いによるものを含みます`
    : undefined;
  return { previousRun, added, removed, changed, newErrors, previous, ...(warning ? { warning } : {}) };
}
