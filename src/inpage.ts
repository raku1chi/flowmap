// ブラウザの中で実行する関数。page.evaluate / addInitScript に渡すので、外側のスコープを参照しない自己完結の関数として書く。
// tsx(esbuild) の keepNames が挿入する __name ヘルパーはブラウザに無いので、最初の init script（NAME_SHIM）で恒等関数を置く。
// 型は Node 側でも使うのでここで定義する。

export interface RawAction {
  role: string;
  label: string;
  text: string;
  href?: string;
  kind: 'click' | 'submit';
  nth: number;
  /** 列挙時の順番。印を付けるときに使う */
  index: number;
  /** 開閉・ポップアップの操作（summary、aria-expanded、aria-haspopup、combobox）。ラベルに今の値が出ることがある */
  toggle?: boolean;
  /** nav・header・footer などの共通の枠の中にあるか */
  inNav?: boolean;
  /** volatileSelectors の中にあるか（画面の同定には使わないが、操作は探索する） */
  volatile?: boolean;
  /** data-testid / data-test / data-qa / data-cy / id（数字を含まないもの）/ name のどれか。要素を見つけ直す手がかり */
  testId?: string;
  /** 検索フォームの送信（role=search か type=search の入力欄を持つフォーム）。データを変えない送信として扱う */
  search?: boolean;
}

export interface Snapshot {
  url: string;
  title: string;
  headings: string[];
  headingTags: string[]; // headings と同じ順の h1/h2/h3
  actions: RawAction[];
  formFields: string[];
  /** 本文テキスト（volatileSelectors の中は除く）。変化の検出に使う */
  bodyText: string;
  /** 開いているダイアログの名前。ダイアログが無ければ undefined */
  dialog?: string;
  /** 選ばれているタブのラベル */
  selectedTabs: string[];
  /** 開いている開閉（open な details の summary、aria-expanded=true の要素）のラベル。同じ画面の開いた状態を見分ける表示用 */
  expanded: string[];
  /** 見えているパスワード入力欄があるか（ログイン画面の手がかり） */
  hasPassword: boolean;
  /** 印を付けた要素が期待どおりだったか（markIndex を渡したときだけ） */
  marked?: boolean;
}

export interface EnumerateOptions {
  denyText: string[];
  denySelectors: string[];
  denyUrlPatterns: string[];
  allowSubmit: boolean;
  volatileSelectors?: string[];
  /** 指定した index の要素に data-flowmap-target を付ける。markExpect と role・ラベルが一致したときだけ */
  markIndex?: number;
  markExpect?: { role: string; label: string };
}

/** 最初の init script。これ自体は名前付きの関数を含まないので __name を使わない */
export const NAME_SHIM = (): void => { (globalThis as unknown as { __name?: unknown }).__name ??= (f: unknown) => f; };

/**
 * DOM の変化を記録するトラッカーと、非表示にする要素のスタイルを入れる init script。
 * 画面が落ち着いたかの判定（最後の変化からの経過時間）に使う。style 属性だけの変化（アニメーション）と、
 * volatileSelectors の中の変化（時計など、ずっと動き続ける部分）は数えない。
 */
export function installTracker(opts: { hideSelectors: string[]; volatileSelectors: string[] }): void {
  const g = globalThis as unknown as { __flowmap?: { lastMutation: number } };
  if (g.__flowmap) return;
  const t = { lastMutation: performance.now() };
  g.__flowmap = t;
  const volatile = opts.volatileSelectors.join(', ');
  const inVolatile = (node: Node | null): boolean => {
    if (!volatile || !node) return false;
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    try { return !!el && !!el.closest(volatile); } catch { return false; }
  };
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && r.attributeName === 'style') continue;
      if (inVolatile(r.target)) continue;
      t.lastMutation = performance.now();
      return;
    }
  });
  mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  if (opts.hideSelectors.length) {
    const css = opts.hideSelectors.map((s) => `${s} { display: none !important; }`).join('\n');
    const add = () => {
      if (!document.documentElement) return false;
      const st = document.createElement('style');
      st.setAttribute('data-flowmap', 'hide');
      st.textContent = css;
      document.documentElement.appendChild(st);
      return true;
    };
    if (!add()) document.addEventListener('readystatechange', () => { add(); }, { once: true });
  }
}

/** 最後の DOM の変化からの経過ミリ秒。トラッカーが無ければ大きな値 */
export function quietForInBrowser(): number {
  const t = (globalThis as unknown as { __flowmap?: { lastMutation: number } }).__flowmap;
  return t ? performance.now() - t.lastMutation : 1e9;
}

