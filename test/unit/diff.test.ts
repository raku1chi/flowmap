import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDiff, findBaseline, type BaselineRef } from '../../src/diff.js';
import { SIGNATURE_VERSION, type Graph, type StateNode } from '../../src/types.js';

const node = (id: string, signature: string, over: Partial<StateNode> = {}): StateNode => ({
  id, signature, url: `http://app.test/${id}`, title: id, depth: 1, screenshot: `shots/${id}.png`, textHash: 'h', headings: [],
  consoleErrors: [], failedRequests: [], actionsTotal: 0, actionsTried: 0, ...over,
});

const graph = (nodes: StateNode[], meta: Partial<Graph['meta']> = {}): Graph => ({
  meta: { baseUrl: 'http://app.test', startedAt: '2026-09-26T00:00:00.000Z', finishedAt: '2026-09-26T00:01:00.000Z', totalStates: nodes.length, totalEdges: 0, signatureVersion: SIGNATURE_VERSION, ...meta },
  root: nodes[0]?.id ?? 's001',
  nodes,
  edges: [],
});

test('computeDiff: シグネチャで突き合わせ、id は突き合わせない', () => {
  const prev = graph([node('s001', 'A'), node('s002', 'B', { consoleErrors: ['old'] }), node('s003', 'C')]);
  // 今回は id が振り直されている（s002 が C、s003 が B）
  const cur = graph([node('s001', 'A', { textHash: 'x' }), node('s002', 'C'), node('s003', 'B', { consoleErrors: ['old', 'new'] }), node('s004', 'D', { consoleErrors: ['boom'] })]);
  const base: BaselineRef = { dir: '/runs/prev', name: 'prev', graph: prev };
  const d = computeDiff(cur, '/runs/cur', base);
  assert.deepEqual(d.added, ['s004']);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.changed, ['s001']);
  assert.deepEqual(d.newErrors.sort(), ['s003', 's004']);
  assert.equal(d.previous!.s002.screenshot, '../prev/shots/s003.png');
  assert.equal(d.warning, undefined);
  assert.equal(d.unreliable, undefined);
});

test('computeDiff: 消えた画面と、Jev の別名シグネチャでの突き合わせ', () => {
  const prev = graph([node('s001', 'A'), node('s002', 'B'), node('s003', 'X')]);
  const cur = graph([node('s001', 'A'), node('s002', 'B2', { aliasSignatures: ['B'] })]);
  const d = computeDiff(cur, '/runs/cur', { dir: '/runs/prev', name: 'prev', graph: prev });
  assert.deepEqual(d.removed.map((r) => r.signature), ['X']);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.changed, []); // 代表が別の実例なので「変化」は見ない
});

test('computeDiff: シグネチャの版・Jev・中断が違えば注意書きを付け、信頼できない印を付ける', () => {
  const prev = graph([node('s001', 'A')], { signatureVersion: 1 });
  const cur = graph([node('s001', 'A2')], { jev: { model: 'm', requests: 0, cacheHits: 0, errors: 0, skippedActions: 0, mergedStates: 0, rejectedPathRules: [] }, stopKind: 'interrupted', stoppedBecause: '中断' });
  const d = computeDiff(cur, '/runs/cur', { dir: '/runs/prev', name: 'prev', graph: prev });
  assert.ok(d.unreliable);
  assert.match(d.warning!, /シグネチャの計算方法/);
  assert.match(d.warning!, /Jev/);
  assert.match(d.warning!, /途中で止まった/);
  // 画面数上限で止まったのは毎回同じ範囲なので、信頼できる
  const e = computeDiff(graph([node('s001', 'A')], { stopKind: 'maxStates' }), '/r/c', { dir: '/r/p', name: 'p', graph: graph([node('s001', 'A')]) });
  assert.equal(e.unreliable, undefined);
});

test('findBaseline: 直前の実行のうち、途中で止まっていないものを選ぶ', () => {
  const runs = mkdtempSync(join(tmpdir(), 'flowmap-runs-'));
  const write = (name: string, g: Graph) => { mkdirSync(join(runs, name)); writeFileSync(join(runs, name, 'graph.json'), JSON.stringify(g)); };
  write('2026-09-24T00-00-00-000Z', graph([node('s001', 'A')]));
  write('2026-09-25T00-00-00-000Z', graph([node('s001', 'A')], { stopKind: 'maxStates' }));
  write('2026-09-26T00-00-00-000Z', graph([node('s001', 'A')], { stopKind: 'interrupted' }));
  mkdirSync(join(runs, '2026-09-26T01-00-00-000Z')); // graph.json の無い実行は無視
  assert.equal(findBaseline(runs, 'current')!.name, '2026-09-25T00-00-00-000Z');
  assert.equal(findBaseline(runs, 'current', join(runs, '2026-09-24T00-00-00-000Z'))!.name, '2026-09-24T00-00-00-000Z');
  assert.equal(findBaseline(runs, 'current', join(runs, '2026-09-24T00-00-00-000Z', 'graph.json'))!.name, '2026-09-24T00-00-00-000Z');
  assert.throws(() => findBaseline(runs, 'current', join(runs, 'nope')), /見つかりません/);
  assert.equal(findBaseline(join(runs, 'missing'), 'current'), undefined);
});
