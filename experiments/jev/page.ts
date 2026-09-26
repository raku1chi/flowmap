// 画面を開いて撮り、探索エンジンと同じ手順で操作を再生する。capture.ts と review.ts から使う。
// Jev に渡す要約と差分は本体の src/jev.ts のものを使う。

import type { Page } from 'playwright';
import { fillFormsInBrowser, snapshotInBrowser, type EnumerateOptions, type Snapshot } from '../../src/explore.js';
import { actionKey, normalizeDigits, type NormalizeContext } from '../../src/normalize.js';
import { DEFAULT_CONFIG } from '../../src/types.js';

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

/** ラベルの数字を潰す（桁区切りや小数も 1 つの数として扱う。本体の normalizeDigits と同じ） */
const labelShape = normalizeDigits;

/**
 * 探索エンジンの perform と同じ手順で操作を 1 つ再生する（フォームを埋め、role・ラベル・出現順で要素を見つけ直して押す）。
 * 探索エンジンより 2 点だけ粘る。ラベルの数字は桁区切りごと潰して比べる。データ区間のリンク（企業名など）が
 * 見つからなければ、行き先が同じ形の別のリンクで代用する（データが入れ替わっても同じ種類の画面に着く）。
 */
export async function perform(page: Page, action: { role: string; label: string; nth: number; href?: string }, ctx?: NormalizeContext): Promise<{ substituted: boolean }> {
  await page.evaluate(fillFormsInBrowser, DEFAULT_CONFIG.fill);
  const snap = await page.evaluate(snapshotInBrowser, OPTS);
  let substituted = false;
  let target = snap.actions.find((a) => a.role === action.role && a.label === action.label && a.nth === action.nth);
  if (!target) {
    const want = labelShape(action.label);
    const candidates = snap.actions.filter((a) => a.role === action.role && labelShape(a.label) === want);
    target = candidates[action.nth - 1] ?? candidates[0];
  }
  if (!target && action.href && ctx) {
    const wantKey = actionKey(action, snap.url, ctx, []);
    if (wantKey.includes('*')) {
      target = snap.actions.find((a) => a.href && actionKey(a, snap.url, ctx, []) === wantKey);
      substituted = !!target;
    }
  }
  if (!target) throw new Error(`操作対象が見つかりません: ${action.label}`);
  await page.evaluate(snapshotInBrowser, { ...OPTS, markIndex: target.index });
  await page.click('[data-flowmap-target="1"]', { timeout: 4000, noWaitAfter: true });
  try { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch { /* 画面遷移しない操作もある */ }
  await settle(page);
  return { substituted };
}

// Jev に渡す state は本体と同じものを使う
export { pairState, summarize } from '../../src/jev.js';
