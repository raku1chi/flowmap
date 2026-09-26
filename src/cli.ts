import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig, type ConfigOverrides } from './types.js';
import { explore } from './explore.js';
import { render } from './render.js';

const USAGE = `flowmap — SPA を自動探索して画面遷移図を作る

使い方:
  flowmap explore [--url <起点URL>] [--out <dir>] [--storage <auth.json>]
                  [--max-states N] [--max-depth N] [--config <path>] [--no-render] [--yes] [--jev]
  flowmap render <実行ディレクトリ> [--config <path>]

explore は探索後に自動で index.html も生成する（--no-render で抑止）。
設定は flowmap.config.json（カレント）を読み、CLI 引数が優先される。
--jev は Jev（typesafe.ai）による判定を有効にする。画面の要約を外部 API に送るので、送ってよいアプリにだけ使う。
キーは環境変数 TYPESAFE_API_KEY か .env から読む。`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function str(v: string | boolean | undefined): string | undefined { return typeof v === 'string' ? v : undefined; }
function num(v: string | boolean | undefined): number | undefined { const s = str(v); return s === undefined ? undefined : Number(s); }

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);

  if (cmd === 'explore') {
    const overrides: ConfigOverrides = {
      baseUrl: str(flags.url),
      outDir: str(flags.out),
      storageState: str(flags.storage),
      maxStates: num(flags['max-states']),
      maxDepth: num(flags['max-depth']),
      jev: flags.jev === true ? true : undefined,
    };
    const config = loadConfig(str(flags.config), overrides);
    const host = new URL(config.baseUrl).hostname;
    const allowed = config.allowedHosts.includes(host) || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
    if (!allowed && !flags.yes) {
      console.error(`起点 ${config.baseUrl} は許可ホスト（${config.allowedHosts.join(', ')}, localhost, 127.0.0.1, *.local）の外です。\n探索は本物のクリックと送信を行います。壊してよい環境であることを確認のうえ --yes を付けて再実行するか、allowedHosts に追加してください。`);
      process.exit(2);
    }
    if (config.storageState && !existsSync(config.storageState)) {
      console.error(`storageState が見つかりません: ${config.storageState}`);
      process.exit(2);
    }
    const { runDir } = await explore({ config });
    if (!flags['no-render']) {
      const out = render(runDir, { screenNames: config.screenNames });
      console.log(`ビューア: ${out}`);
    }
    return;
  }

  if (cmd === 'render') {
    const dir = positional[0];
    if (!dir) { console.error('実行ディレクトリを指定してください'); process.exit(2); }
    // 表示だけに効く設定（screenNames）は、探索時ではなく今の設定ファイルから読む
    const { screenNames } = loadConfig(str(flags.config), {});
    const out = render(resolve(dir), { screenNames });
    console.log(`ビューア: ${out}`);
    return;
  }

  console.log(USAGE);
  process.exit(cmd ? 2 : 0);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
