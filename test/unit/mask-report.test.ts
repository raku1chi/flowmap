import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { maskUrl, maskUrlsInText, paramMatcher } from '../../src/mask.js';
import { evaluateGate, summaryMarkdown } from '../../src/report.js';
import type { Graph } from '../../src/types.js';

const sensitive = paramMatcher(DEFAULT_CONFIG.maskUrlParams);

test('maskUrl: 機微な名前のクエリ・ハッシュの値と userinfo のパスワードを伏せる', () => {
  assert.equal(maskUrl('http://a.test/cb?code=abc&page=2', sensitive), 'http://a.test/cb?code=***&page=2');
  assert.equal(maskUrl('http://a.test/#access_token=xyz&expires_in=3600', sensitive), 'http://a.test/#access_token=***&expires_in=3600');
  assert.equal(maskUrl('https://user:secret@a.test/x', sensitive), 'https://user:***@a.test/x');
  assert.equal(maskUrl('/reset?reset_token=t1&lang=ja', sensitive), '/reset?reset_token=***&lang=ja');
  assert.equal(maskUrl('http://a.test/search?q=token', sensitive), 'http://a.test/search?q=token');
  assert.equal(maskUrl('http://a.test/x?X-Amz-Signature=abc', sensitive), 'http://a.test/x?X-Amz-Signature=***');
});

test('maskUrlsInText: 文中の URL だけを伏せる', () => {
  assert.equal(maskUrlsInText('500 GET http://a.test/api?apikey=k1 (failed)', sensitive), '500 GET http://a.test/api?apikey=*** (failed)');
});

test('paramMatcher: * は任意の文字列、大小は無視', () => {
  const m = paramMatcher(['*token*', 'sid']);
  assert.ok(m('ACCESS_TOKEN'));
  assert.ok(m('sid'));
  assert.ok(!m('side'));
});

const g = (over: Partial<Graph> = {}): Graph => ({
  meta: { baseUrl: 'http://a.test', startedAt: '2026-09-26T00:00:00.000Z', finishedAt: '2026-09-26T00:02:05.000Z', totalStates: 2, totalEdges: 1 },
  root: 's001',
  nodes: [
    { id: 's001', signature: 'A', url: 'http://a.test/', title: 'トップ', depth: 0, screenshot: 'shots/s001.png', textHash: 'h', headings: [], consoleErrors: [], failedRequests: [], actionsTotal: 1, actionsTried: 1 },
    { id: 's002', signature: 'B', url: 'http://a.test/items', title: '一覧', depth: 1, screenshot: 'shots/s002.png', textHash: 'h', headings: [], consoleErrors: ['boom'], failedRequests: [], actionsTotal: 0, actionsTried: 0 },
  ],
  edges: [{ from: 's001', to: 's001', action: { label: '保存', kind: 'click', role: 'button', text: '保存', nth: 1 }, error: 'クリック失敗' }],
  ...over,
});

test('evaluateGate: 条件ごとの判定と、比較の前提が違うときは消失を数えない', () => {
  const noDiff = evaluateGate(g(), ['new-errors', 'removed', 'errors', 'failed-actions']);
  assert.ok(noDiff.failed);
  assert.equal(noDiff.reasons.length, 3);
  assert.equal(noDiff.notes.length, 1); // 比較対象が無いので消失は判定しない
  const withDiff = g({ diff: { previousRun: 'p', added: [], removed: [{ url: 'http://a.test/x', title: 'x', screenshot: '', signature: 'X' }], changed: ['s001'], newErrors: [] } });
  assert.deepEqual(evaluateGate(withDiff, ['new-errors']).failed, false);
  assert.deepEqual(evaluateGate(withDiff, ['removed']).reasons, ['消えた画面 1']);
  const unreliable = g({ diff: { ...withDiff.diff!, unreliable: true, warning: '版が違う' } });
  assert.equal(evaluateGate(unreliable, ['removed']).failed, false);
  assert.equal(evaluateGate(g(), []).failed, false);
});

test('summaryMarkdown: 件数・ゲート・問題の一覧と index.html の場所を出す', () => {
  const md = summaryMarkdown(g(), evaluateGate(g(), ['errors']), 'flowmap-out/runs/x/index.html');
  assert.match(md, /画面 \*\*2\*\*/);
  assert.match(md, /❌ エラーのある画面 1/);
  assert.match(md, /失敗した操作/);
  assert.match(md, /flowmap-out\/runs\/x\/index.html/);
});

test('evaluateGate: 外部サイト（撮影だけの別オリジン）のエラーはゲートに数えない', () => {
  const graph = g({ meta: { ...g().meta, schemaVersion: 2 } });
  graph.nodes[1].route = '/items';
  graph.nodes.push({ id: 's003', signature: 'E', url: 'https://ext.example/', title: '外部', depth: 1, screenshot: '', textHash: 'h', headings: [], consoleErrors: ['third-party'], failedRequests: ['GET https://ext.example/ (net::ERR_CERT_AUTHORITY_INVALID)'], actionsTotal: 0, actionsTried: 0, truncated: '外部サイト' });
  graph.nodes[0].route = '/';
  const r = evaluateGate(graph, ['errors', 'new-errors']);
  assert.deepEqual(r.reasons, ['エラーのある画面 1', '新しいエラーのある画面 1（比較対象が無いので今回のエラーすべて）']);
});
