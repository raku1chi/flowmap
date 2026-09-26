// CI 向けの出力（DESIGN.md §10）。ゲートの判定と、PR コメントにそのまま貼れる summary.md・機械で読む summary.json。
// 判断は人が行う前提で、件数と index.html への導線だけを短く出す。「変化」はデータ差でも出るのでゲートに入れない。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateKind, Graph, StateNode } from './types.js';

export interface GateResult {
  failOn: GateKind[];
  failed: boolean;
  /** 失敗した理由（件数つき） */
  reasons: string[];
  /** 判定しなかった条件とその理由 */
  notes: string[];
}

/** 外部サイト（撮影だけする別オリジン）は、このアプリの問題ではないので数えない */
const isExternal = (g: Graph, n: StateNode) => g.meta.schemaVersion !== undefined && !n.route;
const errorNodes = (g: Graph) => g.nodes.filter((n) => !isExternal(g, n) && n.consoleErrors.length + n.failedRequests.length > 0);

/**
 * ゲートを判定する。
 * - new-errors: 前回になかったコンソールエラー（前回が無ければ、今回のコンソールエラーすべて）
 * - removed: 前回あって今回消えた画面。比較の前提が違う（シグネチャの版・Jev・中断）ときは数えない
 * - errors: コンソールエラーか失敗したリクエストのある画面
 * - failed-actions: 失敗した操作（経路の再現失敗を含む）
 */
export function evaluateGate(graph: Graph, failOn: GateKind[]): GateResult {
  const reasons: string[] = [];
  const notes: string[] = [];
  const d = graph.diff;
  for (const k of failOn) {
    if (k === 'new-errors') {
      const n = d ? d.newErrors.length : graph.nodes.filter((x) => !isExternal(graph, x) && x.consoleErrors.length).length;
      if (n) reasons.push(`新しいエラーのある画面 ${n}${d ? '' : '（比較対象が無いので今回のエラーすべて）'}`);
    } else if (k === 'removed') {
      if (!d) notes.push('消失: 比較対象が無いので判定していません');
      else if (d.unreliable) notes.push('消失: 比較の前提が違うので判定していません（' + (d.warning ?? '') + '）');
      else if (d.removed.length) reasons.push(`消えた画面 ${d.removed.length}`);
    } else if (k === 'errors') {
      const n = errorNodes(graph).length;
      if (n) reasons.push(`エラーのある画面 ${n}`);
    } else if (k === 'failed-actions') {
      const n = graph.edges.filter((e) => e.error).length;
      if (n) reasons.push(`失敗した操作 ${n}`);
    }
  }
  return { failOn, failed: reasons.length > 0, reasons, notes };
}

const pathOf = (url: string, base: string): string => {
  try {
    const u = new URL(url);
    const b = new URL(base);
    const p = u.origin === b.origin ? u.pathname + u.search : u.host + u.pathname;
    return decodeURI(p);
  } catch {
    return url;
  }
};
const clip = (s: string, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s);
const mdEscape = (s: string) => s.replace(/([\\`*_[\]|<>])/g, '\\$1').replace(/\n/g, ' ');

/** PR コメントに貼る要約（Markdown）。indexPath はコメントから辿れる index.html の場所（CI の成果物名など） */
export function summaryMarkdown(graph: Graph, gate: GateResult, indexPath: string): string {
  const d = graph.diff;
  const base = graph.meta.baseUrl;
  const name = (n: StateNode) => `${mdEscape(n.title || '(無題)')} \`${mdEscape(pathOf(n.url, base))}\``;
  const secs = Math.round((new Date(graph.meta.finishedAt).getTime() - new Date(graph.meta.startedAt).getTime()) / 1000);
  const lines: string[] = [];
  lines.push(`### flowmap: ${mdEscape(base)}`);
  lines.push('');
  lines.push(`- 画面 **${graph.nodes.length}** / 操作 ${graph.edges.length} / エラーのある画面 **${errorNodes(graph).length}** / 所要 ${Math.floor(secs / 60)}分${secs % 60}秒`);
  if (d) lines.push(`- 前回比（${mdEscape(d.previousRun)}）: 追加 ${d.added.length} / 消失 **${d.removed.length}** / 変化 ${d.changed.length} / 新エラー **${d.newErrors.length}**`);
  else lines.push('- 前回比: 比較対象がありません（初回）');
  if (gate.failOn.length) lines.push(`- ゲート（${gate.failOn.join(', ')}）: ${gate.failed ? `❌ ${gate.reasons.join('、')}` : '✅ 通過'}`);
  if (graph.meta.stoppedBecause) lines.push(`- 探索の停止: ${mdEscape(graph.meta.stoppedBecause)}`);
  if (d?.warning) lines.push(`- ⚠ ${mdEscape(d.warning)}`);
  for (const n of gate.notes) lines.push(`- ${mdEscape(n)}`);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const section = (title: string, items: string[], limit = 10) => {
    if (!items.length) return;
    lines.push('', `<details${items.length <= 5 ? ' open' : ''}><summary>${title}（${items.length}）</summary>`, '');
    for (const it of items.slice(0, limit)) lines.push(`- ${it}`);
    if (items.length > limit) lines.push(`- ほか ${items.length - limit} 件`);
    lines.push('', '</details>');
  };
  if (d) {
    section('新しいエラー', d.newErrors.map((id) => byId.get(id)!).filter(Boolean).map((n) => `${name(n)}: ${mdEscape(clip(n.consoleErrors[0] ?? ''))}`));
    section('消えた画面', d.removed.map((r) => `${mdEscape(r.title || '(無題)')} \`${mdEscape(pathOf(r.url, base))}\``));
    section('新しく現れた画面', d.added.map((id) => byId.get(id)!).filter(Boolean).map(name));
  } else {
    section('エラーのある画面', errorNodes(graph).map((n) => `${name(n)}: ${mdEscape(clip(n.consoleErrors[0] ?? n.failedRequests[0] ?? ''))}`));
  }
  const failed = graph.edges.filter((e) => e.error);
  section('失敗した操作', failed.map((e) => `${byId.get(e.from) ? name(byId.get(e.from)!) : e.from}: 「${mdEscape(e.action.label)}」 — ${mdEscape(clip(e.error ?? ''))}`));
  lines.push('', `全体図: \`${indexPath}\``);
  return lines.join('\n') + '\n';
}

export function summaryJson(graph: Graph, gate: GateResult) {
  const d = graph.diff;
  return {
    baseUrl: graph.meta.baseUrl,
    startedAt: graph.meta.startedAt,
    finishedAt: graph.meta.finishedAt,
    stoppedBecause: graph.meta.stoppedBecause ?? null,
    screens: graph.nodes.length,
    actions: graph.edges.length,
    errorScreens: errorNodes(graph).length,
    failedActions: graph.edges.filter((e) => e.error).length,
    diff: d
      ? { previousRun: d.previousRun, added: d.added.length, removed: d.removed.length, changed: d.changed.length, newErrors: d.newErrors.length, warning: d.warning ?? null, unreliable: !!d.unreliable }
      : null,
    gate,
  };
}

/** summary.md と summary.json を実行ディレクトリに書く */
export function writeSummary(runDir: string, graph: Graph, gate: GateResult, indexPath: string): { md: string } {
  const md = summaryMarkdown(graph, gate, indexPath);
  writeFileSync(join(runDir, 'summary.md'), md);
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summaryJson(graph, gate), null, 2) + '\n');
  return { md };
}
