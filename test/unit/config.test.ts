import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, DEFAULT_CONFIG, isAllowedHost, loadConfig, parseJsonc, validatePartialConfig } from '../../src/config.js';

test('parseJsonc: コメントと末尾カンマを読み飛ばし、文字列の中は触らない', () => {
  const v = parseJsonc(`{
    // 行コメント
    "url": "http://a.test//b", /* ブロック
    コメント */ "list": [1, 2,],
    "s": "/* ここは文字列 */ \\" //",
  }`) as Record<string, unknown>;
  assert.deepEqual(v, { url: 'http://a.test//b', list: [1, 2], s: '/* ここは文字列 */ " //' });
});

test('validatePartialConfig: 知らないキーは近い名前を添えて報告する', () => {
  const problems = validatePartialConfig({ maxState: 10 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /maxState/);
  assert.match(problems[0], /maxStates/);
});

test('validatePartialConfig: 型・範囲・正規表現・列挙値の誤りをまとめて返す', () => {
  const problems = validatePartialConfig({
    maxStates: 'many', workers: 0, denyUrlPatterns: ['('], queryParams: 'all', failOn: ['nope'],
    jev: { enabled: 'yes', typo: 1 }, pathRules: [{ pattern: '[', replace: '*' }], baseUrl: 'ftp://x',
  });
  assert.ok(problems.length >= 9, problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('jev.typo')));
  assert.deepEqual(validatePartialConfig({ $schema: './schema.json', maxStates: 5 }), []);
});

test('loadConfig: 既定値にマージし、設定ファイル内のパスはファイルの場所から解決する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowmap-config-'));
  mkdirSync(join(dir, 'conf'));
  writeFileSync(join(dir, 'conf', 'flowmap.config.json'), `{
    // コメント可
    "baseUrl": "http://localhost:8787",
    "outDir": "out",
    "storageState": "auth.json",
    "fill": { "search": "ノート" },
    "viewport": { "width": 1024 },
  }`);
  const c = loadConfig('conf/flowmap.config.json', { maxStates: 7, jev: true }, dir);
  assert.equal(c.baseUrl, 'http://localhost:8787');
  assert.equal(c.outDir, join(dir, 'conf', 'out'));
  assert.equal(c.storageState, join(dir, 'conf', 'auth.json'));
  assert.equal(c.maxStates, 7);
  assert.equal(c.fill.search, 'ノート');
  assert.equal(c.fill.email, DEFAULT_CONFIG.fill.email);
  assert.deepEqual(c.viewport, { width: 1024, height: 800 });
  assert.equal(c.jev.enabled, true);
  // CLI の上書きはカレント基準
  const d = loadConfig('conf/flowmap.config.json', { outDir: 'cli-out' }, dir);
  assert.equal(d.outDir, join(dir, 'cli-out'));
});

test('loadConfig: 設定ファイルが無ければ既定値、指定したのに無ければエラー', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowmap-config-'));
  assert.equal(loadConfig(undefined, {}, dir).maxStates, DEFAULT_CONFIG.maxStates);
  assert.throws(() => loadConfig('missing.json', {}, dir), ConfigError);
});

test('loadConfig: CLI 引数の誤った値も検証する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowmap-config-'));
  assert.throws(() => loadConfig(undefined, { workers: 0 }, dir), /workers/);
  assert.throws(() => loadConfig(undefined, { maxStates: Number.NaN }, dir), /maxStates/);
});

test('既定の除外文言は削られていない（CLAUDE.md の不変条件）', () => {
  for (const t of ['ログアウト', '削除', '退会', 'logout', 'sign out', 'delete']) assert.ok(DEFAULT_CONFIG.denyText.includes(t), t);
  for (const p of ['/logout', '/signout', '^mailto:', '^tel:']) assert.ok(DEFAULT_CONFIG.denyUrlPatterns.includes(p), p);
  assert.ok(DEFAULT_CONFIG.denySelectors.includes('[data-flowmap-ignore]'));
  assert.equal(DEFAULT_CONFIG.jev.enabled, false);
});

test('isAllowedHost: localhost・127.0.0.1・*.local と allowedHosts だけを許可する', () => {
  const base = { ...DEFAULT_CONFIG };
  assert.ok(isAllowedHost({ ...base, baseUrl: 'http://localhost:3000' }));
  assert.ok(isAllowedHost({ ...base, baseUrl: 'http://app.local' }));
  assert.ok(!isAllowedHost({ ...base, baseUrl: 'https://staging.example.com' }));
  assert.ok(isAllowedHost({ ...base, baseUrl: 'https://staging.example.com', allowedHosts: ['staging.example.com'] }));
});