/** localStorage と sessionStorage の中身の指紋。操作がストレージを変えたかの判定に使う */
export function storageDigestInBrowser(): string {
  const dump = (s: Storage | undefined) => {
    if (!s) return '';
    const out: string[] = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i)!; out.push(k + '=' + s.getItem(k)); }
    return out.sort().join('\n');
  };
  let text = '';
  try { text = dump(localStorage) + '\u0000' + dump(sessionStorage) + '\u0000' + document.cookie; } catch { /* 不透明なオリジン */ }
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16) + ':' + text.length;
}

/**
 * 画面の状態を読み取る。操作対象は、可視の a[href]・button・role=button|tab|menuitem|link・input[type=submit|button]・summary・onclick 付き要素。
 * 開いている shadow root の中も辿る。
 */
export function snapshotInBrowser(opts: EnumerateOptions): Snapshot {
  const SELECTOR = 'a[href], button, [role="button"], [role="tab"], [role="menuitem"], [role="link"], input[type="submit"], input[type="button"], input[type="image"], summary, [onclick]';
  const denyText = opts.denyText.map((t) => t.toLowerCase());
  const denyUrl = opts.denyUrlPatterns.map((p) => new RegExp(p, 'i'));
  const volatileSel = (opts.volatileSelectors ?? []).join(', ');

  // 開いている shadow root も含めて、文書順に要素を集める
  const allElements: Element[] = [];
  const walk = (root: ParentNode) => {
    const stack: Element[] = Array.from(root.children).reverse();
    while (stack.length) {
      const el = stack.pop()!;
      allElements.push(el);
      const kids: Element[] = [];
      if (el.shadowRoot) kids.push(...Array.from(el.shadowRoot.children));
      kids.push(...Array.from(el.children));
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  };
  walk(document);
  const safeMatches = (el: Element, sel: string) => { try { return el.matches(sel); } catch { return false; } };
  const closestDeep = (el: Element, sel: string): Element | null => {
    if (!sel) return null;
    let cur: Element | null = el;
    while (cur) {
      if (safeMatches(cur, sel)) return cur;
      if (cur.parentElement) cur = cur.parentElement;
      else { const root = cur.getRootNode(); cur = root instanceof ShadowRoot ? root.host : null; }
    }
    return null;
  };

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none' || st.opacity === '0') return false;
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.closest('[inert]')) return false;
    // 中心点が他の要素（モーダルのオーバーレイ等）で覆われていれば押せないので除外する。
    // この検査はビューポート内の要素にだけ行う。外の要素は elementFromPoint で調べられず、
    // 画面端の座標で代用すると開閉やスクロールのたびに結果が変わって骨格が不安定になる
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return true;
    const root = el.getRootNode() as Document | ShadowRoot;
    const top = (root.elementFromPoint ? root.elementFromPoint(cx, cy) : null) ?? document.elementFromPoint(cx, cy);
    if (!top) return false;
    return el === top || el.contains(top) || top.contains(el);
  };

  const textOf = (el: Element): string => ((el as HTMLElement).innerText ?? el.textContent ?? '').trim().replace(/\s+/g, ' ');
  const labelOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim().slice(0, 60);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => { const x = (el.getRootNode() as Document | ShadowRoot).getElementById?.(id) ?? document.getElementById(id); return x ? textOf(x) : ''; }).join(' ').trim();
      if (t) return t.slice(0, 60);
    }
    const text = textOf(el);
    if (text) return text.slice(0, 60);
    const value = (el as HTMLInputElement).value;
    if (value && typeof value === 'string' && value.trim()) return value.trim().slice(0, 60);
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim().slice(0, 60);
    const img = el.querySelector('img[alt]');
    if (img) return (img.getAttribute('alt') ?? '').trim().slice(0, 60);
    const svgTitle = el.querySelector('svg title');
    if (svgTitle) return (svgTitle.textContent ?? '').trim().slice(0, 60);
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
    if (tag === 'input' && (type === 'submit' || type === 'image')) return 'submit';
    if (tag === 'button' && (type === 'submit' || (!type && (el as HTMLButtonElement).form))) return 'submit';
    return 'click';
  };

  const isToggle = (el: Element): boolean => {
    if (el.tagName.toLowerCase() === 'summary') return true;
    if (el.hasAttribute('aria-expanded')) return true;
    const pop = el.getAttribute('aria-haspopup');
    if (pop && pop !== 'false') return true;
    return el.getAttribute('role') === 'combobox';
  };

  const testIdOf = (el: Element): string | undefined => {
    for (const a of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']) {
      const v = el.getAttribute(a);
      if (v) return `${a}=${v}`;
    }
    const id = el.getAttribute('id');
    if (id && !/\d/.test(id) && !/^[:_]/.test(id)) return `id=${id}`; // 自動採番らしい id（数字入り・React の :r1:）は使わない
    const name = el.getAttribute('name');
    if (name) return `name=${name}`;
    return undefined;
  };

  const candidates = allElements.filter((el) => safeMatches(el, SELECTOR));
  const counter = new Map<string, number>();
  const actions: RawAction[] = [];
  candidates.forEach((el, index) => {
    if (!isVisible(el)) return;
    const label = labelOf(el);
    const role = roleOf(el);
    const href = el.getAttribute('href') ?? undefined;
    const kind = kindOf(el);
    if (!label && !href) return;
    if (denyText.some((t) => label.toLowerCase().includes(t))) return;
    if (opts.denySelectors.some((s) => !!closestDeep(el, s))) return;
    if (href && denyUrl.some((re) => re.test(href))) return;
    if (href && /^javascript:/i.test(href) && !el.hasAttribute('onclick')) return;
    if (!opts.allowSubmit && kind === 'submit') return;
    const key = `${role}|${label}`;
    const nth = (counter.get(key) ?? 0) + 1;
    counter.set(key, nth);
    const a: RawAction = { role, label, text: label, href, kind, nth, index };
    if (isToggle(el)) a.toggle = true;
    if (closestDeep(el, 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]')) a.inNav = true;
    if (volatileSel && closestDeep(el, volatileSel)) a.volatile = true;
    const tid = testIdOf(el);
    if (tid) a.testId = tid;
    if (kind === 'submit') {
      const form = (el as HTMLButtonElement).form;
      if (form && (safeMatches(form, '[role="search"], search *, [role="search"] *') || form.querySelector('input[type="search"]'))) a.search = true;
    }
    actions.push(a);
  });

  let marked: boolean | undefined;
  if (opts.markIndex !== undefined) {
    for (const el of allElements) if (el.hasAttribute('data-flowmap-target')) el.removeAttribute('data-flowmap-target');
    const target = candidates[opts.markIndex];
    marked = !!target && (!opts.markExpect || (roleOf(target) === opts.markExpect.role && labelOf(target) === opts.markExpect.label));
    if (target && marked) {
      target.setAttribute('data-flowmap-target', '1');
      // 別タブで開くリンクと送信は、同じタブで開かせる（別タブは閉じるので、行き先を撮れなくなる）
      const a = target.closest('a');
      if (a && a.target && a.target !== '_self') a.target = '_self';
      const form = (target as HTMLButtonElement).form;
      if (form && form.target && form.target !== '_self') form.target = '_self';
    }
  }

  const inVolatile = (el: Element) => !!volatileSel && !!closestDeep(el, volatileSel);
  const visibleBox = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const headingEls = allElements.filter((h) => /^H[123]$/.test(h.tagName) && visibleBox(h) && !inVolatile(h));
  const headings = headingEls.map((h) => textOf(h));
  const headingTags = headingEls.map((h) => h.tagName.toLowerCase());
  const formFields = allElements
    .filter((f) => /^(INPUT|SELECT|TEXTAREA)$/.test(f.tagName) && (f as HTMLInputElement).type !== 'hidden' && !inVolatile(f))
    .map((f) => `${f.tagName.toLowerCase()}:${(f as HTMLInputElement).type ?? ''}:${f.getAttribute('name') ?? ''}`);

  // 開いているダイアログ（最後に見つかったもの＝いちばん手前）
  let dialog: string | undefined;
  const dialogs = allElements.filter((d) => (safeMatches(d, 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) && visibleBox(d));
  if (dialogs.length) {
    const d = dialogs[dialogs.length - 1];
    const heading = d.querySelector('h1, h2, h3, [role="heading"]');
    dialog = (d.getAttribute('aria-label') ?? '').trim() || (heading ? textOf(heading) : '') || '(dialog)';
    dialog = dialog.slice(0, 60);
  }
  const selectedTabs = allElements
    .filter((t) => t.getAttribute('role') === 'tab' && t.getAttribute('aria-selected') === 'true' && visibleBox(t))
    .map((t) => labelOf(t));
  const expanded = allElements
    .filter((t) => ((t.tagName === 'SUMMARY' && (t.parentElement as HTMLDetailsElement | null)?.open) || t.getAttribute('aria-expanded') === 'true') && visibleBox(t) && !inVolatile(t))
    .map((t) => labelOf(t))
    .filter(Boolean);

  let bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
  if (volatileSel) {
    for (const el of allElements) {
      if (!safeMatches(el, volatileSel)) continue;
      const t = textOf(el);
      if (t) bodyText = bodyText.replace(t, '');
    }
  }
  const hasPassword = allElements.some((f) => f.tagName === 'INPUT' && (f as HTMLInputElement).type === 'password' && visibleBox(f));

  return { url: location.href, title: document.title, headings, headingTags, actions, formFields, bodyText, dialog, selectedTabs, expanded, hasPassword, marked };
}

/**
 * 印を付けた要素（data-flowmap-target）が属するフォームだけを自動入力する。
 * フォーム要素が無ければ、近い祖先（4 段まで）のうち入力欄を含むものを範囲にする。
 * 既に値があるものは触らない。select は未選択（値が空）のときだけ最初の有効な選択肢を選ぶ。
 * required のチェックボックスは入れ、required のラジオは未選択なら最初を選ぶ。
 * 戻り値は入力した項目の数。
 */
export function fillScopeInBrowser(fill: Record<string, string>): number {
  const target = document.querySelector('[data-flowmap-target="1"]') as HTMLElement | null;
  if (!target) return 0;
  const fieldSel = 'input, textarea, select';
  let scope: Element | null = (target as HTMLButtonElement).form ?? target.closest('form');
  if (!scope) {
    let cur: Element | null = target.parentElement;
    for (let depth = 0; cur && depth < 4 && cur !== document.body; depth++, cur = cur.parentElement) {
      if (cur.querySelector(fieldSel)) { scope = cur; break; }
    }
  }
  if (!scope) return 0;
  const fields = Array.from(scope.querySelectorAll(fieldSel)) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
  if ((target as HTMLButtonElement).form) {
    const form = (target as HTMLButtonElement).form!;
    for (const el of Array.from(form.elements)) if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !fields.includes(el as HTMLInputElement)) fields.push(el as HTMLInputElement);
  }
  const visible = (el: Element) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const setValue = (el: HTMLElement, value: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  let filled = 0;
  const radiosDone = new Set<string>();
  for (const el of fields) {
    if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) continue;
    if (el instanceof HTMLSelectElement) {
      if (el.value === '' && visible(el)) {
        const opt = Array.from(el.options).find((o) => o.value !== '' && !o.disabled);
        if (opt) { setValue(el, opt.value); filled++; }
      }
      continue;
    }
    const type = (el as HTMLInputElement).type;
    if (type === 'checkbox') {
      if ((el as HTMLInputElement).required && !(el as HTMLInputElement).checked) { (el as HTMLInputElement).click(); filled++; }
      continue;
    }
    if (type === 'radio') {
      const name = el.getAttribute('name') ?? '';
      if (!(el as HTMLInputElement).required || radiosDone.has(name)) continue;
      radiosDone.add(name);
      const group = fields.filter((f) => (f as HTMLInputElement).type === 'radio' && f.getAttribute('name') === name) as HTMLInputElement[];
      if (!group.some((r) => r.checked)) { group[0].click(); filled++; }
      continue;
    }
    if (['hidden', 'file', 'submit', 'button', 'reset', 'image', 'range', 'color'].includes(type)) continue;
    if (!visible(el)) continue;
    if (el.value && el.value.trim()) continue;
    const name = el.getAttribute('name') ?? '';
    const byName = name ? fill['name=' + name] : undefined;
    let value = byName ?? fill[el instanceof HTMLTextAreaElement ? 'textarea' : type] ?? fill.text;
    if (value === undefined) continue;
    if (type === 'number') {
      const min = Number(el.getAttribute('min'));
      const max = Number(el.getAttribute('max'));
      let n = Number(value);
      if (!Number.isFinite(n)) n = 1;
      if (el.getAttribute('min') !== null && Number.isFinite(min) && n < min) n = min;
      if (el.getAttribute('max') !== null && Number.isFinite(max) && n > max) n = max;
      value = String(n);
    }
    const maxLength = (el as HTMLInputElement).maxLength;
    if (maxLength > 0 && value.length > maxLength) value = value.slice(0, maxLength);
    setValue(el, value);
    filled++;
  }
  return filled;
}
