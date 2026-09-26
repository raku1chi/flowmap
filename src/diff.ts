// 前回の実行との差分（DESIGN.md §9・§10）。比較キーはシグネチャで、ノード id は実行ごとに振り直されるので突き合わせない。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { SIGNATURE_VERSION, type Diff, type Graph, type RemovedNode, type StateNode } from './types.js';

export interface BaselineRef {
  /** 比較対象の実行ディレクトリ */
  dir: string;
  /** 表示用の名前（ディレクトリ名） */
  name: string;
  graph: Graph;
}

export class BaselineError extends Error { override name = 'BaselineError'; }

function readGraph(path: string): Graph {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Graph;
  } catch (e) {
    throw new BaselineError(`比較対象の graph.json を読めません: ${path}（${(e as Error).message}）`);
  }
}

/** 途中で止まった実行（中断・時間切れ・エラー）は比較対象に向かない。画面数上限で止まったものは毎回同じ範囲なので使う */
const completeEnough = (g: Graph) => !g.meta.stopKind || g.meta.stopKind === 'maxStates';

/**
 * 比較対象を決める。baseline（実行ディレクトリか graph.json）が指定されていればそれ、
 * なければ同じ runs ディレクトリの直前の実行のうち、最後まで探索したもの。
 */
export function findBaseline(runsDir: string, currentRun: string, baseline?: string | null): BaselineRef | undefined {
  if (baseline) {
    const p = resolve(baseline);
    if (!existsSync(p)) throw new BaselineError(`比較対象が見つかりません: ${p}`);
    const graphPath = statSync(p).isDirectory() ? join(p, 'graph.json') : p;
    if (!existsSync(graphPath)) throw new BaselineError(`比較対象に graph.json がありません: ${p}`);
    const dir = dirname(graphPath);
    return { dir, name: basename(dir), graph: readGraph(graphPath) };
  }
  if (!existsSync(runsDir)) return undefined;
  const runs = readdirSync(runsDir).filter((d) => d !== currentRun && existsSync(join(runsDir, d, 'graph.json'))).sort().reverse();
  for (const name of runs) {
    let g: Graph;
    try { g = readGraph(join(runsDir, name, 'graph.json')); } catch { continue; }
    if (completeEnough(g)) return { dir: join(runsDir, name), name, graph: g };
  }
  return undefined;
}

const toPosix = (p: string) => p.split(sep).join('/');

/**
 * 差分を計算する。Jev が合流させた画面の別名シグネチャ（aliasSignatures）も、そのノードのシグネチャとして突き合わせる。
 * 代表が別のデータの実例になっていることがあるので、「変化」は代表のシグネチャどうしが一致したときだけ見る。
 * 比較の前提が崩れているとき（シグネチャの版・Jev の有無・探索範囲の設定が違う、今回の探索が途中で止まった）は注意書きを付ける。
 */
export function computeDiff(graph: Graph, runDir: string, base: BaselineRef): Diff {
  const prev = base.graph;
  const rel = toPosix(relative(runDir, base.dir)) || '.';
  const shotOf = (p: { screenshot: string }) => (p.screenshot ? `${rel}/${p.screenshot}` : '');
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
    // 外部サイト（撮影だけする別オリジン）のエラーはこのアプリの回帰ではないので、新エラーに数えない
    const external = graph.meta.schemaVersion !== undefined && !n.route;
    if (!p) {
      added.push(n.id);
      if (n.consoleErrors.length > 0 && !external) newErrors.push(n.id); // 新しい画面のエラーも前回になかったエラーとして扱う
      continue;
    }
    previous[n.id] = { screenshot: shotOf(p), textHash: p.textHash };
    if (p.signature === n.signature && p.textHash !== n.textHash) changed.push(n.id);
    if (!external && n.consoleErrors.some((e) => !p.consoleErrors.includes(e))) newErrors.push(n.id);
  }
  const removed: RemovedNode[] = prev.nodes
    .filter((p) => !sigsOf(p).some((sig) => curSigs.has(sig)))
    .map((p) => ({ url: p.url, title: p.title, signature: p.signature, screenshot: shotOf(p) }));

  const warnings: string[] = [];
  let unreliable = false;
  const prevVer = prev.meta.signatureVersion ?? 1;
  const curVer = graph.meta.signatureVersion ?? SIGNATURE_VERSION;
  if (prevVer !== curVer) {
    unreliable = true;
    warnings.push(`比較対象とシグネチャの計算方法が違います（前回 v${prevVer}・今回 v${curVer}）。消失と追加には計算方法の違いによるものが含まれます。次の実行からは揃います`);
  }
  if (!!prev.meta.jev !== !!graph.meta.jev) {
    unreliable = true;
    warnings.push(`比較対象と Jev の設定が違います（前回 ${prev.meta.jev ? 'あり' : 'なし'}・今回 ${graph.meta.jev ? 'あり' : 'なし'}）。合流のしかたが変わるので、消失と追加は設定の違いによるものを含みます`);
  }
  if (graph.meta.stopKind && graph.meta.stopKind !== 'maxStates') {
    unreliable = true;
    warnings.push(`今回の探索は途中で止まったため（${graph.meta.stoppedBecause ?? graph.meta.stopKind}）、消失には到達できなかった画面が含まれます`);
  }
  const scopeKeys = ['maxStates', 'maxDepth', 'maxActionsPerState', 'maxActionsPerPattern', 'queryParams', 'allowSubmit', 'followExternalLinks'];
  if (prev.meta.config && graph.meta.config) {
    const diffs = scopeKeys.filter((k) => JSON.stringify(prev.meta.config![k]) !== JSON.stringify(graph.meta.config![k]));
    if (diffs.length) warnings.push(`比較対象と探索範囲の設定が違います（${diffs.map((k) => `${k}: ${JSON.stringify(prev.meta.config![k])}→${JSON.stringify(graph.meta.config![k])}`).join(', ')}）`);
  }
  if (prev.meta.baseUrl !== graph.meta.baseUrl) warnings.push(`比較対象と起点 URL が違います（前回 ${prev.meta.baseUrl}）`);

  return {
    previousRun: base.name, added, removed, changed, newErrors, previous,
    ...(warnings.length ? { warning: warnings.join(' / ') } : {}),
    ...(unreliable ? { unreliable: true as const } : {}),
  };
}
