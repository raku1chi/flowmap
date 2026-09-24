import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ActionDesc, Diff, Edge, FlowmapConfig, Graph, RemovedNode, StateNode } from './types.js';

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

interface Snapshot {
  url: string;
  title: string;
  headings: string[];
  actions: RawAction[];
  formFields: string[];
  bodyText: string;
}

interface EnumerateOptions {
  denyText: string[];
  denySelectors: string[];
  denyUrlPatterns: string[];
  allowSubmit: boolean;
  markIndex?: number; // 指定した index の要素に data-flowmap-target を付ける
}

function snapshotInBrowser(opts: EnumerateOptions): Snapshot {
  const SELECTOR = 'a[href], button, [role="button"], [role="tab"], [role="menuitem"], [role="link"], input[type="submit"], input[type="button"], summary, [onclick]';
  const denyText = opts.denyText.map((t) => t.toLowerCase());
  const denyUrl = opts.denyUrlPatterns.map((p) => new RegExp(p, 'i'));

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none') return false;
    if ((el as HTMLButtonElement).disabled) return false;
    // 中心点が他の要素（モーダルのオーバーレイ等）で覆われていれば押せないので除外する
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
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

  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .filter((h) => { const r = h.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map((h) => (h as HTMLElement).innerText.trim().replace(/\s+/g, ' '));
  const formFields = Array.from(document.querySelectorAll('input, select, textarea'))
    .filter((f) => (f as HTMLInputElement).type !== 'hidden')
    .map((f) => `${f.tagName.toLowerCase()}:${(f as HTMLInputElement).type ?? ''}:${f.getAttribute('name') ?? ''}`);

  return {
    url: location.href,
    title: document.title,
    headings,
    actions,
    formFields,
    bodyText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim(),
  };
}

function fillFormsInBrowser(fill: Record<string, string>): void {
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
const normalizeDigits = (s: string) => s.replace(/\d+/g, '#');

function timestampDir(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

function signatureOf(snap: Snapshot, sameOrigin: boolean): string {
  if (!sameOrigin) return sha1(snap.url).slice(0, 12);
  const u = new URL(snap.url);
  const path = normalizeDigits(u.pathname + u.search);
  const structure = [
    ...snap.headings.map((h) => `h:${normalizeDigits(h)}`),
    ...snap.actions.map((a) => `a:${a.role}|${normalizeDigits(a.label)}|${a.href ? normalizeDigits(a.href) : ''}`),
    ...snap.formFields.map((f) => `f:${f}`),
  ].join('\n');
  return sha1(`${path}||${structure}`).slice(0, 12);
}

const describe = (a: RawAction | ActionDesc): string => {
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
  const enumerateOpts: EnumerateOptions = {
    denyText: config.denyText,
    denySelectors: config.denySelectors,
    denyUrlPatterns: config.denyUrlPatterns,
    allowSubmit: config.allowSubmit,
  };

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

  /** 列挙と同じ規則で対象を見つけ直し、印を付けてクリックする */
  const perform = async (action: ActionDesc): Promise<void> => {
    await page.evaluate(fillFormsInBrowser, config.fill);
    const snap = await snapshot();
    const target = snap.actions.find((a) => a.role === action.role && a.label === action.label && a.nth === action.nth);
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
  const bySignature = new Map<string, StateNode>();
  const paths = new Map<string, ActionDesc[]>(); // id → 起点からの操作列
  const actionsOf = new Map<string, ActionDesc[]>(); // id → 列挙した操作
  const queue: string[] = [];
  let stoppedBecause: string | undefined;

  const capture = async (depth: number): Promise<{ node: StateNode; isNew: boolean }> => {
    const snap = await snapshot();
    const sameOrigin = (() => { try { return new URL(snap.url).origin === origin; } catch { return false; } })();
    const signature = signatureOf(snap, sameOrigin);
    const errs = drain();
    const known = bySignature.get(signature);
    if (known) {
      // 既知の画面でもエラーは追記する
      for (const e of errs.consoleErrors) if (!known.consoleErrors.includes(e)) known.consoleErrors.push(e);
      for (const f of errs.failedRequests) if (!known.failedRequests.includes(f)) known.failedRequests.push(f);
      return { node: known, isNew: false };
    }
    const id = `s${String(nodes.length + 1).padStart(3, '0')}`;
    const screenshot = `shots/${id}.png`;
    await page.screenshot({ path: join(runDir, screenshot) });
    const actions: ActionDesc[] = sameOrigin
      ? snap.actions.map(({ role, label, text, href, kind, nth }) => ({ role, label, text, href, kind, nth }))
      : [];
    const node: StateNode = {
      id,
      signature,
      url: snap.url,
      title: snap.title,
      depth,
      screenshot,
      textHash: sha1(snap.bodyText).slice(0, 12),
      headings: snap.headings.slice(0, 8),
      consoleErrors: errs.consoleErrors,
      failedRequests: errs.failedRequests,
      actionsTotal: actions.length,
      actionsTried: 0,
    };
    if (!sameOrigin) node.truncated = '外部サイト';
    else if (depth >= config.maxDepth) node.truncated = '深さ上限';
    nodes.push(node);
    bySignature.set(signature, node);
    actionsOf.set(id, actions);
    return { node, isNew: true };
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
    const actions = actionsOf.get(id)!;
    const limit = Math.min(actions.length, config.maxActionsPerState);
    if (actions.length > limit) node.truncated = `操作数上限（${actions.length} 件中 ${limit} 件のみ試行）`;
    log(`[${id}] ${node.title || node.url}  深さ ${node.depth}  操作 ${limit}/${actions.length}`);

    for (let i = 0; i < limit; i++) {
      const action = actions[i];
      // 起点から経路を再現して元の画面に戻る
      try {
        await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
        await settle();
        for (const step of path) await perform(step);
      } catch (e) {
        edges.push({ from: id, to: id, action, error: `経路再現失敗: ${(e as Error).message}` });
        node.actionsTried++;
        continue;
      }
      drain();
      try {
        await perform(action);
      } catch (e) {
        edges.push({ from: id, to: id, action, error: (e as Error).message });
        node.actionsTried++;
        log(`   ✗ ${describe(action)}: ${(e as Error).message}`);
        continue;
      }
      node.actionsTried++;
      const { node: to, isNew } = await capture(node.depth + 1);
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

  const graph: Graph = {
    meta: {
      baseUrl: config.baseUrl,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      totalStates: nodes.length,
      totalEdges: edges.length,
      stoppedBecause,
    },
    root: root.id,
    nodes,
    edges,
  };
  const diff = computeDiff(runsDir, runName, graph);
  if (diff) graph.diff = diff;

  writeFileSync(join(runDir, 'graph.json'), JSON.stringify(graph, null, 2));
  log(`完了: 画面 ${nodes.length} / 操作 ${edges.length}${diff ? ` / 前回比 追加 ${diff.added.length} 消失 ${diff.removed.length} 変化 ${diff.changed.length} 新エラー ${diff.newErrors.length}` : ''}`);
  return { runDir, graph };
}

// ---------- 差分 ----------

/** 同じ outDir 内の直前の実行と比較する。比較キーはシグネチャで、id は突き合わせない */
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
  const prevBySig = new Map(prev.nodes.map((n) => [n.signature, n]));
  const curBySig = new Map(graph.nodes.map((n) => [n.signature, n]));

  const added: string[] = [];
  const changed: string[] = [];
  const newErrors: string[] = [];
  const previous: NonNullable<Diff['previous']> = {};
  for (const n of graph.nodes) {
    const p = prevBySig.get(n.signature);
    if (!p) {
      added.push(n.id);
      if (n.consoleErrors.length > 0) newErrors.push(n.id); // 新しい画面のエラーも前回になかったエラーとして扱う
      continue;
    }
    previous[n.id] = { screenshot: `../${previousRun}/${p.screenshot}`, textHash: p.textHash };
    if (p.textHash !== n.textHash) changed.push(n.id);
    if (n.consoleErrors.some((e) => !p.consoleErrors.includes(e))) newErrors.push(n.id);
  }
  const removed: RemovedNode[] = prev.nodes
    .filter((p) => !curBySig.has(p.signature))
    .map((p) => ({ url: p.url, title: p.title, signature: p.signature, screenshot: `../${previousRun}/${p.screenshot}` }));

  return { previousRun, added, removed, changed, newErrors, previous };
}
