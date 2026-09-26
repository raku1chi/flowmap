// flowmap-out/jev/dataset.json の各ケースを Jev に問い合わせ、正解と現行の機械的ルールに並べて比べる。
//
//   pnpm exec tsx experiments/jev/ask.ts                # 全ケース
//   pnpm exec tsx experiments/jev/ask.ts --only pages   # links / pages / actions のどれか 1 種類
//   pnpm exec tsx experiments/jev/ask.ts --dry-run      # 送らずに最初のリクエストを表示する
//
// API キーは環境変数 TYPESAFE_API_KEY か、リポジトリ直下の .env から読む（.env.example 参照）。
// 結果は flowmap-out/jev/results-<日時>.json と report-<日時>.md に書き出す。キーはどこにも書き出さない。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Dataset, DatasetCase, Experiment } from './cases.js';
import { apiKey, callJev, mergeScore, MODEL, PAGE_SPLIT, pool, QUESTIONS } from './jev.js';

const OUT_DIR = resolve('flowmap-out/jev');

// ---------- 引数 ----------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const only = opt('only') as Experiment | undefined;
const threshold = Number(opt('threshold') ?? 0.5);
const concurrency = Number(opt('concurrency') ?? 4);

// ---------- 評価 ----------

interface Row {
  id: string;
  experiment: Experiment;
  truth: boolean;
  baseline: boolean;
  lang: 'ja' | 'en';
  source: DatasetCase['source'];
  note: string;
  ja: number;
  en: number;
  /** pages のみ: 2 つに分けた問いの値と、それをまとめた合流の度合い */
  sameKind?: number;
  uiState?: number;
  merge?: number;
  inputTokens: number;
  ms: number;
}

