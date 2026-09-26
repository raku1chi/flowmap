// 探索結果（graph.json）の画面のうち、同じ区画（先頭のパス区間が同じ）にある組を Jev に見せ、
// 「同じ画面」と判定された組を合流させたら画面がいくつになるかを試す。flowmap の出力は書き換えない。
//
//   pnpm exec tsx experiments/jev/review.ts flowmap-out/runs/<dir> [--merge 0.7] [--keep 0.3]
//
// 判定は「種類と目的が同じ画面か」と「違いは UI 操作（タブ・メニュー・ダイアログ）によるものか」の 2 つの問いを組み合わせ、
// 合流の度合い = min(種類が同じ, 1 - UI 操作の違い) とする。差分が空の組は Jev に聞かず 1 とする。
// --merge 以上なら合流、--keep 以下なら別の画面、その間は「保留」として合流させない。
// Jev の値は同じ入力でも実行ごとに少し揺れる（実測で最大 0.07）ので、0.5 付近で決めない。
// 合流は完全連結で行う。グループ内のすべての組が --merge 以上のときだけ 1 つにまとめ、A≈B・B≈C から A と C を繋げない。
// 画面の状態は探索と同じく起点から発見経路を再生して作る（URL を直接開くとメニューの開閉などの状態を再現できないため）。

import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { signatureOf, type Snapshot } from '../../src/explore.js';
import { DEFAULT_CONFIG, type ActionDesc, type Graph, type StateNode } from '../../src/types.js';
import { apiKey, callJev, mergeScore, MODEL, PAGE_SPLIT, pool, QUESTIONS } from './jev.js';
import { contextFor, pairState, pathOf, perform, settle, stableSnapshot } from './page.js';

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const runDir = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const MERGE = Number(opt('merge') ?? 0.7);
const KEEP = Number(opt('keep') ?? 0.3);
if (!runDir) {
  console.error('使い方: pnpm exec tsx experiments/jev/review.ts flowmap-out/runs/<dir> [--merge 0.7] [--keep 0.3]');
  process.exit(2);
}
const key = apiKey();
if (!key) {
  console.error('TYPESAFE_API_KEY がありません。.env.example を .env にコピーしてキーを入れてください。');
  process.exit(2);
}

const graph = JSON.parse(readFileSync(join(runDir, 'graph.json'), 'utf8')) as Graph;
const byId = new Map(graph.nodes.map((n) => [n.id, n]));
const origin = new URL(graph.meta.baseUrl).origin;
const learned = (graph.meta.learnedPathRules ?? []).map((r) => r.replace(/\/\*$/, ''));
const ctx = contextFor(origin, learned);

// 各画面に最初に到達した辺（発見辺）を辿って、起点からの操作列を作る
const discovery = new Map<string, { from: string; action: ActionDesc }>();
for (const e of graph.edges) {
  if (e.error || e.from === e.to || e.to === graph.root || discovery.has(e.to)) continue;
  discovery.set(e.to, { from: e.from, action: e.action });
}
function pathTo(id: string): ActionDesc[] {
  const steps: ActionDesc[] = [];
  for (let cur = id; cur !== graph.root;) {
    const d = discovery.get(cur);
    if (!d) throw new Error(`${cur} の発見経路がありません`);
    steps.unshift(d.action);
    cur = d.from;
  }
  return steps;
}

const targets = graph.nodes.filter((n) => n.route); // 外部サイトは対象外
const sectionOf = (n: StateNode) => n.route!.split('?')[0].split('/')[1] ?? '';
const label = (n: StateNode) => `${n.id} ${n.title.replace(/ [—-] [^—-]+$/, '')}（${n.route}）`;

// ---------- 撮影 ----------

