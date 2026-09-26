// 設定の既定値・読み込み・検証。flowmap.config.json（コメント可）→ 既定値にマージ → CLI 引数で上書き、の順に組み立てる。
// 知らないキーや型の違いは、探索を始める前にまとめて報告する（打ち間違いを黙って無視しない）。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { FlowmapConfig, GateKind } from './types.js';

export const DEFAULT_CONFIG: FlowmapConfig = {
  baseUrl: 'http://localhost:3000',
  outDir: 'flowmap-out',
  maxStates: 60,
  maxDepth: 6,
  maxActionsPerState: 25,
  maxActionsPerPattern: 3,
  maxLocalActionRepeats: 2,
  maxLinkRepeats: 3,
  maxDurationMinutes: 0,
  workers: 4,
  settleMs: 0,
  quietMs: 400,
  settleTimeoutMs: 5000,
  stabilizeMs: 2000,
  actionTimeoutMs: 5000,
  navigationTimeoutMs: 20000,
  useBackNavigation: true,
  followExternalLinks: true,
  viewport: { width: 1280, height: 800 },
  fullPageScreenshots: false,
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
  headless: true,
  browserChannel: null,
  serviceWorkers: 'block',
  blockUrlPatterns: [],
  storageState: null,
  loginUrlPattern: null,
  // 既定の除外は削らない（CLAUDE.md）。足すのはよい
  denyText: ['ログアウト', '削除', '退会', 'logout', 'sign out', 'delete', 'log out', 'サインアウト', '解約'],
  denySelectors: ['[data-flowmap-ignore]'],
  denyUrlPatterns: ['/logout', '/signout', '^mailto:', '^tel:', '/(log|sign)[-_]out', '^sms:'],
  allowSubmit: true,
  allowedHosts: ['localhost', '127.0.0.1'],
  dialogs: 'accept',
  fill: {
    email: 'flowmap@example.com',
    password: 'flowmap-pass-1234',
    text: 'flowmap テスト入力',
    number: '1',
    tel: '0312345678',
    search: 'flowmap',
    url: 'https://example.com/',
    date: '2026-01-15',
    time: '10:00',
    'datetime-local': '2026-01-15T10:00',
    month: '2026-01',
    week: '2026-W03',
  },
  pathRules: [],
  autoPathRules: true,
  autoPathRulesMinSiblings: 3,
  queryParams: 'ignore',
  structuralParams: [],
  dataParams: [],
  volatileSelectors: ['[data-flowmap-volatile]'],
  hideSelectors: [],
  maskUrlParams: ['*token*', '*secret*', '*password*', '*passwd*', 'code', 'state', 'session*', 'sid', '*apikey*', '*api_key*', 'key', 'auth*', 'signature', 'sig', 'x-amz-*', 'jwt', 'otp', 'email'],
  baseline: null,
  failOn: [],
  screenNames: {},
  // Jev は任意の補助。画面の同定（合流・データ区間）には使わない既定にし、危険な操作の判定だけを行う（DESIGN.md §5）
  jev: {
    enabled: false,
    model: 'jev-latest',
    actions: true,
    pages: false,
    dataSegments: false,
    actionThreshold: 0.5,
    mergeThreshold: 0.7,
  },
};

export const GATE_KINDS: readonly GateKind[] = ['new-errors', 'removed', 'errors', 'failed-actions'];

/** CLI 引数で上書きできる設定。パスはカレントディレクトリ基準 */
export type ConfigOverrides = Partial<Pick<FlowmapConfig,
  'baseUrl' | 'outDir' | 'maxStates' | 'maxDepth' | 'storageState' | 'workers' | 'maxDurationMinutes' | 'baseline' | 'failOn' | 'headless'>> & {
  /** --jev で Jev を有効にする */
  jev?: boolean;
};

