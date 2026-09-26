// 画面を開いて撮り、探索エンジンと同じ手順で操作を再生する。capture.ts と review.ts から使う。
// Jev に渡す要約と差分は本体の src/jev.ts のものを使う。

import type { Page } from 'playwright';
import { fillScopeInBrowser, snapshotInBrowser, type EnumerateOptions, type Snapshot } from '../../src/inpage.js';
import type { NormalizeContext } from '../../src/normalize.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { findTarget } from '../../src/session.js';

export const OPTS: EnumerateOptions = {
  denyText: DEFAULT_CONFIG.denyText,
  denySelectors: DEFAULT_CONFIG.denySelectors,
  denyUrlPatterns: DEFAULT_CONFIG.denyUrlPatterns,
  allowSubmit: true,
};

export const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
export const pathOf = (url: string): string => { const u = new URL(url); return decode(u.pathname + u.search); };
export const clip = (s: string, n = 40): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

export function contextFor(origin: string, learnedPrefixes: Iterable<string>): NormalizeContext {
  return { origin, pathRules: [], learnedPrefixes: new Set(learnedPrefixes), queryParams: 'names', structuralParams: [] };
}

// ---------- 撮影 ----------

export async function settle(page: Page): Promise<void> {
  try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch { /* 常時通信する画面もある */ }
  await page.waitForTimeout(500);
}

/** 骨格が 2 回続けて同じになるまで撮り直す（探索エンジンの stableSnapshot と同じ考え方） */
export async function stableSnapshot(page: Page): Promise<Snapshot> {
  const fp = (s: Snapshot) => JSON.stringify([s.url, s.headings, s.actions.map((a) => [a.role, a.label, a.href]), s.formFields]);
  let snap = await page.evaluate(snapshotInBrowser, OPTS);
  let prev = fp(snap);
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(250);
    snap = await page.evaluate(snapshotInBrowser, OPTS);
    const cur = fp(snap);
    if (cur === prev) break;
    prev = cur;
  }
  return snap;
}

/**
 * 探索エンジンの perform と同じ手順で操作を 1 つ再生する（role・ラベル・出現順で要素を見つけ直して印を付け、
 * 送信系の操作ならそのフォームだけを自動入力して押す）。見つけ直しは本体の findTarget をそのまま使うので、
 * ラベルの数字の違いやデータ区間のリンクの入れ替わり（同じ形の別のリンクで代用）にも本体と同じだけ粘る。
 */
export async function perform(page: Page, action: { role: string; label: string; nth: number; href?: string }, ctx?: NormalizeContext): Promise<{ substituted: boolean }> {
  const snap = await page.evaluate(snapshotInBrowser, OPTS);
  const want = { ...action, kind: 'click' as const, text: action.label };
  const { target, substituted } = findTarget(snap.actions, want, snap.url, ctx ?? contextFor(new URL(snap.url).origin, []));
  if (!target) throw new Error(`操作対象が見つかりません: ${action.label}`);
  await page.evaluate(snapshotInBrowser, { ...OPTS, markIndex: target.index, markExpect: { role: target.role, label: target.label } });
  if (target.kind === 'submit' || (target.role === 'button' && !target.href && !target.toggle)) await page.evaluate(fillScopeInBrowser, DEFAULT_CONFIG.fill);
  await page.click('[data-flowmap-target="1"]', { timeout: 4000, noWaitAfter: true });
  try { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch { /* 画面遷移しない操作もある */ }
  await settle(page);
  return { substituted: !!substituted };
}

// Jev に渡す state は本体と同じものを使う
export { pairState, summarize } from '../../src/jev.js';