const snaps = new Map<string, Snapshot>();
const notReproduced: string[] = [];
const failed: string[] = [];
const substitutedNodes: string[] = [];
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: DEFAULT_CONFIG.viewport, locale: 'ja-JP', acceptDownloads: false });
  await context.addInitScript(() => { (globalThis as unknown as { __name?: unknown }).__name ??= (f: unknown) => f; });
  const page = await context.newPage();
  context.on('page', (p) => { if (p !== page) p.close().catch(() => {}); });
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  for (const n of targets) {
    try {
      await page.goto(graph.meta.baseUrl, { waitUntil: 'domcontentloaded' });
      await settle(page);
      let substituted = false;
      for (const step of pathTo(n.id)) substituted = (await perform(page, step, ctx)).substituted || substituted;
      const snap = await stableSnapshot(page);
      snaps.set(n.id, snap);
      if (substituted) substitutedNodes.push(`${n.id}（${pathOf(snap.url)} で代用）`);
      // 学習済みのデータ区間を全部当てて計算し直すので、学習前に撮った画面は一致しないことがある（参考情報）
      if (signatureOf(snap, ctx).signature !== n.signature) notReproduced.push(n.id);
      process.stderr.write(`  撮影 ${n.id} ${pathOf(snap.url)}\n`);
    } catch (e) {
      failed.push(`${n.id}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
} finally {
  await browser.close();
}

// ---------- 問い合わせ ----------

const pairKey = (a: string, b: string) => [a, b].sort().join('|');
const candidates: [string, string][] = [];
const shot = targets.filter((n) => snaps.has(n.id));
for (let i = 0; i < shot.length; i++) {
  for (let j = i + 1; j < shot.length; j++) {
    if (sectionOf(shot[i]) === sectionOf(shot[j])) candidates.push([shot[i].id, shot[j].id]);
  }
}
process.stderr.write(`  ${candidates.length} 組を問い合わせます\n`);
// 判定は「種類が同じか」と「違いは UI 操作によるものか」の 2 つの問いを組み合わせる（差分が空ならコードで同じと決める）。
// 1 つの問い（single）も参考に並べる
const answers = await pool(candidates, 4, async ([a, b]) => {
  const state = pairState(snaps.get(a)!, snaps.get(b)!, ctx);
  const r = await callJev(key, { model: MODEL, state, questions: { ...QUESTIONS.pages, ...PAGE_SPLIT } });
  const sameKind = r.answers.same_kind.noul;
  const uiState = r.answers.ui_state.noul;
  return { a, b, score: mergeScore(state, sameKind, uiState), sameKind, uiState, single: r.answers.ja.noul, tokens: r.usage.input_tokens };
});
const value = new Map(answers.map((x) => [pairKey(x.a, x.b), x.score]));

// ---------- 完全連結で合流 ----------

let clusters: string[][] = shot.map((n) => [n.id]);
for (const x of [...answers].sort((p, q) => q.score - p.score)) {
  if (x.score < MERGE) break;
  const ca = clusters.find((c) => c.includes(x.a))!;
  const cb = clusters.find((c) => c.includes(x.b))!;
  if (ca === cb) continue;
  if (!ca.every((u) => cb.every((v) => (value.get(pairKey(u, v)) ?? 0) >= MERGE))) continue;
  clusters = clusters.filter((c) => c !== ca && c !== cb);
  clusters.push([...ca, ...cb].sort());
}
clusters.sort((p, q) => p[0].localeCompare(q[0]));

// ---------- 報告 ----------

const lines: string[] = [];
const fmt = (x: number) => x.toFixed(2);
const external = graph.nodes.length - targets.length;
lines.push(`# Jev によるレビュー: ${runDir}`, '');
lines.push(`画面 ${graph.nodes.length}${external ? `（外部サイト ${external} を除く ${targets.length}）` : ''} → 合流後 ${clusters.length + (targets.length - shot.length)}。`);
lines.push(`同じ区画の ${candidates.length} 組を問い合わせ。合流は ${MERGE} 以上、別の画面は ${KEEP} 以下、その間は保留。`, '');
lines.push('## 合流するグループ', '');
const merged = clusters.filter((c) => c.length > 1);
if (!merged.length) lines.push('なし', '');
for (const c of merged) {
  let min = 1;
  for (const u of c) for (const v of c) if (u < v) min = Math.min(min, value.get(pairKey(u, v)) ?? 0);
  lines.push(`- **${c.length} 画面を 1 つに**（組の最小値 ${fmt(min)}）`);
  for (const id of c) lines.push(`  - ${label(byId.get(id)!)}`);
}
lines.push('', '## 保留（合流させない）', '');
const detail = (x: (typeof answers)[number]) => `種類が同じ ${fmt(x.sameKind)} / UI 操作の違い ${fmt(x.uiState)} / 1 つの問い ${fmt(x.single)}`;
const gray = answers.filter((x) => x.score > KEEP && x.score < MERGE).sort((p, q) => q.score - p.score);
if (!gray.length) lines.push('なし');
for (const x of gray) lines.push(`- ${fmt(x.score)}: ${label(byId.get(x.a)!)} と ${label(byId.get(x.b)!)}（${detail(x)}）`);
lines.push('', '## 別の画面と判定した組（同じ区画のもの）', '');
const apart = answers.filter((x) => x.score <= KEEP).sort((p, q) => q.score - p.score);
if (!apart.length) lines.push('なし');
for (const x of apart) lines.push(`- ${fmt(x.score)}: ${label(byId.get(x.a)!)} と ${label(byId.get(x.b)!)}（${detail(x)}）`);
if (failed.length || notReproduced.length || substitutedNodes.length) {
  lines.push('', '## 注意', '');
  for (const f of failed) lines.push(`- 撮影できなかった: ${f}`);
  if (substitutedNodes.length) lines.push(`- 探索時のリンクが見つからず、同じ形の別のリンクで代用した: ${substitutedNodes.join(', ')}`);
  if (notReproduced.length) lines.push(`- シグネチャが探索時と一致しなかった（学習の順序の違いか、状態を再現できていない）: ${notReproduced.join(', ')}`);
}
const tokens = answers.reduce((s, x) => s + x.tokens, 0);
lines.push('', `入力 ${tokens} トークン。モデル ${MODEL}。`);

const text = lines.join('\n');
const outDir = resolve('flowmap-out/jev');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(join(outDir, `review-${stamp}.md`), text + '\n');
writeFileSync(join(outDir, `review-${stamp}.json`), JSON.stringify({ runDir, merge: MERGE, keep: KEEP, clusters, answers, notReproduced, failed, substituted: substitutedNodes }, null, 2));
console.log(text);
console.log(`\n書き出し: ${join(outDir, `review-${stamp}.md`)}`);