/** 正例の値が負例の値を上回る組の割合。閾値によらず「分けられているか」を見る */
function auc(rows: Row[], score: (r: Row) => number): number {
  const pos = rows.filter((r) => r.truth).map(score);
  const neg = rows.filter((r) => !r.truth).map(score);
  if (!pos.length || !neg.length) return NaN;
  let s = 0;
  for (const p of pos) for (const q of neg) s += p > q ? 1 : p === q ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

interface Judge { name: string; judge: (r: Row) => boolean; score?: (r: Row) => number }

function tally(rows: Row[], j: Judge) {
  let correct = 0, falseNeg = 0, falsePos = 0;
  for (const r of rows) {
    const got = j.judge(r);
    if (got === r.truth) correct++;
    else if (r.truth) falseNeg++;
    else falsePos++;
  }
  return { correct, falseNeg, falsePos, auc: j.score ? auc(rows, j.score) : NaN };
}

const TITLES: Record<Experiment, { title: string; falsePos: string; falseNeg: string }> = {
  links: { title: '兄弟リンク群は「同じ画面を別データについて開く」ものか', falsePos: '誤って合流（画面を見落とす）', falseNeg: '合流し損ね（無駄に辿る）' },
  pages: { title: '2 つの画面は同じ画面か（データは違ってもよい）', falsePos: '誤って合流（画面を見落とす）', falseNeg: '合流し損ね（重複が残る）' },
  actions: { title: '操作はサーバーのデータを変えるか', falsePos: '安全な操作を除外（網羅が減る）', falseNeg: '危険な操作を見逃す（押してしまう）' },
};

const BASELINE_NAME: Record<Experiment, string> = {
  links: '現行ルール（兄弟リンク 3 本以上で学習）',
  pages: '現行ルール（シグネチャ一致）',
  actions: '現行ルール（denyText の部分一致）',
};

function report(rows: Row[]): string {
  const lines: string[] = [];
  const fmt = (x: number) => x.toFixed(2);
  const mark = (got: boolean, truth: boolean) => (got === truth ? '' : ' ✗');
  for (const exp of ['links', 'pages', 'actions'] as Experiment[]) {
    const rs = rows.filter((r) => r.experiment === exp);
    if (!rs.length) continue;
    const t = TITLES[exp];
    const pos = rs.filter((r) => r.truth).length;
    lines.push(`## ${exp}: ${t.title}（${rs.length} 件、正解 true ${pos} / false ${rs.length - pos}）`, '');
    const judges: Judge[] = [
      { name: BASELINE_NAME[exp], judge: (r) => r.baseline },
      { name: 'Jev（日本語の問い）', judge: (r) => r.ja > threshold, score: (r) => r.ja },
      { name: 'Jev（英語の問い）', judge: (r) => r.en > threshold, score: (r) => r.en },
    ];
    // 探索（src/jev.ts と既定の閾値）で実際に使う判定規則
    if (exp === 'links') judges.push({ name: '**探索での判定**（日英とも 0.7 以上なら学習）', judge: (r) => Math.min(r.ja, r.en) >= 0.7, score: (r) => Math.min(r.ja, r.en) });
    if (exp === 'pages') {
      judges.push({ name: 'Jev（2 つの問い＋差分なしはコードで判定、0.5）', judge: (r) => (r.merge ?? 0) > threshold, score: (r) => r.merge ?? 0 });
      judges.push({ name: '**探索での判定**（合流の度合い 0.7 以上なら合流）', judge: (r) => (r.merge ?? 0) >= 0.7, score: (r) => r.merge ?? 0 });
    }
    if (exp === 'actions') {
      judges.push({ name: '**探索での判定**（日英どちらかが 0.5 以上なら押さない）', judge: (r) => Math.max(r.ja, r.en) >= 0.5, score: (r) => Math.max(r.ja, r.en) });
      judges.push({ name: '現行ルール ∪ 探索での判定（実際の動き）', judge: (r) => r.baseline || Math.max(r.ja, r.en) >= 0.5 });
    }
    const groups: [string, Row[]][] = exp === 'actions'
      ? [['日本語のラベル', rs.filter((r) => r.lang === 'ja')], ['英語のラベル', rs.filter((r) => r.lang === 'en')]]
      : [['全ケース', rs]];
    for (const [gname, grs] of groups) {
      if (groups.length > 1) lines.push(`### ${gname}（${grs.length} 件）`, '');
      lines.push(`| 判定 | 正解 | ${t.falsePos} | ${t.falseNeg} | AUC |`, '| --- | --- | --- | --- | --- |');
      for (const j of judges) {
        const s = tally(grs, j);
        lines.push(`| ${j.name} | ${s.correct}/${grs.length} | ${s.falsePos} | ${s.falseNeg} | ${Number.isNaN(s.auc) ? '—' : fmt(s.auc)} |`);
      }
      lines.push('');
    }
    const split = exp === 'pages';
    lines.push('<details><summary>ケース別</summary>', '',
      `| ケース | 正解 | 現行 | Jev ja | Jev en |${split ? ' 種類が同じ | UI 操作の違い | 合流の度合い |' : ''} 説明 |`,
      `| --- | --- | --- | --- | --- |${split ? ' --- | --- | --- |' : ''} --- |`);
    for (const r of rs) {
      const extra = split ? ` ${fmt(r.sameKind ?? 0)} | ${fmt(r.uiState ?? 0)} | ${fmt(r.merge ?? 0)}${mark((r.merge ?? 0) > threshold, r.truth)} |` : '';
      lines.push(`| ${r.id.split('/')[1]} | ${r.truth ? 'T' : 'F'} | ${r.baseline ? 'T' : 'F'}${mark(r.baseline, r.truth)} | ${fmt(r.ja)}${mark(r.ja > threshold, r.truth)} | ${fmt(r.en)}${mark(r.en > threshold, r.truth)} |${extra} ${r.note} |`);
    }
    lines.push('', '</details>', '');
  }
  const tokens = rows.reduce((s, r) => s + r.inputTokens, 0);
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  lines.push(`閾値 ${threshold}。${rows.length} リクエスト、入力 ${tokens} トークン、応答時間の中央値 ${ms[Math.floor(ms.length / 2)]} ms。`);
  return lines.join('\n');
}

// ---------- 本体 ----------

const datasetPath = join(OUT_DIR, 'dataset.json');
if (!existsSync(datasetPath)) {
  console.error(`${datasetPath} がありません。先に pnpm exec tsx experiments/jev/capture.ts を実行してください。`);
  process.exit(2);
}
const dataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as Dataset;
const cases = dataset.cases.filter((c) => !only || c.experiment === only);
const bodyOf = (c: DatasetCase) => ({
  model: MODEL,
  state: c.state,
  // pages は 1 つの問い（日英）に加えて、2 つに分けた問いも同じリクエストで聞く（問いは並列に評価される）
  questions: c.experiment === 'pages' ? { ...QUESTIONS.pages, ...PAGE_SPLIT } : QUESTIONS[c.experiment],
});

if (flag('dry-run')) {
  console.log(JSON.stringify(bodyOf(cases[0]), null, 2));
  console.log(`\n${cases.length} 件を送る予定です（送信していません）。`);
  process.exit(0);
}

const key = apiKey();
if (!key) {
  console.error('TYPESAFE_API_KEY がありません。.env.example を .env にコピーしてキーを入れてください。');
  process.exit(2);
}

let done = 0;
const rows = await pool(cases, concurrency, async (c): Promise<Row> => {
  const r = await callJev(key, bodyOf(c));
  done++;
  if (done % 10 === 0 || done === cases.length) process.stderr.write(`  ${done}/${cases.length}\n`);
  return {
    id: c.id, experiment: c.experiment, truth: c.truth, baseline: c.baseline, lang: c.lang, source: c.source, note: c.note,
    ja: r.answers.ja.noul, en: r.answers.en.noul, inputTokens: r.usage.input_tokens, ms: r.ms,
    ...(c.experiment === 'pages' ? {
      sameKind: r.answers.same_kind.noul,
      uiState: r.answers.ui_state.noul,
      merge: mergeScore(c.state, r.answers.same_kind.noul, r.answers.ui_state.noul),
    } : {}),
  };
});

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const text = report(rows);
writeFileSync(join(OUT_DIR, `results-${stamp}.json`), JSON.stringify({ model: MODEL, threshold, questions: { ...QUESTIONS, pagesSplit: PAGE_SPLIT }, rows }, null, 2));
writeFileSync(join(OUT_DIR, `report-${stamp}.md`), text + '\n');
console.log(text);
console.log(`\n書き出し: ${join(OUT_DIR, `report-${stamp}.md`)}`);
