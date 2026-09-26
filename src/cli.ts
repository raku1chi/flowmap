// CLI（DESIGN.md §3）。サブコマンドは explore と render の 2 つだけ。
// 終了コード: 0 成功 / 1 ゲート（--fail-on）に掛かった / 2 使い方・設定の誤り / 3 探索できなかった / 130 中断

import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { ConfigError, GATE_KINDS, isAllowedHost, loadConfig, type ConfigOverrides } from './config.js';
import { explore, ExploreError, TOOL_VERSION } from './explore.js';
import { render } from './render.js';
import { evaluateGate, writeSummary } from './report.js';
import type { GateKind } from './types.js';

const USAGE = `flowmap — SPA を自動探索して画面遷移図を作る（${TOOL_VERSION}）

使い方:
  flowmap explore [オプション]        探索して flowmap-out/runs/<日時>/ に graph.json・shots/・index.html を出す
  flowmap render <実行ディレクトリ>    graph.json からビューア（index.html）だけ作り直す

explore のオプション（設定ファイルの値より優先）:
  --url <URL>              起点 URL（baseUrl）
  --config <path>          設定ファイル（既定: ./flowmap.config.json）
  --out <dir>              出力先（outDir）
  --storage <auth.json>    ログイン済みの状態（Playwright の storageState）
  --max-states <N>         画面数の上限
  --max-depth <N>          クリックの深さの上限
  --workers <N>            並列に動かすブラウザの数（結果は並列数によらず同じ）
  --max-minutes <N>        時間の上限（分）。超えたらそこまでの結果を書き出す
  --baseline <dir>         比較対象の実行ディレクトリ（既定: 同じ outDir の直前の実行）
  --fail-on <条件,...>     条件に当たれば終了コード 1: ${GATE_KINDS.join(', ')}
  --jev                    Jev（typesafe.ai）による判定を有効にする（画面の要約を外部 API に送る）
  --headed                 ブラウザの画面を出して動かす（様子を見るとき）
  --quiet                  操作ごとのログを出さない
  --no-render              index.html を作らない
  --yes                    localhost 以外の起点でも確認せずに実行する

render のオプション:
  --config <path>          画面名の上書き（screenNames）を読む設定ファイル

その他: --help, --version
環境変数: FLOWMAP_CHROMIUM_PATH（使う Chromium の実行ファイル）, TYPESAFE_API_KEY（--jev のキー。.env でも可）`;

type FlagSpec = 'string' | 'number' | 'boolean';
const EXPLORE_FLAGS: Record<string, FlagSpec> = {
  url: 'string', config: 'string', out: 'string', storage: 'string', 'max-states': 'number', 'max-depth': 'number',
  workers: 'number', 'max-minutes': 'number', baseline: 'string', 'fail-on': 'string', jev: 'boolean', headed: 'boolean',
  quiet: 'boolean', 'no-render': 'boolean', yes: 'boolean', help: 'boolean',
};
const RENDER_FLAGS: Record<string, FlagSpec> = { config: 'string', help: 'boolean' };

class UsageError extends Error { override name = 'UsageError'; }

/** 引数を読む。知らないフラグ・値の無いフラグ・数値でない値は UsageError */
export function parseArgs(argv: string[], spec: Record<string, FlagSpec>): { flags: Record<string, string | number | boolean>; positional: string[] } {
  const flags: Record<string, string | number | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const key = a.slice(2, eq < 0 ? undefined : eq);
    const type = spec[key];
    if (!type) {
      const near = Object.keys(spec).find((k) => k.startsWith(key.slice(0, 4)) || key.startsWith(k.slice(0, 4)));
      throw new UsageError(`知らないオプションです: --${key}${near ? `（--${near} ？）` : ''}`);
    }
    if (type === 'boolean') {
      if (eq >= 0) throw new UsageError(`--${key} は値を取りません`);
      flags[key] = true;
      continue;
    }
    let value: string | undefined;
    if (eq >= 0) value = a.slice(eq + 1);
    else { value = argv[i + 1]; i++; }
    if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new UsageError(`--${key} に値を指定してください`);
    if (type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new UsageError(`--${key} は数値で指定してください（今は "${value}"）`);
      flags[key] = n;
    } else flags[key] = value;
  }
  return { flags, positional };
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

