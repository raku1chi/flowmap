#!/usr/bin/env node
// src/cli.ts を tsx 経由で実行する薄いラッパー。どのディレクトリから呼んでも動くよう tsx は絶対 URL で解決する
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../src/cli.ts');
const tsx = import.meta.resolve('tsx');
const r = spawnSync(process.execPath, ['--import', tsx, cli, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