export class ConfigError extends Error {
  constructor(readonly problems: string[], readonly source?: string) {
    super(`設定に問題があります${source ? `（${source}）` : ''}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

// ---------- JSON（コメント・末尾カンマ可） ----------

/** // と /* *\/ のコメント、末尾のカンマを取り除いてから JSON として読む。文字列の中は触らない */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // 末尾カンマ: , の後に空白だけを挟んで } か ] が来るもの（文字列は上で素通ししているので、ここに残る , は構文上のもの）
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

// ---------- 検証 ----------

type Spec =
  | { t: 'string'; nullable?: boolean; enum?: readonly string[]; url?: boolean; regex?: boolean }
  | { t: 'number'; min: number; max?: number; int?: boolean }
  | { t: 'boolean' }
  | { t: 'strings'; regex?: boolean; enum?: readonly string[] }
  | { t: 'record' }
  | { t: 'object'; fields: Record<string, Spec> }
  | { t: 'pathRules' };

const int = (min: number, max?: number): Spec => ({ t: 'number', min, max, int: true });

const SPEC: Record<keyof FlowmapConfig, Spec> = {
  baseUrl: { t: 'string', url: true },
  outDir: { t: 'string' },
  maxStates: int(1, 10000),
  maxDepth: int(0, 100),
  maxActionsPerState: int(1, 1000),
  maxActionsPerPattern: int(0, 1000),
  maxLocalActionRepeats: int(0, 1000),
  maxLinkRepeats: int(0, 1000),
  maxDurationMinutes: { t: 'number', min: 0 },
  workers: int(1, 32),
  settleMs: int(0, 60000),
  quietMs: int(0, 10000),
  settleTimeoutMs: int(0, 120000),
  stabilizeMs: int(0, 60000),
  actionTimeoutMs: int(100, 120000),
  navigationTimeoutMs: int(1000, 300000),
  useBackNavigation: { t: 'boolean' },
  followExternalLinks: { t: 'boolean' },
  viewport: { t: 'object', fields: { width: int(200, 10000), height: int(200, 10000) } },
  fullPageScreenshots: { t: 'boolean' },
  locale: { t: 'string' },
  timezoneId: { t: 'string', nullable: true },
  headless: { t: 'boolean' },
  browserChannel: { t: 'string', nullable: true },
  serviceWorkers: { t: 'string', enum: ['block', 'allow'] },
  blockUrlPatterns: { t: 'strings', regex: true },
  storageState: { t: 'string', nullable: true },
  loginUrlPattern: { t: 'string', nullable: true, regex: true },
  denyText: { t: 'strings' },
  denySelectors: { t: 'strings' },
  denyUrlPatterns: { t: 'strings', regex: true },
  allowSubmit: { t: 'boolean' },
  allowedHosts: { t: 'strings' },
  dialogs: { t: 'string', enum: ['accept', 'dismiss'] },
  fill: { t: 'record' },
  pathRules: { t: 'pathRules' },
  autoPathRules: { t: 'boolean' },
  autoPathRulesMinSiblings: int(2, 1000),
  queryParams: { t: 'string', enum: ['ignore', 'names', 'values'] },
  structuralParams: { t: 'strings' },
  dataParams: { t: 'strings' },
  volatileSelectors: { t: 'strings' },
  hideSelectors: { t: 'strings' },
  maskUrlParams: { t: 'strings' },
  baseline: { t: 'string', nullable: true },
  failOn: { t: 'strings', enum: GATE_KINDS },
  screenNames: { t: 'record' },
  jev: {
    t: 'object',
    fields: {
      enabled: { t: 'boolean' },
      model: { t: 'string' },
      actions: { t: 'boolean' },
      pages: { t: 'boolean' },
      dataSegments: { t: 'boolean' },
      actionThreshold: { t: 'number', min: 0, max: 1 },
      mergeThreshold: { t: 'number', min: 0, max: 1 },
    },
  },
};

const typeName = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? '配列' : typeof v === 'object' ? 'オブジェクト' : typeof v);

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

function suggest(key: string, known: string[]): string {
  const best = known
    .map((k) => ({ k, d: levenshtein(key.toLowerCase(), k.toLowerCase()) }))
    .sort((x, y) => x.d - y.d)[0];
  return best && best.d <= Math.max(2, Math.floor(key.length / 4)) ? `。もしかして "${best.k}"？` : '';
}

const regexProblem = (p: string): string | undefined => {
  try { new RegExp(p, 'i'); return undefined; } catch (e) { return (e as Error).message; }
};

function check(path: string, value: unknown, spec: Spec, problems: string[]): void {
  switch (spec.t) {
    case 'string':
      if (value === null && spec.nullable) return;
      if (typeof value !== 'string') { problems.push(`${path} は文字列${spec.nullable ? 'か null' : ''}で書いてください（今は ${typeName(value)}）`); return; }
      if (spec.enum && !spec.enum.includes(value)) problems.push(`${path} は ${spec.enum.map((e) => `"${e}"`).join(' / ')} のどれかです（今は "${value}"）`);
      if (spec.url) {
        let u: URL | undefined;
        try { u = new URL(value); } catch { /* 下で報告 */ }
        if (!u || !/^https?:$/.test(u.protocol)) problems.push(`${path} は http(s):// で始まる URL で書いてください（今は "${value}"）`);
      }
      if (spec.regex) { const r = regexProblem(value); if (r) problems.push(`${path} の正規表現が読めません: ${r}`); }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) { problems.push(`${path} は数値で書いてください（今は ${typeName(value)}）`); return; }
      if (spec.int && !Number.isInteger(value)) problems.push(`${path} は整数で書いてください（今は ${value}）`);
      if (value < spec.min || (spec.max !== undefined && value > spec.max)) problems.push(`${path} は ${spec.min}〜${spec.max ?? '∞'} の範囲で書いてください（今は ${value}）`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${path} は true か false で書いてください（今は ${typeName(value)}）`);
      return;
    case 'strings':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) { problems.push(`${path} は文字列の配列で書いてください`); return; }
      for (const v of value as string[]) {
        if (spec.enum && !spec.enum.includes(v)) problems.push(`${path} に "${v}" は使えません（${spec.enum.join(' / ')}）`);
        if (spec.regex) { const r = regexProblem(v); if (r) problems.push(`${path} の正規表現 "${v}" が読めません: ${r}`); }
      }
      return;
    case 'record':
      if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.values(value).some((v) => typeof v !== 'string')) problems.push(`${path} は { "キー": "文字列" } の形で書いてください`);
      return;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) { problems.push(`${path} はオブジェクトで書いてください（今は ${typeName(value)}）`); return; }
      const known = Object.keys(spec.fields);
      for (const [k, v] of Object.entries(value)) {
        const sub = spec.fields[k];
        if (!sub) { problems.push(`${path}.${k} は知らない設定です${suggest(k, known)}`); continue; }
        check(`${path}.${k}`, v, sub, problems);
      }
      return;
    }
    case 'pathRules':
      if (!Array.isArray(value)) { problems.push(`${path} は [{ "pattern": "...", "replace": "..." }] の形で書いてください`); return; }
      value.forEach((r, i) => {
        const rule = r as { pattern?: unknown; replace?: unknown };
        if (typeof rule !== 'object' || rule === null || typeof rule.pattern !== 'string' || typeof rule.replace !== 'string') {
          problems.push(`${path}[${i}] は { "pattern": "...", "replace": "..." } の形で書いてください`);
          return;
        }
        const e = regexProblem(rule.pattern);
        if (e) problems.push(`${path}[${i}].pattern の正規表現が読めません: ${e}`);
      });
      return;
  }
}

/** 設定ファイルの中身（部分）を検証する。問題の一覧を返す */
export function validatePartialConfig(raw: unknown): string[] {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ['設定ファイルの一番外側は { ... } のオブジェクトで書いてください'];
  const known = Object.keys(SPEC);
  for (const [k, v] of Object.entries(raw)) {
    if (k === '$schema') continue;
    const spec = SPEC[k as keyof FlowmapConfig];
    if (!spec) { problems.push(`"${k}" は知らない設定です${suggest(k, known)}`); continue; }
    check(k, v, spec, problems);
  }
  return problems;
}

/** 組み立て終わった設定を検証する（CLI 引数の値の誤りもここで拾う） */
export function validateConfig(config: FlowmapConfig): string[] {
  const problems: string[] = [];
  for (const [k, spec] of Object.entries(SPEC)) check(k, config[k as keyof FlowmapConfig], spec, problems);
  return problems;
}

// ---------- 読み込み ----------

function readConfigFile(path: string): Partial<FlowmapConfig> {
  let raw: unknown;
  try {
    raw = parseJsonc(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError([`JSON として読めません: ${(e as Error).message}`], path);
  }
  const problems = validatePartialConfig(raw);
  if (problems.length) throw new ConfigError(problems, path);
  return raw as Partial<FlowmapConfig>;
}

const resolveFrom = (base: string, p: string | null | undefined): string | null => (p ? (isAbsolute(p) ? p : resolve(base, p)) : p ?? null);

/**
 * 設定を組み立てる。flowmap.config.json（あれば）→ 既定値にマージ → CLI 上書き。
 * 設定ファイル内のパス（outDir・storageState・baseline）は設定ファイルのあるディレクトリ基準、CLI 引数はカレント基準で解決する。
 */
export function loadConfig(configPath: string | undefined, overrides: ConfigOverrides = {}, cwd = process.cwd()): FlowmapConfig {
  const path = resolve(cwd, configPath ?? 'flowmap.config.json');
  let fromFile: Partial<FlowmapConfig> = {};
  let fileDir = cwd;
  if (existsSync(path)) {
    fromFile = readConfigFile(path);
    fileDir = dirname(path);
  } else if (configPath) {
    throw new ConfigError([`設定ファイルが見つかりません: ${path}`]);
  }
  const clean = Object.fromEntries(Object.entries(overrides).filter(([k, v]) => v !== undefined && k !== 'jev')) as Partial<FlowmapConfig>;
  const merged: FlowmapConfig = {
    ...DEFAULT_CONFIG,
    ...fromFile,
    ...clean,
    viewport: { ...DEFAULT_CONFIG.viewport, ...(fromFile.viewport ?? {}) },
    fill: { ...DEFAULT_CONFIG.fill, ...(fromFile.fill ?? {}) },
    jev: { ...DEFAULT_CONFIG.jev, ...(fromFile.jev ?? {}), ...(overrides.jev ? { enabled: true } : {}) },
  };
  // パスの解決。上書きされた値はカレント基準、設定ファイルの値はファイル基準、既定値はカレント基準
  const base = (key: 'outDir' | 'storageState' | 'baseline') => (clean[key] !== undefined ? cwd : fromFile[key] !== undefined ? fileDir : cwd);
  merged.outDir = resolveFrom(base('outDir'), merged.outDir) ?? resolve(cwd, DEFAULT_CONFIG.outDir);
  merged.storageState = resolveFrom(base('storageState'), merged.storageState);
  merged.baseline = resolveFrom(base('baseline'), merged.baseline);

  const problems = validateConfig(merged);
  if (problems.length) throw new ConfigError(problems, existsSync(path) ? path : undefined);
  return merged;
}

/** 起点のホストが許可ホストか。localhost・127.0.0.1・*.local・allowedHosts のどれか */
export function isAllowedHost(config: FlowmapConfig): boolean {
  const host = new URL(config.baseUrl).hostname;
  return config.allowedHosts.includes(host) || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local') || host.endsWith('.localhost');
}

/** graph.json に残す設定の抜粋。探索の範囲と画面の同定に効くものだけで、認証情報やファイルパスは含めない */
export function configSummary(config: FlowmapConfig): Record<string, unknown> {
  const pick = <K extends keyof FlowmapConfig>(...keys: K[]) => Object.fromEntries(keys.map((k) => [k, config[k]]));
  return {
    ...pick('maxStates', 'maxDepth', 'maxActionsPerState', 'maxActionsPerPattern', 'maxLocalActionRepeats', 'maxLinkRepeats',
      'workers', 'useBackNavigation', 'followExternalLinks', 'allowSubmit', 'queryParams', 'structuralParams', 'dataParams',
      'pathRules', 'autoPathRules', 'autoPathRulesMinSiblings', 'volatileSelectors', 'viewport', 'locale', 'timezoneId'),
    authenticated: !!config.storageState,
    jev: config.jev.enabled,
  };
}