function parseFailOn(v: string | undefined): GateKind[] | undefined {
  if (v === undefined) return undefined;
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((k) => !GATE_KINDS.includes(k as GateKind));
  if (bad.length) throw new UsageError(`--fail-on に使えるのは ${GATE_KINDS.join(', ')} です（${bad.join(', ')} は使えません）`);
  return list as GateKind[];
}

async function runExplore(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv, EXPLORE_FLAGS);
  if (flags.help) { console.log(USAGE); return 0; }
  const overrides: ConfigOverrides = {
    baseUrl: str(flags.url),
    outDir: str(flags.out),
    storageState: str(flags.storage),
    maxStates: num(flags['max-states']),
    maxDepth: num(flags['max-depth']),
    workers: num(flags.workers),
    maxDurationMinutes: num(flags['max-minutes']),
    baseline: str(flags.baseline),
    failOn: parseFailOn(str(flags['fail-on'])),
    headless: flags.headed ? false : undefined,
    jev: flags.jev === true ? true : undefined,
  };
  const config = loadConfig(str(flags.config), overrides);
  if (!isAllowedHost(config) && !flags.yes) {
    console.error(`起点 ${config.baseUrl} は許可ホスト（${[...config.allowedHosts, '*.local'].join(', ')}）の外です。\n探索は本物のクリックと送信を行います。壊してよい環境であることを確かめたうえで --yes を付けて再実行するか、allowedHosts に追加してください。`);
    return 2;
  }
  if (config.storageState && !existsSync(config.storageState)) {
    console.error(`storageState が見つかりません: ${config.storageState}`);
    return 2;
  }

  // 1 回目の Ctrl-C はそこまでの結果を書き出して止める。2 回目は即座に終わる
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts === 1) { console.error('\n中断しています。そこまでの結果を書き出します（もう一度 Ctrl-C で即座に終了）'); controller.abort(); }
    else process.exit(130);
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);
  let result;
  try {
    result = await explore({ config, signal: controller.signal, quiet: !!flags.quiet });
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigint);
  }
  const { runDir, graph } = result;
  let indexPath = relative(process.cwd(), resolve(runDir, 'index.html')) || 'index.html';
  if (!flags['no-render']) {
    const out = render(runDir, { screenNames: config.screenNames });
    indexPath = relative(process.cwd(), out) || out;
    console.log(`ビューア: ${out}`);
  }
  const gate = evaluateGate(graph, config.failOn);
  writeSummary(runDir, graph, gate, indexPath);
  if (config.failOn.length) console.log(gate.failed ? `ゲート: 失敗（${gate.reasons.join('、')}）` : 'ゲート: 通過');
  for (const n of gate.notes) console.log(`ゲート: ${n}`);
  if (controller.signal.aborted) return 130;
  return gate.failed ? 1 : 0;
}

function runRender(argv: string[]): number {
  const { flags, positional } = parseArgs(argv, RENDER_FLAGS);
  if (flags.help) { console.log(USAGE); return 0; }
  const dir = positional[0];
  if (!dir) throw new UsageError('実行ディレクトリを指定してください（例: flowmap render flowmap-out/runs/2026-09-26T07-01-57-385Z）');
  // 表示だけに効く設定（screenNames）は、探索時ではなく今の設定ファイルから読む。読めなくても描画は続ける
  let screenNames: Record<string, string> = {};
  try {
    screenNames = loadConfig(str(flags.config), {}).screenNames;
  } catch (e) {
    if (str(flags.config)) throw e;
    console.error(`注意: 設定ファイルを読めないので画面名の上書きは使いません（${(e as Error).message.split('\n')[0]}）`);
  }
  const out = render(resolve(dir), { screenNames });
  console.log(`ビューア: ${out}`);
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '--version' || cmd === '-v') { console.log(TOOL_VERSION); return 0; }
  if (cmd === 'explore') return runExplore(rest);
  if (cmd === 'render') return runRender(rest);
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(USAGE); return 0; }
  console.error(`知らないコマンドです: ${cmd}\n\n${USAGE}`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof ConfigError || e instanceof UsageError) { console.error(e.message); process.exit(2); }
    if (e instanceof ExploreError) { console.error(e.message); process.exit(3); }
    console.error(e instanceof Error ? e.stack ?? e.message : e);
    process.exit(3);
  },
);
