import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Graph } from './types.js';

/** 表示だけに効く設定。graph.json には入れず、レンダラに渡す（探索をやり直さずに変えられるように） */
export interface ViewOptions {
  /** 画面名の上書き。キーはルート（`/company/*` や `/search?q`） */
  screenNames?: Record<string, string>;
}

/** 実行ディレクトリの graph.json から単体で開ける index.html を生成する */
export function render(runDir: string, view: ViewOptions = {}): string {
  const graphPath = join(runDir, 'graph.json');
  if (!existsSync(graphPath)) throw new Error(`graph.json が見つかりません: ${graphPath}`);
  const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as Graph;
  const html = buildHtml(graph, basename(runDir), view);
  const out = join(runDir, 'index.html');
  writeFileSync(out, html);
  return out;
}

export function buildHtml(graph: Graph, runName: string, view: ViewOptions = {}): string {
  // </script> や <!-- がタイトル等に含まれても壊れないよう < をエスケープして埋め込む。表示用の設定は __view に添える
  const data = JSON.stringify({ ...graph, __view: { screenNames: view.screenNames ?? {} } }).replace(/</g, '\\u003c').replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028').replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
  const host = (() => { try { return new URL(graph.meta.baseUrl).host; } catch { return graph.meta.baseUrl; } })();
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>flowmap ${escapeHtml(host)} ${escapeHtml(runName)}</title>
<style>
${CSS}
</style>
</head>
<body>
<header id="hdr">
  <div class="row1">
    <div class="brand">flowmap</div>
    <div class="host" id="hdr-host"></div>
    <div class="stats" id="hdr-stats"></div>
    <div class="filters" role="group" aria-label="絞り込み">
      <button data-filter="all" class="on">すべて</button>
      <button data-filter="added">新規</button>
      <button data-filter="changed">変化</button>
      <button data-filter="error">エラー</button>
    </div>
  </div>
  <div class="row2">
    <div class="views" role="group" aria-label="表示">
      <button id="home-btn" class="vbtn" data-view="home">グループ図</button>
      <button id="map-btn" class="vbtn" data-view="map">全画面の木</button>
      <button id="issues-btn" class="vbtn" data-view="issues">問題一覧</button>
    </div>
    <nav id="crumb" class="crumb" aria-label="現在地"></nav>
    <input id="search" type="search" placeholder="画面名・URL・見出しで検索" aria-label="検索" />
    <span id="search-count" class="muted"></span>
    <label class="toggle" id="nav-toggle-wrap"><input type="checkbox" id="nav-toggle" /> <span id="nav-toggle-label">共通ナビの辺を表示</span></label>
    <button id="compact-toggle" class="tbtn" aria-pressed="false">サムネイルを表示</button>
    <div class="zoom" id="zoom" role="group" aria-label="表示倍率">
      <button id="zoom-out" title="縮小">−</button>
      <span id="zoom-val">100%</span>
      <button id="zoom-in" title="拡大">＋</button>
      <button id="zoom-fit" title="全体を表示">全体</button>
    </div>
    <button id="help-btn" class="tbtn" aria-haspopup="dialog">？ 使い方</button>
    <div class="legend" id="legend">
      <span><i class="l-tree"></i>初めて到達した経路</span>
      <span><i class="l-fwd"></i>他の進む操作</span>
      <span><i class="l-back"></i>戻る</span>
      <span><i class="l-err"></i>失敗</span>
      <span><i class="l-nav"></i>共通ナビ</span>
    </div>
  </div>
</header>
<div id="body">
  <div id="main">
    <div id="canvas-wrap" tabindex="-1">
      <div id="sizer">
        <div id="canvas">
          <div id="groups"></div>
          <svg id="edges" xmlns="http://www.w3.org/2000/svg"></svg>
          <div id="nodes"></div>
        </div>
      </div>
    </div>
    <div id="strip-wrap" hidden><div id="strip"></div></div>
    <div id="issues-wrap" hidden><div id="issues"></div></div>
  </div>
  <aside id="panel"></aside>
</div>
<div id="lightbox" hidden><img alt="" /></div>
<div id="help" hidden role="dialog" aria-label="使い方"><div class="help-box">
  <h2>flowmap の見方</h2>
  <ol>
    <li><b>グループ図（最初の画面）</b> — 起点から直接行ける画面ごとに「グループ」としてまとめ、グループどうしの関係だけを描いています。カードを押すと、そのグループの中の画面が木として開きます。</li>
    <li><b>操作フロー</b> — 右パネルの一覧から選ぶと、起点からその画面までの操作をコマ割りで辿れます。← → キーでコマを進めます。</li>
    <li><b>戻る</b> — 上のパンくず（グループ図 › グループ › フロー）を押すか、Esc で 1 段階戻ります。</li>
  </ol>
  <p class="muted">全画面を 1 枚にした木は「全画面の木」ボタンから開けます（索引用）。ヘッダのリンクのようにどこからでも行ける操作は「共通ナビ」として図から外し、右パネルに一覧しています。</p>
  <button id="help-close" class="tbtn">閉じる</button>
</div></div>
<script id="graph-data" type="application/json">${data}</script>
<script>
${JS}
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const CSS = String.raw`
:root {
  --bg: #0f172a; --bg2: #13203a; --bg3: #1a2a4a; --line: #263654; --fg: #e5eaf3; --muted: #94a3b8;
  --amber: #f59e0b; --green: #22c55e; --red: #ef4444; --blue: #3b82f6; --cyan: #38bdf8;
  --edge: #94a3b8; --edge-weak: #475569;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--fg); font: 13px/1.5 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; display: flex; flex-direction: column; }
button, input { font: inherit; }
.muted { color: var(--muted); }
#hdr { border-bottom: 1px solid var(--line); background: var(--bg2); }
#hdr .row1 { display: flex; align-items: center; gap: 16px; padding: 8px 16px; flex-wrap: wrap; }
#hdr .row2 { display: flex; align-items: center; gap: 14px; padding: 6px 16px; border-top: 1px solid var(--line); flex-wrap: wrap; color: var(--muted); font-size: 12px; min-height: 36px; }
#hdr .brand { font-weight: 700; letter-spacing: .04em; }
#hdr .host { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
#hdr .stats { display: flex; gap: 12px; flex: 1; flex-wrap: wrap; }
#hdr .stats span b { color: var(--fg); }
#hdr .stats .d-added b { color: var(--amber); } #hdr .stats .d-changed b { color: var(--green); } #hdr .stats .d-err b, #hdr .stats .d-removed b { color: var(--red); }
.filters { display: flex; gap: 4px; }
.filters button, .zoom button, .tbtn { background: transparent; color: var(--muted); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.filters button.on, .tbtn[aria-pressed="true"] { color: var(--fg); border-color: var(--blue); background: rgba(59,130,246,.15); }
.tbtn { padding: 2px 10px; }
.views { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.vbtn { background: transparent; color: var(--muted); border: none; padding: 4px 12px; cursor: pointer; font-size: 13px; }
.vbtn + .vbtn { border-left: 1px solid var(--line); }
.vbtn[aria-pressed="true"] { color: var(--fg); background: rgba(59,130,246,.18); }
.vbtn:hover { color: var(--fg); }
.crumb { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.crumb button { background: none; border: none; color: var(--fg); padding: 2px 6px; border-radius: 4px; cursor: pointer; }
.crumb button:hover { background: rgba(148,163,184,.12); }
.crumb button[aria-current="page"] { color: var(--cyan); font-weight: 600; cursor: default; }
.crumb .sep { color: var(--muted); }
#search { background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; width: 210px; }
#search:focus { outline: none; border-color: var(--blue); }
.zoom { display: flex; align-items: center; gap: 4px; }
.zoom button { padding: 2px 8px; }
.zoom #zoom-val { min-width: 42px; text-align: center; font-variant-numeric: tabular-nums; }
.toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
.toggle input { accent-color: var(--blue); }
.legend { display: flex; gap: 12px; margin-left: auto; }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend i { display: inline-block; width: 20px; height: 0; border-top: 2px solid var(--edge); }
.legend .l-tree { border-top-width: 2.5px; }
.legend .l-fwd { border-top-width: 1px; border-color: var(--edge-weak); }
.legend .l-back { border-top-style: dashed; border-color: var(--edge-weak); }
.legend .l-err { border-top-style: dashed; border-color: var(--red); }
.legend .l-nav { border-top-style: dotted; border-color: var(--edge-weak); }
[hidden] { display: none !important; }
#body { flex: 1; display: flex; min-height: 0; }
#main { flex: 1; display: flex; min-width: 0; }
#canvas-wrap { flex: 1; overflow: auto; position: relative; background-color: var(--bg); background-image: radial-gradient(rgba(148,163,184,.18) 1px, transparent 1px); background-size: 22px 22px; }
#sizer { position: relative; }
#canvas { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
#groups { position: absolute; inset: 0; pointer-events: none; }
.group { position: absolute; border: 1px dashed rgba(148,163,184,.35); border-radius: 12px; background: rgba(148,163,184,.04); }
.group .glabel { position: absolute; top: -9px; right: 12px; background: var(--bg); padding: 0 6px; font-size: 11px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
#edges { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
#edges path.edge { fill: none; stroke: var(--edge-weak); stroke-width: 1.2; stroke-linejoin: round; stroke-linecap: round; transition: stroke .15s, opacity .15s; }
#edges path.tree { stroke: var(--edge); stroke-width: 2.2; }
#edges path.back { stroke-dasharray: 5 4; }
#edges path.nav { stroke-dasharray: 2 4; }
#edges path.err { stroke: var(--red); stroke-dasharray: 3 3; stroke-width: 1.6; }
#edges path.hi { stroke: var(--blue); stroke-width: 2.6; }
#edges path.path { stroke: var(--cyan); stroke-width: 3; }
#edges .hidden { display: none; }
#edges .lbl { font-size: 11px; fill: #cbd5e1; }
#edges .lbl-bg { fill: var(--bg); stroke: var(--line); }
#edges .lbl.err { fill: #fca5a5; }
#edges .lbl.hi { fill: #dbeafe; }
#edges .lbl-bg.hi { stroke: var(--blue); }
#edges .lbl.path { fill: #e0f2fe; }
#edges .lbl-bg.path { stroke: var(--cyan); }
#edges .ondemand:not(.hi):not(.path) { display: none; }
#edges .faded { opacity: .18; }
.item { position: absolute; background: var(--bg2); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; transition: box-shadow .15s, border-color .15s, opacity .15s; }
.item:hover, .item.hov { border-color: #4b6aa8; }
.item.onpath { border-color: rgba(56,189,248,.7); }
.item:focus-visible, .item.sel { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px rgba(59,130,246,.35); }
.item.dim { opacity: .15; }
.item.off { opacity: .12; }
.item .thumb { flex: 1; min-height: 0; background: #fff; border-radius: 4px; overflow: hidden; display: flex; align-items: flex-start; margin-bottom: 3px; }
.item .thumb img { width: 100%; height: 100%; object-fit: contain; object-position: top; display: block; }
.item .title { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3; }
.item .sub { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3; }
.item .sub b { color: #cbd5e1; font-weight: 600; }
.item .sub code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.item .errline { color: #fca5a5; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3; }
.item.chapter { padding: 8px 10px; }
.item.chapter .title { font-size: 15px; }
.item.chapter .meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.item.chapter .thumb { margin-bottom: 6px; }
.badges { position: absolute; top: -9px; left: 8px; display: flex; gap: 4px; }
.badge { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 999px; color: #0b1020; background: #cbd5e1; white-space: nowrap; }
.badge.root { background: var(--blue); color: #fff; } .badge.added { background: var(--amber); } .badge.changed { background: var(--green); } .badge.err { background: var(--red); color: #fff; } .badge.trunc { background: #475569; color: #fff; }
.col-head { position: absolute; top: 12px; color: var(--muted); font-size: 11px; letter-spacing: .06em; }
.stubs { position: absolute; display: flex; gap: 4px; flex-wrap: wrap; }
.stub { font-size: 11px; color: var(--muted); border: 1px dashed var(--line); border-radius: 999px; padding: 0 8px; background: var(--bg); cursor: pointer; white-space: nowrap; }
.stub:hover { color: var(--fg); border-color: var(--blue); }
#issues-wrap { flex: 1; overflow: auto; background: var(--bg); padding: 20px 28px; }
#issues h2 { margin: 0 0 4px; font-size: 18px; }
#issues .lead { color: var(--muted); margin: 0 0 14px; }
#issues .ifilters { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; align-items: center; }
#issues .ifilters button { background: transparent; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 3px 12px; cursor: pointer; }
#issues .ifilters button.on { color: var(--fg); border-color: var(--blue); background: rgba(59,130,246,.15); }
#issues .ifilters label { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); margin-left: 8px; cursor: pointer; }
#issues .screen { background: var(--bg2); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 12px; overflow: hidden; }
#issues .screen.hidden { display: none; }
#issues .shead { display: grid; grid-template-columns: 120px 1fr auto; gap: 14px; align-items: center; padding: 10px 14px; cursor: pointer; }
#issues .shead:hover { background: rgba(148,163,184,.06); }
#issues .shead img { width: 120px; aspect-ratio: 16/10; object-fit: cover; object-position: top; border-radius: 4px; background: #fff; display: block; }
#issues .shead .name { font-weight: 600; font-size: 14px; }
#issues .shead .where { color: var(--muted); font-size: 12px; }
#issues .shead .cnt { display: flex; gap: 6px; align-items: center; }
#issues .shead .open { background: transparent; color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
#issues .shead .open:hover { border-color: var(--blue); }
#issues .rows { border-top: 1px solid var(--line); }
#issues .row { display: grid; grid-template-columns: 110px 1fr 60px; gap: 12px; padding: 7px 14px; border-bottom: 1px solid rgba(38,54,84,.6); font-size: 13px; align-items: baseline; }
#issues .row:last-child { border-bottom: none; }
#issues .row.hidden { display: none; }
#issues .row .kind { font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 999px; text-align: center; white-space: nowrap; }
#issues .k-console { background: rgba(239,68,68,.2); color: #fca5a5; } #issues .k-request { background: rgba(239,68,68,.12); color: #fca5a5; } #issues .k-action { background: rgba(245,158,11,.18); color: #fcd34d; } #issues .k-diff { background: rgba(34,197,94,.15); color: #86efac; } #issues .k-removed { background: rgba(239,68,68,.2); color: #fca5a5; } #issues .k-trunc { background: rgba(148,163,184,.15); color: #cbd5e1; }
#issues .row .msg { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; color: #e2e8f0; }
#issues .row .msg.plain { font-family: inherit; font-size: 13px; }
#issues .row .new { color: var(--amber); font-size: 11px; font-weight: 700; }
#issues .row .old { color: var(--muted); font-size: 11px; }
#issues .empty { color: var(--muted); padding: 30px 0; text-align: center; }
#strip-wrap { flex: 1; overflow: auto; background-color: var(--bg); background-image: radial-gradient(rgba(148,163,184,.18) 1px, transparent 1px); background-size: 22px 22px; }
#strip { display: flex; align-items: flex-start; gap: 0; padding: 48px 40px; min-height: 100%; }
.fcard { width: 520px; flex: none; background: var(--bg2); border: 1px solid var(--line); border-radius: 10px; padding: 10px; cursor: pointer; position: relative; transition: border-color .15s, box-shadow .15s; }
.fcard:hover { border-color: #4b6aa8; }
.fcard.cur { border-color: var(--cyan); box-shadow: 0 0 0 3px rgba(56,189,248,.3); }
.fcard .fnum { position: absolute; top: -12px; left: 12px; background: var(--cyan); color: #06202e; font-weight: 700; font-size: 11px; padding: 1px 8px; border-radius: 999px; }
.fcard img { width: 100%; aspect-ratio: 16/10; object-fit: cover; object-position: top; background: #fff; border-radius: 6px; display: block; }
.fcard .fname { font-weight: 600; font-size: 15px; margin-top: 8px; }
.fcard .fsub { color: var(--muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.fcard .errline { color: #fca5a5; font-size: 11px; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.farrow { flex: none; width: 170px; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; align-self: flex-start; padding-top: 150px; color: var(--muted); font-size: 13px; text-align: center; gap: 4px; }
.farrow .line { width: 100%; height: 0; border-top: 2px solid var(--edge); position: relative; }
.farrow .line::after { content: ''; position: absolute; right: -2px; top: -5px; border: 5px solid transparent; border-left: 8px solid var(--edge); }
.farrow .act { padding: 0 6px; color: #cbd5e1; }
#panel { width: 460px; border-left: 1px solid var(--line); background: var(--bg2); overflow: auto; padding: 14px 16px; }
#panel h2 { font-size: 15px; margin: 0 0 6px; }
#panel h3 { font-size: 12px; color: var(--muted); margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .06em; }
#panel .url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--muted); word-break: break-all; }
#panel details.merged { margin-top: 4px; font-size: 11px; color: var(--muted); }
#panel details.merged summary { cursor: pointer; }
#panel details.merged ul { margin: 4px 0 0; padding-left: 16px; max-height: 160px; overflow: auto; }
#panel details.merged code { word-break: break-all; }
#panel .shot { width: 100%; border-radius: 6px; background: #fff; cursor: zoom-in; display: block; }
#panel .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
#panel .pair .cap { font-size: 11px; color: var(--muted); margin-bottom: 3px; }
#panel ul { list-style: none; margin: 0; padding: 0; }
#panel li { padding: 5px 0; border-bottom: 1px solid var(--line); }
#panel li button, #panel .linkbtn { background: none; border: none; color: var(--fg); padding: 0; cursor: pointer; text-align: left; font: inherit; }
#panel li button:hover, #panel li button:focus-visible, #panel .linkbtn:hover { color: #bfdbfe; text-decoration: underline; }
#panel li .to { color: var(--muted); }
#panel li .cnt { color: var(--muted); font-size: 11px; margin-left: 4px; }
#panel li.err { color: #fca5a5; }
#panel .pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; white-space: pre-wrap; word-break: break-all; color: #fca5a5; }
#panel .kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; }
#panel .kv dt { color: var(--muted); } #panel .kv dd { margin: 0; }
#panel details { margin-top: 6px; }
#panel details summary { cursor: pointer; color: var(--muted); font-size: 12px; }
#panel .removed img { width: 100%; border-radius: 4px; margin-top: 4px; }
#panel .empty { color: var(--muted); }
#panel .chips { display: flex; flex-wrap: wrap; gap: 6px; }
#panel .chip { border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; font-size: 12px; background: transparent; color: var(--fg); cursor: pointer; }
#panel .chip:hover { border-color: var(--blue); }
#panel .chip.added { border-color: var(--amber); } #panel .chip.changed { border-color: var(--green); } #panel .chip.err { border-color: var(--red); }
#panel .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font-size: 12px; }
#panel .crumbs .step { color: var(--cyan); }
#panel .crumbs .arrow { color: var(--muted); }
#panel .crumbs button { background: none; border: 1px solid var(--line); border-radius: 6px; color: var(--fg); padding: 1px 8px; cursor: pointer; }
#panel .crumbs button:hover { border-color: var(--cyan); }
#panel .flows li { display: flex; flex-direction: column; gap: 2px; }
#panel .flows li button.flow { font-weight: 600; }
#panel .flows .meta { font-size: 11px; color: var(--muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
#panel .flows details { margin: 0; }
#panel .flows details summary { padding: 6px 0; color: var(--fg); font-size: 13px; }
#panel .flows details ul { padding-left: 12px; border-left: 1px solid var(--line); margin: 2px 0 6px; }
#panel .navbtns { display: flex; gap: 6px; align-items: center; margin: 8px 0; }
#panel .navbtns button { background: transparent; color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 12px; cursor: pointer; }
#panel .navbtns button:disabled { opacity: .35; cursor: default; }
#panel .hint { color: var(--muted); font-size: 12px; }
#panel .usage { border: 1px solid rgba(56,189,248,.4); border-radius: 8px; padding: 10px 12px 6px; margin: 12px 0 4px; font-size: 12px; background: rgba(56,189,248,.06); }
#panel .usage b { color: var(--cyan); }
#panel .usage ol { margin: 4px 0 4px; padding-left: 18px; }
#panel .usage li { margin-bottom: 3px; }
#help { position: fixed; inset: 0; background: rgba(2,6,23,.75); display: grid; place-items: center; z-index: 20; }
#help[hidden] { display: none; }
.help-box { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 22px 26px; width: min(640px, 92vw); font-size: 14px; line-height: 1.7; }
.help-box h2 { margin: 0 0 10px; font-size: 17px; }
.help-box ol { margin: 0 0 10px; padding-left: 22px; }
.help-box li { margin-bottom: 6px; }
.help-box li b { color: var(--cyan); }
.help-box .tbtn { margin-top: 6px; color: var(--fg); }
#lightbox { position: fixed; inset: 0; background: rgba(2,6,23,.9); display: grid; place-items: center; cursor: zoom-out; z-index: 10; }
#lightbox[hidden] { display: none; }
#lightbox img { max-width: 96vw; max-height: 96vh; background: #fff; border-radius: 6px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; scroll-behavior: auto !important; } }
@media (max-width: 900px) { #body { flex-direction: column; } #panel { width: auto; border-left: none; border-top: 1px solid var(--line); max-height: 45vh; } .legend { margin-left: 0; } }
`;

const JS = String.raw`
const G = JSON.parse(document.getElementById('graph-data').textContent);
const NODE_W = 300, COL_GAP = 170, PAD_X = 40, PAD_Y = 56, TRUNK = 24, CH_W = 340, CH_H = 296;
const byId = new Map(G.nodes.map(n => [n.id, n]));
const diff = G.diff || { added: [], removed: [], changed: [], newErrors: [] };
const prevOf = id => (diff.previous || {})[id];
const isAdded = id => !!G.diff && diff.added.includes(id);
const isChanged = id => diff.changed.includes(id);
const errCount = n => n.consoleErrors.length + n.failedRequests.length;
const firstError = n => n.consoleErrors[0] || n.failedRequests[0] || '';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const origin = (() => { try { return new URL(G.meta.baseUrl).origin; } catch { return ''; } })();
const pathOf = u => { try { const x = new URL(u); return x.origin === origin ? x.pathname + x.search : x.host + x.pathname; } catch { return u; } };
const routeOf = u => { try { const x = new URL(u); return (x.origin === origin ? '' : x.host) + x.pathname.replace(/\d+/g, '#'); } catch { return u; } };
// ノードの経路名。探索側が正規化したルート（データ区間は *）があればそれを使い、古い graph.json では URL から作る
const routeOfNode = n => (n.route ? n.route.split('?')[0] : routeOf(n.url));
const readable = u => { try { return decodeURI(u); } catch { return u; } };
const shownPath = n => n.route || pathOf(n.url);
const ROLE_JA = { link: 'リンク', button: 'ボタン', tab: 'タブ', menuitem: 'メニュー', summary: '開閉' };
const fullBase = a => '「' + (a.label || a.href) + '」' + (ROLE_JA[a.role] || a.role);
const fullLabel = a => fullBase(a) + (a.nth > 1 ? '(' + a.nth + ')' : '');
const shortBase = a => { const t = a.label || a.href || ''; return a.role === 'link' ? t : a.role === 'button' ? '[' + t + ']' : a.role === 'tab' ? '〈' + t + '〉' : a.role === 'summary' ? '▸ ' + t : t + '·' + (ROLE_JA[a.role] || a.role); };
const charW = ch => ch.charCodeAt(0) > 0xff ? 11 : 6.4;
const textWidth = s => Array.from(s).reduce((w, ch) => w + charW(ch), 0);
const fitText = (s, maxW) => { if (textWidth(s) <= maxW) return s; let out = ''; let w = 0; for (const ch of Array.from(s)) { if (w + charW(ch) > maxW - 8) break; out += ch; w += charW(ch); } return out + '…'; };

// ---- 画面名のテンプレート化: 企業名・商品名などデータの値を〇〇に置き換える（DESIGN.md §8） ----
// データとみなす値は 3 つ。URL のデータ区間（*）とクエリの値、データを表す見出し、実例どうしで違うタイトルの部分。
// 画面の同一性（シグネチャ）には関わらない表示だけの処理で、graph.json から毎回作り直す
const PH = '〇〇';
const SCREEN_NAMES = (G.__view && G.__view.screenNames) || {};
const normText = s => String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, ' ').trim();
const decodePart = s => { try { return decodeURIComponent(s); } catch { return s; } };
// 2 文字以上で、数字と記号だけではない値だけを置き換える（「2」や「#」で無関係な部分を消さないため）
const usableValue = v => v.length >= 2 && /[^\d\s#.,:\/\-]/.test(v);
const collapsePH = s => s.replace(/〇〇(?:[\s・、,]*〇〇)+/g, PH);
/** text の中の values を〇〇に置き換える。比べるときは全角半角と空白を正規化し、残す部分は元の文字のままにする */
function scrubText(text, values) {
  const orig = String(text == null ? '' : text);
  const vs = [...new Set(values.map(normText).filter(usableValue))].sort((a, b) => b.length - a.length);
  if (!vs.length) return { text: orig, removed: [] };
  let norm = ''; const at = [];
  for (let i = 0; i < orig.length; i++) {
    let c = orig[i].normalize('NFKC'); if (/\s/.test(c)) c = ' ';
    if (c === ' ' && (norm === '' || norm.endsWith(' '))) continue;
    norm += c; for (let k = 0; k < c.length; k++) at.push(i);
  }
  const cut = new Array(orig.length).fill(false);
  for (const v of vs) { let from = 0, k; while ((k = norm.indexOf(v, from)) >= 0) { for (let j = k; j < k + v.length; j++) cut[at[j]] = true; from = k + v.length; } }
  let out = '', run = ''; const removed = [];
  for (let i = 0; i <= orig.length; i++) {
    if (i < orig.length && cut[i]) { run += orig[i]; continue; }
    if (run) { out += PH; removed.push(run.trim()); run = ''; }
    if (i < orig.length) out += orig[i];
  }
  return { text: collapsePH(out), removed };
}
// 全画面のタイトルの過半に共通する末尾（「 — サイト名」）。名前がデータだけになったかの判定に使う
const SITE_SUFFIX = (() => {
  const count = new Map(); let total = 0;
  for (const n of G.nodes) {
    if (!n.route || !n.title) continue; total++;
    let last = -1; const re = /\s+[—–\-|｜:：]\s+/g; let m; while ((m = re.exec(n.title))) last = m.index;
    if (last > 0) { const suf = n.title.slice(last); count.set(suf, (count.get(suf) || 0) + 1); }
  }
  let best = '', bestN = 0; for (const [k, c] of count) if (c > bestN) { best = k; bestN = c; }
  return total >= 2 && bestN >= Math.max(2, total / 2) ? best : '';
})();
const stripSite = s => (SITE_SUFFIX && s.endsWith(SITE_SUFFIX) && s.length > SITE_SUFFIX.length ? s.slice(0, -SITE_SUFFIX.length) : s);
const urlKey = u => { try { const x = new URL(u, origin || undefined); return decodePart(x.pathname).replace(/\/+$/, '') + x.search; } catch { return String(u); } };
/** URL のうちデータとみなす値（ルートの * の区間と、名前だけ残したクエリの値） */
function urlDataValues(n, url) {
  let u; try { u = new URL(url, origin || undefined); } catch { return []; }
  const [p, q] = (n.route || '').split('?');
  const segs = p.split('/').filter(Boolean); const us = u.pathname.split('/').filter(Boolean).map(decodePart);
  const out = [];
  if (us.length === segs.length) segs.forEach((seg, i) => { if (seg === '*') out.push(us[i]); });
  for (const k of (q ? q.split('&') : [])) if (!k.includes('=')) out.push(...u.searchParams.getAll(k));
  return out;
}
/**
 * 画面のテンプレート名。データの部分が見つからなければ null。
 * 見出し（先頭の 1 つ）は、実例が 2 つ以上あれば実例どうしで違うときだけデータとみなす。実例が 1 つなら、
 * データ区間を持つ画面の見出しをデータとみなす（シグネチャでも h1 をデータ扱いしている）。ただし見出しに URL の値が
 * 入っていれば（「サービス業の企業一覧」）、URL の値がデータで残りはテンプレートの文言とみなす。
 * 置き換えるとサイト名しか残らないとき（商品名だけのタイトル）は、データでない見出し（「商品詳細」）を名前にする。
 */
const templateOf = (() => {
  const cache = new Map();
  const compute = (n, known) => {
    if (!n.route || !n.title) return null;
    const inst = [{ url: n.url, title: n.title, heading: (n.headings || [])[0] || '' }, ...(n.samples || [])];
    const vals = inst.map(i => urlDataValues(n, i.url).concat(known));
    const heads = inst.map((i, k) => normText(scrubText(i.heading || '', vals[k]).text));
    const headingIsData = inst.length >= 2 ? new Set(heads).size > 1 : (n.route.includes('*') && !!heads[0] && !heads[0].includes(PH));
    const values = inst.map((i, k) => vals[k].concat(headingIsData && i.heading ? [i.heading] : []));
    const scrubbed = inst.map((i, k) => scrubText(i.title, values[k]));
    let name = scrubbed[0].text; let example = scrubbed[0].removed[0] || '';
    const texts = [...new Set(scrubbed.map(x => x.text))];
    // 代表（撮影した実例）のタイトルからデータを消せたら、それを名前にする。実例ごとにタイトルの形が違うアプリ
    // （開示項目の多い企業だけ「〇〇の平均年収・…」になる）で、実例どうしの共通部分が「〇〇の〇〇」に痩せるのを避けるため
    if (texts.length > 1 && !scrubbed[0].removed.length) {
      // 代表のタイトルにデータが見つからない（商品名だけのタイトル）: 実例どうしの共通の前後を残し、違う部分をデータとみなす
      const arr = texts.map(t => Array.from(t)); const min = Math.min(...arr.map(a => a.length));
      let pre = 0; while (pre < min && arr.every(a => a[pre] === arr[0][pre])) pre++;
      let suf = 0; while (suf < min - pre && arr.every(a => a[a.length - 1 - suf] === arr[0][arr[0].length - 1 - suf])) suf++;
      name = collapsePH(arr[0].slice(0, pre).join('') + PH + arr[0].slice(arr[0].length - suf).join(''));
      if (!example) example = arr[0].slice(pre, arr[0].length - suf).join('').split(PH).join('').trim();
    }
    const core = stripSite(name).split(PH).join('').replace(/[\s\p{P}]/gu, '');
    if (!core) {
      const h = (n.headings || [])[0];
      if (h && !headingIsData) name = h + (SITE_SUFFIX && n.title.endsWith(SITE_SUFFIX) ? SITE_SUFFIX : '');
    }
    if (name === n.title) return null;
    return {
      name, example, headingIsData,
      removed: scrubbed.flatMap(x => x.removed),
      others: (n.mergedUrls || []).length + (n.jevMerged || []).length,
      instances: inst.map((i, k) => ({ key: urlKey(i.url), values: values[k] })),
      headings: (n.headings || []).map((h, i) => (i === 0 && headingIsData ? null : scrubText(h, vals[0]).text)).filter(Boolean),
    };
  };
  // データ区間を持つ画面で「データ」と分かった値（企業名・業種名など）の辞書。URL にデータを持つ別の画面のタイトルからも消す。
  // 比較画面のタイトル「ＡＩＡＩグループ株式会社を比べる」は、企業名が URL（法人番号）にも見出しにも出ないため、これで拾う
  const KNOWN = [...new Set(G.nodes.filter(n => n.route && n.route.includes('*')).flatMap(n => { const t = compute(n, []); return t ? t.removed : []; }).map(normText).filter(v => v.length >= 3 && usableValue(v)))];
  const carriesData = n => !!n.route && (n.route.includes('*') || n.route.split('?')[1] !== undefined && n.route.split('?')[1].split('&').some(k => !k.includes('=')));
  return n => {
    if (cache.has(n.id)) return cache.get(n.id);
    let t = compute(n, carriesData(n) ? KNOWN : []);
    // 設定 screenNames による上書き（ルートそのもの、またはクエリを除いたルートで引く）
    const key = n.route ? [n.route, n.route.split('?')[0]].find(k => Object.prototype.hasOwnProperty.call(SCREEN_NAMES, k)) : undefined;
    if (key) t = Object.assign({ example: '', others: 0, instances: [], headingIsData: false, headings: null }, t || {}, { name: SCREEN_NAMES[key], fixed: true });
    cache.set(n.id, t); return t;
  };
})();
const baseName = n => { const t = templateOf(n); return t ? t.name : (n.title || '(無題)'); };
const headsOf = n => { const t = templateOf(n); return t && t.headings ? t.headings : (n.headings || []); };
const exampleOf = n => { const t = templateOf(n); return t && t.example ? '例: ' + t.example + (t.others ? ' ほか ' + t.others + ' 件' : '') : ''; };
/**
 * 辺のラベル。行き先がテンプレート名の画面で、ラベルがその実例のデータ（企業名など）なら〇〇にする。
 * 実例が記録されていない古い graph.json では、同じ画面から同じ行き先へ違うラベルのリンクが 2 本以上あればデータとみなす
 */
const labelOfEdge = (() => {
  const labelsByPair = new Map();
  for (const e of G.edges) { if (e.error || e.action.role !== 'link') continue; const k = e.from + '>' + e.to; if (!labelsByPair.has(k)) labelsByPair.set(k, new Set()); labelsByPair.get(k).add(e.action.label); }
  return e => {
    const a = e.action; const to = byId.get(e.to);
    if (e.error || a.role !== 'link' || !a.href || !to || !to.route) return a.label;
    const t = templateOf(to); if (!t) return a.label;
    const found = t.instances.find(i => i.key === urlKey(a.href));
    // 実例が記録されていない古い graph.json 向けの予備。ページ番号のような数字だけのラベルは対象にしない
    if (!found) return to.route.includes('*') && usableValue(normText(a.label)) && (labelsByPair.get(e.from + '>' + e.to) || new Set()).size >= 2 ? PH : a.label;
    const r = scrubText(a.label, found.values);
    if (!r.removed.length) return a.label;
    // 置き換えた残りが件数などの数字と記号だけなら、ラベル全体を〇〇にする（「サービス業 668」→「〇〇」）
    const rest = r.text.split(PH).join('').replace(/\d+(?:[,.]\d+)*/g, '').replace(/[\s\p{P}]/gu, '');
    return rest ? r.text : PH;
  };
})();

// ---- 辺のまとめ: 同じ (from, to, ラベル) は 1 本にして本数を添える。失敗した辺はまとめない ----
// ラベルは表示用（データの値を〇〇にしたもの）で比べるので、企業名のリンク 3 本は「〇〇 ×3」の 1 本になる
const E = [];
{
  const groups = new Map();
  G.edges.forEach((e, i) => {
    const label = labelOfEdge(e); const act = label === e.action.label ? e.action : Object.assign({}, e.action, { label });
    const key = e.error ? 'err#' + i : e.from + '|' + e.to + '|' + fullBase(act);
    let d = groups.get(key);
    if (!d) { d = { from: e.from, to: e.to, act, dataLabel: act !== e.action, full: e.error ? fullLabel(act) : fullBase(act), short: e.error ? shortBase(act) + (act.nth > 1 ? '(' + act.nth + ')' : '') : shortBase(act), error: e.error, raw: [], nav: false, discovery: false }; groups.set(key, d); E.push(d); }
    d.raw.push(e);
  });
}
// 発見辺: 各ノードに最初に到達した辺。これが探索の木になる
const parentOf = new Map(), children = new Map(), treeEdgeTo = new Map();
{
  const seen = new Set([G.root]);
  for (const e of G.edges) {
    if (e.error || e.from === e.to || seen.has(e.to)) continue;
    seen.add(e.to);
    const d = E.find(d => d.raw.includes(e)); if (!d) continue;
    d.discovery = true; parentOf.set(e.to, e.from); treeEdgeTo.set(e.to, d);
    if (!children.has(e.from)) children.set(e.from, []);
    children.get(e.from).push(e.to);
  }
}
// 共通ナビ: 同じラベルで同じ行き先へ向かう辺が、操作を持つ画面の過半数（3 画面以上）から出ていれば畳む
const navGroups = [];
{
  const withOut = new Set(E.filter(d => !d.error && d.from !== d.to).map(d => d.from)).size;
  const groups = new Map();
  for (const d of E) { if (d.error || d.from === d.to) continue; const k = d.full + '→' + d.to; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); }
  for (const [, list] of groups) {
    const sources = new Set(list.map(d => d.from));
    if (sources.size >= 3 && sources.size >= Math.ceil(withOut * 0.5)) {
      navGroups.push({ label: list[0].short, full: list[0].full, to: list[0].to, count: sources.size });
      for (const d of list) if (!d.discovery) d.nav = true;
    }
  }
}
const navEdgeCount = E.filter(d => d.nav).length;

// ---- 副題: 同じタイトルの画面は、他と共有していない見出しで区別する ----
// 名前と見出しはテンプレート化したもので比べる（データの見出し＝企業名を副題にしない）
const subtitleOf = (() => {
  const byTitle = new Map();
  for (const n of G.nodes) { const k = baseName(n); if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(n); }
  const cache = new Map();
  return n => {
    if (cache.has(n.id)) return cache.get(n.id);
    const group = byTitle.get(baseName(n)); let best = null;
    if (group.length >= 2) {
      const others = group.filter(o => o !== n); let bestShared = Infinity;
      for (const h of headsOf(n)) { if (!h) continue; const shared = others.filter(o => headsOf(o).includes(h)).length; if (shared < bestShared) { best = h; bestShared = shared; } }
      if (bestShared >= others.length) best = null;
    }
    cache.set(n.id, best); return best;
  };
})();
const nameOf = n => baseName(n) + (subtitleOf(n) ? ' · ' + subtitleOf(n) : '');
const pathTo = id => { const chain = []; let cur = id; while (parentOf.has(cur)) { chain.unshift(treeEdgeTo.get(cur)); cur = parentOf.get(cur); } return chain; };
const subtreeOf = id => { const out = [id]; for (const c of children.get(id) || []) out.push(...subtreeOf(c)); return out; };

// ---- 操作フロー: 木の葉ごとに「起点からそこまでの経路」を 1 本のシナリオとみなす ----
const verb = d => {
  const a = d.act || d.raw[0].action; const t = a.label || a.href || ''; const n = d.raw.length > 1 ? '（同じ操作が ' + d.raw.length + ' 件）' : '';
  if (/(く|す|る|む|ぶ|ぐ|つ|う)$/.test(t) && /(を|に|へ|で)/.test(t)) return '「' + t + '」' + n;
  if (a.role === 'link') return '「' + t + '」を開く' + n;
  if (a.role === 'button') return '「' + t + '」を押す' + n;
  if (a.role === 'tab') return '「' + t + '」タブに切り替える' + n;
  if (a.role === 'summary') return '「' + t + '」を開く' + n;
  return '「' + t + '」を操作する' + n;
};

// ---- 章: 起点から直接行ける画面ごとのグループ。起点と同じ URL の状態（モーダル等）は起点の章に含める ----
const groupOfNode = new Map();
const chapters = [];
{
  const rootRoute = routeOfNode(byId.get(G.root));
  const rootGroup = { id: G.root, nodes: [G.root], isRoot: true };
  chapters.push(rootGroup);
  for (const c of children.get(G.root) || []) {
    const nodes = subtreeOf(c);
    if (routeOfNode(byId.get(c)) === rootRoute) rootGroup.nodes.push(...nodes);
    else chapters.push({ id: c, nodes, isRoot: false });
  }
  for (const n of G.nodes) if (!groupOfNode.has(n.id)) { /* 木に入っていない孤立ノードは起点の章へ */ }
  for (const ch of chapters) for (const id of ch.nodes) groupOfNode.set(id, ch.id);
  for (const n of G.nodes) if (!groupOfNode.has(n.id)) { rootGroup.nodes.push(n.id); groupOfNode.set(n.id, G.root); }
}
const chapterOf = id => chapters.find(c => c.id === groupOfNode.get(id));
const chapterName = ch => ch.isRoot ? '起点 · ' + baseName(byId.get(G.root)) : nameOf(byId.get(ch.id));
const UI = { home: 'グループ図', group: 'グループ', map: '全画面の木', flow: '操作フロー' };

const scenarios = [];
{
  const order = []; const walk = id => { order.push(id); for (const c of children.get(id) || []) walk(c); }; walk(G.root);
  for (const id of order) {
    if (id === G.root || (children.get(id) || []).length) continue;
    const steps = pathTo(id); const frames = [G.root, ...steps.map(d => d.to)]; const leaf = byId.get(id);
    const last = steps[steps.length - 1];
    // 最後の操作がデータのリンク（企業名など）なら、ラベルではなく行き先の画面名で呼ぶ: 「〇〇の働きやすさデータ」を開く
    const name = last.dataLabel && last.act.label === PH
      ? '「' + stripSite(nameOf(leaf)) + '」を開く' + (last.raw.length > 1 ? '（同じ操作が ' + last.raw.length + ' 件）' : '')
      : verb(last) + ' → ' + nameOf(leaf);
    scenarios.push({ id, steps, frames, group: groupOfNode.get(id), name,
      err: frames.some(f => errCount(byId.get(f)) > 0), added: frames.some(isAdded), changed: frames.some(isChanged), external: leaf.truncated === '外部サイト' });
  }
}
for (const ch of chapters) {
  ch.flows = scenarios.filter(s => s.group === ch.id);
  ch.err = ch.nodes.filter(id => errCount(byId.get(id)) > 0).length;
  ch.added = ch.nodes.some(isAdded); ch.changed = ch.nodes.some(isChanged); ch.external = ch.nodes.some(id => byId.get(id).truncated === '外部サイト');
}
const badgesOf = o => (o.err ? '<span class="badge err">エラー' + (typeof o.err === 'number' && o.err > 1 ? ' ' + o.err : '') + '</span>' : '') + (o.added ? '<span class="badge added">新規</span>' : '') + (o.changed ? '<span class="badge changed">変化</span>' : '') + (o.external ? '<span class="badge trunc">外部</span>' : '');

// 章の間の関係: 章をまたぐ辺をまとめる（共通ナビは別枠）
const chapterLinks = [];
{
  const agg = new Map();
  for (const d of E) {
    if (d.error || d.from === d.to) continue;
    const gf = groupOfNode.get(d.from), gt = groupOfNode.get(d.to); if (gf === gt) continue;
    const k = gf + '>' + gt + (d.nav ? '|nav' : '');
    let l = agg.get(k); if (!l) { l = { from: gf, to: gt, nav: d.nav, labels: new Map(), raw: [], tree: false }; agg.set(k, l); chapterLinks.push(l); }
    l.raw.push(...d.raw); l.labels.set(d.short, (l.labels.get(d.short) || 0) + d.raw.length);
    if (d.discovery && gf === G.root && d.to === gt) l.tree = true;
  }
}

// ---- 問題一覧: エラーっぽいものを画面ごとにまとめる ----
const issues = (() => {
  const byScreen = new Map();
  const push = (key, item) => { if (!byScreen.has(key)) byScreen.set(key, { key, node: byId.get(key) || null, removed: null, items: [] }); byScreen.get(key).items.push(item); };
  for (const n of G.nodes) {
    const prevNode = G.diff && diff.previous && diff.previous[n.id] ? true : false;
    for (const e of n.consoleErrors) push(n.id, { kind: 'console', label: 'コンソール', msg: e, isNew: !!G.diff && (!prevNode || diff.newErrors.includes(n.id)) });
    for (const f of n.failedRequests) push(n.id, { kind: 'request', label: 'リクエスト失敗', msg: f, isNew: !!G.diff && !prevNode });
    if (n.truncated) push(n.id, { kind: 'trunc', label: '探索の打ち切り', msg: n.truncated, plain: true, isNew: false });
  }
  for (const d of E) if (d.error) push(d.from, { kind: 'action', label: '操作の失敗', msg: d.full + ': ' + d.error, plain: true, isNew: false });
  if (G.diff) {
    for (const id of diff.changed) push(id, { kind: 'diff', label: '内容が変わった', msg: '前回（' + diff.previousRun + '）と本文テキストが異なる', plain: true, isNew: true });
    for (const id of diff.added) push(id, { kind: 'diff', label: '新しい画面', msg: '前回にはなかった画面', plain: true, isNew: true });
    diff.removed.forEach((r, i) => { const key = 'removed#' + i; push(key, { kind: 'removed', label: '消えた画面', msg: '前回にあった画面が今回は到達できない', plain: true, isNew: true }); byScreen.get(key).removed = r; });
  }
  if (G.meta.stoppedBecause) push(G.root, { kind: 'trunc', label: '探索の停止', msg: G.meta.stoppedBecause, plain: true, isNew: false });
  if (G.diff && G.diff.warning) push(G.root, { kind: 'trunc', label: '比較の注意', msg: G.diff.warning, plain: true, isNew: false });
  if (G.meta.jev && G.meta.jev.errors) push(G.root, { kind: 'trunc', label: 'Jev の問い合わせ失敗', msg: G.meta.jev.errors + ' 回失敗し、その判定は機械的ルールだけで進めました（' + (G.meta.jev.lastError || '') + '）', plain: true, isNew: false });
  const sev = { console: 3, removed: 3, request: 2, action: 2, diff: 1, trunc: 0 };
  const list = [...byScreen.values()];
  for (const sc of list) { sc.items.sort((a, b) => sev[b.kind] - sev[a.kind]); sc.score = Math.max(...sc.items.map(i => sev[i.kind])) * 10 + (sc.items.some(i => i.isNew) ? 5 : 0) + Math.min(sc.items.length, 4); }
  list.sort((a, b) => b.score - a.score);
  return list;
})();
const issueCount = issues.reduce((n, sc) => n + sc.items.length, 0);
let issueKind = 'all', issueNewOnly = false;

// ---- 状態 ----
// 画面数が少ないうちはコンパクトな全画面の木で着地し、増えたらグループ図で着地する
const LANDING_MAX_TREE = 40;
const LANDING = G.nodes.length <= LANDING_MAX_TREE ? 'map' : 'home';
const TOP = ['home', 'map', 'issues'];
let mode = LANDING, originView = LANDING, chapter = null, flow = null, step = 0, selected = null, hovered = null;
let compact = true, scale = 1, filter = 'all', query = '';
const NODE_H = () => compact ? 70 : 262;
const ROW_GAP = () => compact ? 30 : 44;

// ---- 汎用の描画: 項目（カード）と辺 ----
const canvas = document.getElementById('canvas'), sizer = document.getElementById('sizer'), wrap = document.getElementById('canvas-wrap');
const nodesEl = document.getElementById('nodes'), groupsEl = document.getElementById('groups'), svg = document.getElementById('edges');
const NS = 'http://www.w3.org/2000/svg';
let items = new Map(), links = [], W = 0, H = 0;

function routeEdge(a, b, tree, lane, allItems) {
  // a, b: {x,y,w,h}。戻り値: path と ラベル位置
  let path, lx, ly, kind, maxW = 150;
  if (a === b) {
    const l = lane('self' + a.id); const x = a.x + a.w, y = a.y + 24 + l * 16;
    path = 'M ' + x + ' ' + y + ' c 44 -26, 44 36, 0 10'; lx = x + 40; ly = y - 12; kind = 'self';
  } else if (tree && b.x > a.x) {
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, tx = x1 + TRUNK;
    path = Math.abs(y1 - y2) < 1 ? 'M ' + x1 + ' ' + y1 + ' H ' + x2 : 'M ' + x1 + ' ' + y1 + ' H ' + tx + ' V ' + y2 + ' H ' + x2;
    maxW = (x2 - x1) - TRUNK - 16; kind = 'tree'; lx = x2 - 8; ly = y2 - 10; // lx は右端。後で幅ぶん寄せる
  } else if (b.x > a.x) {
    const l = lane('f' + a.id + '>' + b.id);
    const x1 = a.x + a.w, y1 = a.y + a.h / 2 + 14 + l * 10, x2 = b.x, y2 = b.y + b.h / 2 - 14 - l * 8, mx = (x1 + x2) / 2;
    path = 'M ' + x1 + ' ' + y1 + ' C ' + mx + ' ' + y1 + ', ' + mx + ' ' + y2 + ', ' + x2 + ' ' + y2;
    lx = mx; ly = (y1 + y2) / 2 + 12 + l * 14; kind = 'fwd';
  } else if (b.x === a.x) {
    const l = lane('s' + Math.min(a.y, b.y) + '-' + Math.max(a.y, b.y));
    const x = a.x + a.w, y1 = a.y + a.h / 2 + 16, y2 = b.y + b.h / 2 - 16, cx = x + 50 + l * 14;
    path = 'M ' + x + ' ' + y1 + ' C ' + cx + ' ' + y1 + ', ' + cx + ' ' + y2 + ', ' + x + ' ' + y2;
    lx = cx + 6; ly = (y1 + y2) / 2 + (b.y < a.y ? -12 : 12) + l * 6; kind = 'back';
  } else if (a.x - (b.x + b.w) <= COL_GAP + 1) {
    const l = lane('a' + a.id + '>' + b.id);
    const x1 = a.x, y1 = a.y + a.h / 2 + 24 + l * 12, x2 = b.x + b.w, y2 = b.y + b.h / 2 + 24 + l * 12, mx = (x1 + x2) / 2;
    path = 'M ' + x1 + ' ' + y1 + ' C ' + mx + ' ' + y1 + ', ' + mx + ' ' + y2 + ', ' + x2 + ' ' + y2;
    lx = mx; ly = (y1 + y2) / 2 + 14; kind = 'back';
  } else {
    const l = lane('b' + b.x + '-' + a.x);
    let bottom = 0; for (const it of allItems.values()) if (it.x >= b.x && it.x <= a.x) bottom = Math.max(bottom, it.y + it.h);
    const x1 = a.x + a.w / 2 + 30 - l * 10, y1 = a.y + a.h, x2 = b.x + b.w / 2 - 30 + l * 10, y2 = b.y + b.h, dip = bottom + 36 + l * 16;
    path = 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (dip + 10) + ', ' + x2 + ' ' + (dip + 10) + ', ' + x2 + ' ' + y2;
    lx = (x1 + x2) / 2; ly = dip - 2; kind = 'back';
  }
  return { path, lx, ly, kind, maxW };
}

function drawGraph(newItems, newLinks, extras) {
  items = new Map(newItems.map(it => [it.id, it])); links = [];
  W = Math.max(...newItems.map(it => it.x + it.w)) + 120; H = Math.max(...newItems.map(it => it.y + it.h)) + 100;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  nodesEl.innerHTML = ''; groupsEl.innerHTML = '';
  svg.innerHTML = '<defs>' + ['', '-err', '-hi', '-nav', '-path'].map(s => '<marker id="arrow' + s + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="' + ({ '': '#94a3b8', '-err': '#ef4444', '-hi': '#3b82f6', '-nav': '#475569', '-path': '#38bdf8' })[s] + '"/></marker>').join('') + '</defs>';
  if (extras) extras();
  for (const it of newItems) {
    const el = document.createElement('div');
    el.className = 'item ' + (it.cls || ''); el.tabIndex = 0; el.dataset.id = it.id; el.setAttribute('role', 'button');
    el.style.left = it.x + 'px'; el.style.top = it.y + 'px'; el.style.width = it.w + 'px'; el.style.height = it.h + 'px';
    el.innerHTML = it.html;
    el.addEventListener('click', ev => { ev.stopPropagation(); it.onClick(); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); it.onClick(); } });
    el.addEventListener('mouseenter', () => { hovered = it.id; applyHighlight(); });
    el.addEventListener('mouseleave', () => { hovered = null; applyHighlight(); });
    nodesEl.appendChild(el);
    if (it.stubs && it.stubs.length) {
      const st = document.createElement('div'); st.className = 'stubs'; st.style.left = it.x + 'px'; st.style.top = (it.y + it.h + 5) + 'px'; st.style.width = (it.w + 120) + 'px';
      st.innerHTML = it.stubs.map((s, i) => '<button class="stub" data-i="' + i + '" title="' + esc(s.title) + '">' + esc(s.label) + '</button>').join('');
      st.querySelectorAll('.stub').forEach(b => b.addEventListener('click', ev => { ev.stopPropagation(); it.stubs[+b.dataset.i].onClick(); }));
      nodesEl.appendChild(st);
    }
  }
  const laneCount = new Map(); const lane = k => { const v = laneCount.get(k) || 0; laneCount.set(k, v + 1); return v; };
  for (const L of newLinks) {
    const a = items.get(L.from), b = items.get(L.to); if (!a || !b) continue;
    const r = routeEdge(a, b, L.tree, lane, items);
    const text = L.label + (L.count > 1 ? ' ×' + L.count : '');
    const short = fitText(text, r.maxW); const w = textWidth(short) + 12;
    const lx = r.kind === 'tree' ? r.lx - w / 2 : r.lx; // 木の枝は子のすぐ左に右寄せ
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', r.path);
    p.setAttribute('class', 'edge ' + (L.error ? 'err ' : '') + (L.nav ? 'nav ' : '') + (r.kind === 'tree' ? 'tree ' : '') + (r.kind === 'back' ? 'back' : ''));
    svg.appendChild(p);
    const bg = document.createElementNS(NS, 'rect'); bg.setAttribute('width', w); bg.setAttribute('height', 16); bg.setAttribute('rx', 3);
    const t = document.createElementNS(NS, 'text'); t.setAttribute('text-anchor', 'middle'); t.textContent = short;
    const title = document.createElementNS(NS, 'title'); title.textContent = (L.full || L.label) + (L.count > 1 ? ' ×' + L.count : '') + (L.error ? '\n' + L.error : '') + '\n' + (a.name || a.id) + ' → ' + (b.name || b.id); t.appendChild(title);
    const ondemand = r.kind !== 'tree';
    bg.setAttribute('class', 'lbl-bg' + (ondemand ? ' ondemand' : '')); t.setAttribute('class', 'lbl' + (L.error ? ' err' : '') + (ondemand ? ' ondemand' : ''));
    svg.appendChild(bg); svg.appendChild(t);
    links.push({ L, p, bg, t, lx, ly: r.ly, w, kind: r.kind });
  }
  applyState();
}

// ---- 木レイアウト（tidy tree）。inSet で部分木に絞る ----
function treeLayout(rootId, inSet, nh, rg) {
  const kids = id => (children.get(id) || []).filter(c => inSet.has(c));
  const rows = new Map(); const height = id => { const cs = kids(id); const v = cs.length ? cs.reduce((s, c) => s + height(c), 0) : 1; rows.set(id, v); return v; };
  const rowOf = new Map();
  const place = (id, top) => { const cs = kids(id); if (!cs.length) { rowOf.set(id, top); return; } let t = top; for (const c of cs) { place(c, t); t += rows.get(c); } rowOf.set(id, (rowOf.get(cs[0]) + rowOf.get(cs[cs.length - 1])) / 2); };
  const placed = new Set(); const roots = [rootId, ...[...inSet].filter(id => id !== rootId && !(parentOf.has(id) && inSet.has(parentOf.get(id))))];
  let cursor = 0; for (const r of roots) { if (placed.has(r)) continue; height(r); place(r, cursor); cursor += rows.get(r); for (const id of subtreeOf(r)) placed.add(id); }
  const pos = new Map(); const minDepth = Math.min(...[...inSet].map(id => byId.get(id).depth));
  for (const id of inSet) pos.set(id, { x: PAD_X + (byId.get(id).depth - minDepth) * (NODE_W + COL_GAP), y: PAD_Y + rowOf.get(id) * (nh + rg) });
  return pos;
}

function nodeItem(n, p, nh, stubs) {
  const badges = [];
  if (n.id === G.root) badges.push('<span class="badge root">起点</span>');
  if (isAdded(n.id)) badges.push('<span class="badge added">新規</span>');
  if (isChanged(n.id)) badges.push('<span class="badge changed">変化</span>');
  if (errCount(n)) badges.push('<span class="badge err">エラー ' + errCount(n) + '</span>');
  if (n.truncated) badges.push('<span class="badge trunc" title="' + esc(n.truncated) + '">…</span>');
  const sub = subtitleOf(n); const eg = exampleOf(n);
  const html = '<div class="badges">' + badges.join('') + '</div>' +
    (compact ? '' : '<div class="thumb"><img loading="lazy" src="' + esc(n.screenshot) + '" alt="' + esc(baseName(n)) + '"></div>') +
    '<div class="title" title="' + esc(baseName(n)) + '">' + esc(baseName(n)) + '</div>' +
    '<div class="sub" title="' + esc([sub, eg, readable(n.url)].filter(Boolean).join(' · ')) + '">' + (sub ? '<b>' + esc(sub) + '</b> · ' : '') + (eg ? esc(eg) + ' · ' : '') + '<code>' + esc(shownPath(n)) + '</code></div>' +
    (errCount(n) ? '<div class="errline" title="' + esc(firstError(n)) + '">⚠ ' + esc(firstError(n)) + '</div>' : '');
  return { id: n.id, x: p.x, y: p.y, w: NODE_W, h: nh, html, name: nameOf(n), node: n, stubs, onClick: () => selectNode(n.id) };
}
const nodeLink = d => ({ from: d.from, to: d.to, label: d.short, full: d.full, count: d.raw.length, error: d.error, nav: d.nav, tree: d.discovery, d });

// ---- 各表示の構築 ----
function buildNodesGraph(inSet, rootId) {
  const nh = NODE_H(), rg = ROW_GAP();
  const pos = treeLayout(rootId, inSet, nh, rg);
  const its = [];
  for (const n of G.nodes) {
    if (!inSet.has(n.id)) continue;
    // 章の外へ出る辺は、行き先の章ごとに 1 つの札にする（共通ナビは札にしない）
    const stubs = [];
    if (mode === 'chapter' && n.id !== G.root) {
      const seen = new Map();
      for (const d of E) {
        if (d.from !== n.id || d.error || d.nav || inSet.has(d.to)) continue;
        const ch = chapterOf(d.to); if (!ch || seen.has(ch.id)) { if (ch) seen.get(ch.id).labels.push(d.short); continue; }
        const s = { ch, labels: [d.short], to: d.to }; seen.set(ch.id, s); stubs.push(s);
      }
    }
    its.push(nodeItem(n, pos.get(n.id), nh, stubs.map(s => ({ label: '→ ' + (s.ch.isRoot ? '起点へ' : chapterName(s.ch)), title: s.labels.join(' / ') + ' で ' + chapterName(s.ch) + ' のグループへ', onClick: () => openChapter(s.ch.id, s.to) }))));
  }
  const lks = E.filter(d => inSet.has(d.from) && inSet.has(d.to)).map(nodeLink);
  drawGraph(its, lks, () => {
    // 列見出しと、同じ URL の画面をまとめる枠
    const cols = new Map(); for (const id of inSet) { const n = byId.get(id); if (!cols.has(n.depth)) cols.set(n.depth, []); cols.get(n.depth).push(n); }
    for (const [d, list] of cols) {
      const h = document.createElement('div'); h.className = 'col-head'; h.style.left = pos.get(list[0].id).x + 'px'; h.textContent = '深さ ' + d + ' · ' + list.length + ' 画面'; nodesEl.appendChild(h);
      const sorted = [...list].sort((a, b) => pos.get(a.id).y - pos.get(b.id).y); let i = 0;
      while (i < sorted.length) {
        let j = i; while (j + 1 < sorted.length && routeOfNode(sorted[j + 1]) === routeOfNode(sorted[i])) j++;
        if (j > i) { const top = pos.get(sorted[i].id), bottom = pos.get(sorted[j].id); const g = document.createElement('div'); g.className = 'group'; g.style.left = (top.x - 12) + 'px'; g.style.top = (top.y - 14) + 'px'; g.style.width = (NODE_W + 24) + 'px'; g.style.height = (bottom.y + nh - top.y + 28) + 'px'; g.innerHTML = '<span class="glabel">' + esc(routeOfNode(sorted[i])) + ' · ' + (j - i + 1) + ' 状態</span>'; groupsEl.appendChild(g); }
        i = j + 1;
      }
    }
  });
  const r = pos.get(rootId); if (r) wrap.scrollTo({ top: Math.max(0, r.y - wrap.clientHeight / 2 + nh / 2), left: 0 });
}

function buildHome() {
  // 章の関係図: 起点を左に、章を右の列に並べ、章をまたぐ辺だけを描く
  const root = chapters[0]; const rest = chapters.slice(1);
  const rowH = CH_H + 44; const totalH = Math.max(1, rest.length) * rowH;
  const its = [];
  const card = (ch, x, y) => {
    const n = byId.get(ch.id); const flows = ch.flows.length;
    const html = '<div class="badges">' + (ch.isRoot ? '<span class="badge root">起点</span>' : '') + badgesOf(ch) + '</div>' +
      '<div class="thumb"><img loading="lazy" src="' + esc(n.screenshot) + '" alt=""></div>' +
      '<div class="title" title="' + esc(chapterName(ch)) + '">' + esc(chapterName(ch)) + '</div>' +
      '<div class="meta"><span>' + ch.nodes.length + ' 画面</span><span>·</span><span>' + flows + ' フロー</span>' + (ch.nodes.length > 1 ? '<span>·</span><span>' + esc([...new Set(ch.nodes.map(id => pathOf(byId.get(id).url).split('?')[0]))].slice(0, 3).join(' ')) + '</span>' : '') + '</div>';
    return { id: ch.id, x, y, w: CH_W, h: CH_H, html, cls: 'chapter', name: chapterName(ch), ch, onClick: () => openChapter(ch.id) };
  };
  its.push(card(root, PAD_X, PAD_Y + Math.max(0, (totalH - rowH) / 2)));
  rest.forEach((ch, i) => its.push(card(ch, PAD_X + CH_W + COL_GAP, PAD_Y + i * rowH)));
  const lks = chapterLinks.map(l => {
    const [label, cnt] = [...l.labels.entries()].sort((a, b) => b[1] - a[1])[0];
    const more = l.labels.size > 1 ? '（ほか ' + (l.labels.size - 1) + ' 件）' : '';
    return { from: l.from, to: l.to, label: label + more, full: [...l.labels.keys()].join(' / '), count: l.labels.size > 1 ? 1 : l.raw.length, nav: l.nav, tree: l.tree };
  });
  drawGraph(its, lks, () => {
    const h = document.createElement('div'); h.className = 'col-head'; h.style.left = PAD_X + 'px'; h.textContent = '起点'; nodesEl.appendChild(h);
    const h2 = document.createElement('div'); h2.className = 'col-head'; h2.style.left = (PAD_X + CH_W + COL_GAP) + 'px'; h2.textContent = UI.group + ' · ' + rest.length; nodesEl.appendChild(h2);
  });
  wrap.scrollTo({ top: 0, left: 0 });
}

function buildStrip() {
  const strip = document.getElementById('strip'); const sc = flow;
  strip.innerHTML = sc.frames.map((f, i) => {
    const n = byId.get(f);
    const card = '<div class="fcard' + (i === step ? ' cur' : '') + '" data-step="' + i + '" tabindex="0" role="button"><div class="fnum">' + (i + 1) + '</div><img src="' + esc(n.screenshot) + '" alt="' + esc(n.title) + '"><div class="fname">' + esc(nameOf(n)) + '</div><div class="fsub">' + esc(pathOf(n.url)) + '</div>' + (errCount(n) ? '<div class="errline">⚠ ' + esc(firstError(n)) + '</div>' : '') + '</div>';
    const arrow = i < sc.steps.length ? '<div class="farrow"><span class="act">' + esc(verb(sc.steps[i])) + '</span><div class="line"></div></div>' : '';
    return card + arrow;
  }).join('');
  strip.querySelectorAll('.fcard').forEach(c => { c.addEventListener('click', () => gotoStep(+c.dataset.step)); c.addEventListener('keydown', e => { if (e.key === 'Enter') gotoStep(+c.dataset.step); }); });
  const cur = strip.querySelector('.fcard.cur'); if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

// ---- モード遷移 ----
function setMode(m) {
  mode = m;
  document.getElementById('canvas-wrap').hidden = m === 'flow' || m === 'issues';
  document.getElementById('strip-wrap').hidden = m !== 'flow';
  document.getElementById('issues-wrap').hidden = m !== 'issues';
  const canvasMode = m !== 'flow' && m !== 'issues';
  document.getElementById('zoom').hidden = !canvasMode;
  document.getElementById('compact-toggle').hidden = !(m === 'chapter' || m === 'map');
  document.getElementById('nav-toggle-wrap').hidden = !canvasMode || navEdgeCount === 0;
  document.getElementById('legend').hidden = !canvasMode;
  const top = TOP.includes(m) ? m : originView;
  document.querySelectorAll('.vbtn').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === top)));
  document.getElementById('crumb').hidden = TOP.includes(m);
  renderCrumb();
}
function goHome() { chapter = null; flow = null; selected = null; setMode('home'); buildHome(); setScale(1); overviewPanel(); commit(); }
function openChapter(id, selectId) {
  if (TOP.includes(mode)) originView = mode;
  chapter = chapters.find(c => c.id === id) || chapters[0]; flow = null; selected = selectId || null;
  setMode('chapter'); buildNodesGraph(new Set(chapter.id === G.root ? chapter.nodes : [G.root, ...chapter.nodes]), G.root); setScale(1);
  if (selected) { nodePanel(selected); const el = nodesEl.querySelector('.item[data-id="' + selected + '"]'); if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' }); } else chapterPanel();
  commit();
}
function openMap() { chapter = null; flow = null; selected = null; setMode('map'); buildNodesGraph(new Set(G.nodes.map(n => n.id)), G.root); setScale(1); overviewPanel(); commit(); }
function openFlow(id, at = 0) {
  const sc = scenarios.find(s => s.id === id); if (!sc) return;
  if (TOP.includes(mode)) originView = mode;
  flow = sc; chapter = chapterOf(sc.id); step = Math.max(0, Math.min(at, sc.frames.length - 1)); selected = sc.frames[step];
  setMode('flow'); buildStrip(); nodePanel(selected, { flow: true });
  commit();
}
function gotoStep(i) { if (!flow) return; step = Math.max(0, Math.min(i, flow.frames.length - 1)); selected = flow.frames[step]; buildStrip(); nodePanel(selected, { flow: true }); commit(); }
function selectNode(id) {
  selected = id; applyState(); nodePanel(id); commit();
}
function openIssues() { chapter = null; flow = null; selected = null; setMode('issues'); buildIssues(); overviewPanel(); commit(); }
function buildIssues() {
  const root = document.getElementById('issues');
  const kinds = [['all', 'すべて'], ['console', 'コンソール'], ['request', 'リクエスト失敗'], ['action', '操作の失敗'], ['diff', '前回との差分'], ['removed', '消えた画面'], ['trunc', '打ち切り']];
  const present = new Set(issues.flatMap(sc => sc.items.map(i => i.kind)));
  const filt = i => (issueKind === 'all' || i.kind === issueKind) && (!issueNewOnly || i.isNew);
  const screens = issues.map(sc => {
    const items = sc.items.filter(filt); if (!items.length) return '';
    const n = sc.node; const name = n ? nameOf(n) : (sc.removed.title || '(無題)'); const url = n ? pathOf(n.url) : pathOf(sc.removed.url);
    const where = n ? chapterName(chapterOf(n.id)) : '前回の実行（' + diff.previousRun + '）';
    const shot = n ? n.screenshot : sc.removed.screenshot;
    const newCnt = items.filter(i => i.isNew).length;
    return '<div class="screen"><div class="shead" data-node="' + (n ? n.id : '') + '"><img src="' + esc(shot) + '" alt="" loading="lazy"><div><div class="name">' + esc(name) + '</div><div class="where">' + esc(url) + ' · ' + esc(where) + '</div></div><div class="cnt">' + (newCnt ? '<span class="badge added">新 ' + newCnt + '</span>' : '') + '<span class="badge">' + items.length + ' 件</span>' + (n ? '<button class="open" data-open="' + n.id + '">' + UI.group + 'で開く</button>' : '') + '</div></div>' +
      '<div class="rows">' + items.map(i => '<div class="row"><span class="kind k-' + i.kind + '">' + esc(i.label) + '</span><span class="msg' + (i.plain ? ' plain' : '') + '">' + esc(i.msg) + '</span>' + (G.diff ? (i.isNew ? '<span class="new">新</span>' : '<span class="old">前回も</span>') : '<span></span>') + '</div>').join('') + '</div></div>';
  }).join('');
  root.innerHTML =
    '<h2>問題一覧 <span class="muted" style="font-weight:400;font-size:14px">' + issueCount + ' 件 · ' + issues.length + ' 画面</span></h2>' +
    '<p class="lead">コンソールエラー、失敗したリクエスト、失敗した操作、前回との差分、探索の打ち切りを画面ごとにまとめています。行の画面を押すと右に詳細、「' + UI.group + 'で開く」で図の中の位置に移動します。</p>' +
    '<div class="ifilters">' + kinds.filter(([k]) => k === 'all' || present.has(k)).map(([k, l]) => '<button data-kind="' + k + '"' + (issueKind === k ? ' class="on"' : '') + '>' + l + (k === 'all' ? '' : ' ' + issues.reduce((c, sc) => c + sc.items.filter(i => i.kind === k).length, 0)) + '</button>').join('') + (G.diff ? '<label><input type="checkbox" id="issue-new"' + (issueNewOnly ? ' checked' : '') + '> 前回になかったものだけ</label>' : '') + '</div>' +
    (screens || '<p class="empty">' + (issueCount ? '条件に合う問題はありません' : '問題は見つかりませんでした') + '</p>');
  root.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => { issueKind = b.dataset.kind; buildIssues(); }));
  const nc = root.querySelector('#issue-new'); if (nc) nc.addEventListener('change', () => { issueNewOnly = nc.checked; buildIssues(); });
  root.querySelectorAll('.shead').forEach(h => h.addEventListener('click', e => { if (e.target.closest('[data-open]')) return; const id = h.dataset.node; if (id) { selected = id; nodePanel(id); root.querySelectorAll('.screen').forEach(sc => sc.classList.toggle('sel', sc.contains(h))); } }));
  root.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); gotoNode(b.dataset.open); }));
}
const openView = v => v === 'map' ? openMap() : v === 'issues' ? openIssues() : goHome();
const goLanding = () => openView(LANDING);
function goUp() {
  if (mode === 'flow') { if (chapter) openChapter(chapter.id, flow.frames[step]); else openView(originView); return; }
  if (mode === 'chapter') { openView(originView); return; }
}
function renderCrumb() {
  const c = document.getElementById('crumb'); const originName = { home: UI.home, map: UI.map, issues: '問題一覧' }[originView];
  const parts = ['<button data-nav="home">' + originName + '</button>'];
  if (chapter && (mode === 'chapter' || mode === 'flow')) parts.push('<span class="sep">›</span><button data-nav="chapter"' + (mode === 'chapter' ? ' aria-current="page"' : '') + '>' + esc(chapterName(chapter)) + '</button>');
  if (mode === 'flow' && flow) parts.push('<span class="sep">›</span><button aria-current="page">' + esc(flow.name) + '</button>');
  c.innerHTML = parts.join('');
  c.querySelector('[data-nav="home"]').addEventListener('click', () => openView(originView));
  const cb = c.querySelector('[data-nav="chapter"]'); if (cb) cb.addEventListener('click', () => openChapter(chapter.id, mode === 'flow' ? flow.frames[step] : null));
}

// ---- 表示状態の反映 ----
const showNav = () => document.getElementById('nav-toggle').checked;
function labelVisible(el) { if (el.L.nav && !showNav()) return false; return el.kind === 'tree' || el.t.classList.contains('hi') || el.t.classList.contains('path'); }
function placeLabels() {
  const list = [];
  for (const el of links) { el.x = el.lx - el.w / 2; el.y = el.ly - 10; if (labelVisible(el)) list.push(el); }
  list.sort((p, q) => p.y - q.y || p.x - q.x);
  for (let pass = 0; pass < 4; pass++) { let moved = false; for (let i = 0; i < list.length; i++) for (let j = 0; j < i; j++) { const p = list[i], q = list[j]; const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x), oy = Math.min(p.y + 16, q.y + 16) - Math.max(p.y, q.y); if (ox > 0 && oy > 0) { p.y = q.y + 18; moved = true; } } if (!moved) break; }
  for (const el of links) { el.bg.setAttribute('x', el.x); el.bg.setAttribute('y', el.y); el.t.setAttribute('x', el.x + el.w / 2); el.t.setAttribute('y', el.y + 12); }
}
function applyHighlight() {
  const focus = hovered || selected;
  const pathD = new Set(mode !== 'home' && selected ? pathTo(selected) : []);
  const pathIds = new Set(); if (mode !== 'home' && selected) { let cur = selected; while (parentOf.has(cur)) { cur = parentOf.get(cur); pathIds.add(cur); } }
  nodesEl.querySelectorAll('.item').forEach(el => { el.classList.toggle('hov', !!hovered && el.dataset.id === hovered && hovered !== selected); el.classList.toggle('onpath', pathIds.has(el.dataset.id)); el.classList.toggle('sel', el.dataset.id === selected); });
  for (const el of links) {
    const { L, p, bg, t } = el;
    const isPath = L.d ? pathD.has(L.d) : false;
    const hi = !isPath && !!focus && (L.from === focus || L.to === focus);
    p.classList.toggle('hi', hi); bg.classList.toggle('hi', hi); t.classList.toggle('hi', hi);
    p.classList.toggle('path', isPath); bg.classList.toggle('path', isPath); t.classList.toggle('path', isPath);
    p.setAttribute('marker-end', 'url(#arrow' + (hi ? '-hi' : isPath ? '-path' : L.error ? '-err' : L.nav ? '-nav' : '') + ')');
    p.classList.toggle('faded', !!focus && !hi && !isPath);
  }
  placeLabels();
}
function matches(n, q) { return !q || (baseName(n) + ' ' + n.title + ' ' + n.url + ' ' + (n.headings || []).join(' ') + ' ' + (subtitleOf(n) || '')).toLowerCase().includes(q); }
function passFilter(n) { return filter === 'all' || (filter === 'added' && isAdded(n.id)) || (filter === 'changed' && isChanged(n.id)) || (filter === 'error' && errCount(n) > 0); }
function applyState() {
  for (const { L, p, bg, t } of links) { const hide = L.nav && !showNav(); p.classList.toggle('hidden', hide); bg.classList.toggle('hidden', hide); t.classList.toggle('hidden', hide); }
  const q = query.trim().toLowerCase(); let hits = 0, total = 0;
  nodesEl.querySelectorAll('.item').forEach(el => {
    const it = items.get(el.dataset.id); if (!it) return; total++;
    const ok = it.node ? (passFilter(it.node) && matches(it.node, q)) : it.ch.nodes.some(id => passFilter(byId.get(id)) && matches(byId.get(id), q));
    if (ok) hits++; el.classList.toggle('dim', !ok);
  });
  document.getElementById('search-count').textContent = (q || filter !== 'all') && mode !== 'flow' ? hits + ' / ' + total : '';
  applyHighlight();
}

// ---- ヘッダの配線 ----
document.getElementById('hdr-host').textContent = G.meta.baseUrl;
{
  const errNodes = G.nodes.filter(n => errCount(n) > 0).length;
  const secs = Math.round((new Date(G.meta.finishedAt) - new Date(G.meta.startedAt)) / 1000);
  let stats = '<span>画面 <b>' + G.nodes.length + '</b></span><span>' + UI.group + ' <b>' + (chapters.length - 1) + '</b></span><span>フロー <b>' + scenarios.length + '</b></span><span class="d-err">エラー画面 <b>' + errNodes + '</b></span>';
  if (G.diff) stats += '<span class="d-added">追加 <b>' + diff.added.length + '</b></span><span class="d-removed">消失 <b>' + diff.removed.length + '</b></span><span class="d-changed">変化 <b>' + diff.changed.length + '</b></span><span class="d-err">新エラー <b>' + diff.newErrors.length + '</b></span>';
  stats += '<span>所要 <b>' + Math.floor(secs / 60) + '分' + (secs % 60) + '秒</b></span>';
  if (G.meta.stoppedBecause) stats += '<span class="d-err">停止: <b>' + esc(G.meta.stoppedBecause) + '</b></span>';
  document.getElementById('hdr-stats').innerHTML = stats;
}
document.querySelectorAll('.filters button').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('.filters button').forEach(x => x.classList.toggle('on', x === b)); filter = b.dataset.filter; applyState(); if (mode === 'home') overviewPanel(); }));
document.getElementById('nav-toggle').addEventListener('change', applyState);
document.getElementById('nav-toggle-label').textContent = '共通ナビの辺を表示（' + navEdgeCount + ' 本を畳んでいます）';
const searchEl = document.getElementById('search');
searchEl.addEventListener('input', () => { query = searchEl.value; applyState(); if (mode === 'home') overviewPanel(); });
document.getElementById('compact-toggle').addEventListener('click', e => { compact = !compact; e.currentTarget.setAttribute('aria-pressed', String(!compact)); if (mode === 'chapter') openChapter(chapter.id, selected); else if (mode === 'map') { buildNodesGraph(new Set(G.nodes.map(n => n.id)), G.root); setScale(scale); } });
document.querySelectorAll('.vbtn').forEach(b => b.addEventListener('click', () => openView(b.dataset.view)));
document.getElementById('issues-btn').textContent = '問題一覧 (' + issueCount + ')';
document.querySelectorAll('#hdr-stats .d-err, #hdr-stats .d-removed, #hdr-stats .d-changed').forEach(el => { el.style.cursor = 'pointer'; el.title = '問題一覧を開く'; el.addEventListener('click', openIssues); });
function setScale(s) { scale = Math.min(2, Math.max(0.2, s)); canvas.style.transform = 'scale(' + scale + ')'; sizer.style.width = Math.round(W * scale) + 'px'; sizer.style.height = Math.round(H * scale) + 'px'; document.getElementById('zoom-val').textContent = Math.round(scale * 100) + '%'; }
document.getElementById('zoom-in').addEventListener('click', () => setScale(scale * 1.2));
document.getElementById('zoom-out').addEventListener('click', () => setScale(scale / 1.2));
document.getElementById('zoom-fit').addEventListener('click', () => setScale(Math.min((wrap.clientWidth - 16) / W, (wrap.clientHeight - 16) / H, 1)));
wrap.addEventListener('wheel', e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setScale(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); }, { passive: false });
wrap.addEventListener('click', e => { if (e.target === wrap || e.target === sizer || e.target === canvas || e.target === svg || e.target === nodesEl || e.target === groupsEl) { if (selected && mode !== 'home') { selected = null; applyState(); mode === 'chapter' ? chapterPanel() : overviewPanel(); commit(); } } });

// ---- 右パネル ----
const panel = document.getElementById('panel');
const bind = () => {
  panel.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => gotoNode(b.dataset.go)));
  panel.querySelectorAll('[data-flow]').forEach(b => b.addEventListener('click', () => openFlow(b.dataset.flow, 0)));
  panel.querySelectorAll('[data-chapter]').forEach(b => b.addEventListener('click', () => openChapter(b.dataset.chapter)));
  panel.querySelectorAll('[data-zoom]').forEach(i => i.addEventListener('click', () => zoom(i.getAttribute('src'))));
};
function gotoNode(id) {
  // 画面へ移動: 今の表示に含まれていればその場で選択、なければその画面の章を開く
  if ((mode === 'chapter' || mode === 'map') && items.has(id)) { selected = id; applyState(); nodePanel(id); const el = nodesEl.querySelector('.item[data-id="' + id + '"]'); if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); return; }
  const ch = chapterOf(id); openChapter(ch ? ch.id : G.root, id);
}
const flowItem = sc => '<li><button class="flow" data-flow="' + sc.id + '">' + esc(sc.name) + '</button><div class="meta"><span>' + sc.steps.length + ' 回のクリック</span><span>' + esc(['起点', ...sc.steps.map(d => d.short)].join(' → ')) + '</span>' + badgesOf(sc) + '</div></li>';
function flowList(list) {
  const q = query.trim().toLowerCase();
  const shown = list.filter(sc => (filter === 'all' || (filter === 'added' && sc.added) || (filter === 'changed' && sc.changed) || (filter === 'error' && sc.err)) && (!q || sc.frames.some(f => matches(byId.get(f), q))));
  if (!shown.length) return '<p class="empty">該当するフローはありません</p>';
  const groups = []; for (const sc of shown) { let g = groups.find(g => g.id === sc.group); if (!g) { g = { id: sc.group, list: [] }; groups.push(g); } g.list.push(sc); }
  return '<ul class="flows">' + groups.map(g => { const ch = chapters.find(c => c.id === g.id); return g.list.length === 1 && groups.length > 1 ? flowItem(g.list[0]) : '<li><details open><summary>' + esc(ch ? chapterName(ch) : '') + ' <span class="cnt">' + g.list.length + ' 本</span></summary><ul>' + g.list.map(flowItem).join('') + '</ul></details></li>'; }).join('') + '</ul>';
}
function overviewPanel() {
  const chips = (ids, cls) => ids.length ? '<div class="chips">' + ids.map(id => '<button class="chip ' + cls + '" data-go="' + id + '">' + esc(nameOf(byId.get(id))) + '</button>').join('') + '</div>' : '<p class="empty">なし</p>';
  const removed = diff.removed.map(r => '<li class="removed"><div>' + esc(r.title || '(無題)') + '</div><div class="url">' + esc(r.url) + '</div><img src="' + esc(r.screenshot) + '" alt="" loading="lazy"></li>');
  const errIds = G.nodes.filter(n => errCount(n) > 0).map(n => n.id); const failed = E.filter(d => d.error);
  panel.innerHTML =
    '<h2>探索の概要</h2>' +
    '<dl class="kv"><dt>起点</dt><dd class="url">' + esc(G.meta.baseUrl) + '</dd><dt>開始</dt><dd>' + esc(G.meta.startedAt.replace('T', ' ').slice(0, 19)) + '</dd><dt>画面</dt><dd>' + G.nodes.length + '（' + (chapters.length - 1) + ' グループ）</dd><dt>操作</dt><dd>' + G.edges.length + '（失敗 ' + failed.length + '）</dd>' + (G.diff ? '<dt>比較対象</dt><dd class="url">' + esc(diff.previousRun) + (diff.warning ? '<div style="color:var(--amber);font-family:inherit">' + esc(diff.warning) + '</div>' : '') + '</dd>' : '<dt>比較</dt><dd>初回のため前回比なし</dd>') + (G.meta.learnedPathRules && G.meta.learnedPathRules.length ? '<dt>データ区間</dt><dd title="同じ形のリンクが並ぶ URL の区間。* の部分が違っても同じ画面として合流させた">' + G.meta.learnedPathRules.map(r => '<code>' + esc(r) + '</code>').join(' ') + '</dd>' : '') + (G.meta.jev ? '<dt>Jev</dt><dd>' + esc(G.meta.jev.model) + '・問い合わせ ' + G.meta.jev.requests + ' 回（キャッシュ ' + G.meta.jev.cacheHits + ' 回）・押さなかった操作 ' + G.meta.jev.skippedActions + '・合流 ' + G.meta.jev.mergedStates + (G.meta.jev.rejectedPathRules.length ? '・見送ったデータ区間 ' + G.meta.jev.rejectedPathRules.map(r => '<code>' + esc(r) + '</code>').join(' ') : '') + (G.meta.jev.errors ? '・<span style="color:var(--red)">失敗 ' + G.meta.jev.errors + ' 回（' + esc(G.meta.jev.lastError || '') + '）</span>' : '') + '</dd>' : '') + '</dl>' +
    (mode === 'home' ? '<div class="usage"><b>使い方</b><ol><li>左のカードは「グループ」＝起点から直接行ける画面のまとまり。押すと中の画面が木で開きます。</li><li>下の「操作フロー」を押すと、起点からの操作をコマ割りで辿れます。</li><li>戻るときは上のパンくずか Esc。</li></ol><div class="muted">エラーや差分をまとめて見たいときは、上の「問題一覧」を押してください。</div></div>' : '') +
    (mode === 'map' ? '<div class="usage"><b>使い方</b><ol><li>左は全画面の木。太い線が「初めてその画面に到達した経路」で、左から右へ深さ順です。画面を押すと右に詳細（拡大キャプチャはここで見ます）。</li><li>下の「操作フロー」を押すと、起点からの操作をコマ割りで辿れます。</li><li>画面が増えて読みにくくなったら、上の「グループ図」で画面のまとまりごとに見られます。</li></ol><div class="muted">エラーや差分をまとめて見たいときは「問題一覧」。サムネイルはヘッダのボタンで出せます。</div></div>' : '') +
    '<h3>操作フロー (' + scenarios.length + ' 本)</h3>' + flowList(scenarios) +
    (G.diff ? '<h3>新しいエラーがある画面 (' + diff.newErrors.length + ')</h3>' + chips(diff.newErrors, 'err') : '<h3>エラーがある画面 (' + errIds.length + ')</h3>' + chips(errIds, 'err')) +
    (G.diff ? '<h3>前回あって今回消えた画面 (' + diff.removed.length + ')</h3>' + (removed.length ? '<ul>' + removed.join('') + '</ul>' : '<p class="empty">なし</p>') : '') +
    (G.diff ? '<h3>新しく現れた画面 (' + diff.added.length + ')</h3>' + chips(diff.added, 'added') : '') +
    (G.diff ? '<h3>内容が変わった画面 (' + diff.changed.length + ')</h3>' + chips(diff.changed, 'changed') : '') +
    (failed.length ? '<h3>失敗した操作 (' + failed.length + ')</h3><ul>' + failed.map(d => '<li class="err"><button data-go="' + d.from + '">' + esc(nameOf(byId.get(d.from))) + '</button>: ' + esc(d.full) + '<div class="pre">' + esc(d.error) + '</div></li>').join('') + '</ul>' : '') +
    (navGroups.length ? '<h3>共通ナビ（どの画面からでも行ける）</h3><ul>' + navGroups.map(g => '<li><span title="' + esc(g.full) + '">' + esc(g.label) + '</span> <span class="to">→ </span><button data-go="' + g.to + '">' + esc(nameOf(byId.get(g.to))) + '</button><span class="cnt">' + g.count + ' 画面から</span></li>').join('') + '</ul>' : '');
  bind();
}
function chapterPanel() {
  const ch = chapter; const errIds = ch.nodes.filter(id => errCount(byId.get(id)) > 0);
  const exits = chapterLinks.filter(l => l.from === ch.id && !l.nav), entries = chapterLinks.filter(l => l.to === ch.id && !l.nav && !l.tree);
  const lk = l => '<li><button data-chapter="' + (l.from === ch.id ? l.to : l.from) + '">' + esc(chapterName(chapters.find(c => c.id === (l.from === ch.id ? l.to : l.from)))) + '</button> <span class="to">' + esc([...l.labels.keys()].join(' / ')) + '</span></li>';
  panel.innerHTML =
    '<h2>' + esc(chapterName(ch)) + '</h2>' +
    '<div class="meta" style="display:flex;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--muted)"><span>' + ch.nodes.length + ' 画面</span>' + badgesOf(ch) + '</div>' +
    '<p class="hint">このグループの中の画面です。画面を押すと詳細、画面の下の「→ グループ名」の札は他のグループへ渡る操作です。Esc でグループ図に戻ります。</p>' +
    '<h3>このグループの操作フロー (' + ch.flows.length + ')</h3>' + (ch.flows.length ? '<ul class="flows">' + ch.flows.map(flowItem).join('') + '</ul>' : '<p class="empty">なし</p>') +
    '<h3>エラーがある画面 (' + errIds.length + ')</h3>' + (errIds.length ? '<div class="chips">' + errIds.map(id => '<button class="chip err" data-go="' + id + '">' + esc(nameOf(byId.get(id))) + '</button>').join('') + '</div>' : '<p class="empty">なし</p>') +
    '<h3>他のグループへ</h3>' + (exits.length ? '<ul>' + exits.map(lk).join('') + '</ul>' : '<p class="empty">共通ナビ以外に出口はありません</p>') +
    '<h3>他のグループから</h3>' + (entries.length ? '<ul>' + entries.map(lk).join('') + '</ul>' : '<p class="empty">起点からのみ</p>') +
    (navGroups.length ? '<details><summary>共通ナビ（どの画面からでも行ける ' + navGroups.length + ' 件）</summary><ul>' + navGroups.map(g => '<li>' + esc(g.label) + ' <span class="to">→ ' + esc(nameOf(byId.get(g.to))) + '</span></li>').join('') + '</ul></details>' : '');
  bind();
}
function nodePanel(id, opts = {}) {
  const n = byId.get(id);
  const li = (d, dir) => { const other = byId.get(dir === 'out' ? d.to : d.from); const cnt = d.raw.length > 1 ? '<span class="cnt">×' + d.raw.length + '</span>' : ''; if (d.error) return '<li class="err">' + esc(d.full) + '<div class="pre">' + esc(d.error) + '</div></li>'; const otherCh = chapterOf(other.id); const tag = otherCh && chapter && otherCh.id !== chapter.id ? ' <span class="cnt">[' + esc(chapterName(otherCh)) + ']</span>' : ''; return '<li><button data-go="' + other.id + '" title="' + esc(d.full) + '">' + esc(d.short) + '</button>' + cnt + ' <span class="to">' + (dir === 'out' ? '→ ' : '← ') + esc(nameOf(other)) + '</span>' + tag + '</li>'; };
  const outs = E.filter(d => d.from === id && !d.nav), outsNav = E.filter(d => d.from === id && d.nav);
  const ins = E.filter(d => d.to === id && d.from !== id && !d.nav), insNav = E.filter(d => d.to === id && d.from !== id && d.nav);
  const list = (xs, empty) => xs.length ? '<ul>' + xs.join('') + '</ul>' : '<p class="empty">' + empty + '</p>';
  const navBlock = (xs, label) => xs.length ? '<details><summary>共通ナビ ' + xs.length + ' 件' + label + '</summary><ul>' + xs.join('') + '</ul></details>' : '';
  const chain = pathTo(id);
  const crumbs = '<div class="crumbs"><button data-go="' + G.root + '">起点</button>' + chain.map(d => '<span class="arrow">→</span><span class="step" title="' + esc(d.full) + '">' + esc(d.short) + '</span><span class="arrow">→</span><button data-go="' + d.to + '">' + esc(nameOf(byId.get(d.to))) + '</button>').join('') + '</div>';
  const prev = prevOf(id);
  const capture = isChanged(id) && prev
    ? '<div class="pair"><div><div class="cap">今回</div><img class="shot" src="' + esc(n.screenshot) + '" alt="今回" data-zoom></div><div><div class="cap">前回（' + esc(diff.previousRun) + '）</div><img class="shot" src="' + esc(prev.screenshot) + '" alt="前回" data-zoom></div></div>'
    : '<img class="shot" src="' + esc(n.screenshot) + '" alt="' + esc(n.title) + '" data-zoom>' + (prev ? '<details><summary>前回のキャプチャを見る</summary><img class="shot" src="' + esc(prev.screenshot) + '" alt="前回" data-zoom style="margin-top:6px"></details>' : '');
  const flowNav = opts.flow ? '<div class="navbtns"><button id="sb-prev"' + (step === 0 ? ' disabled' : '') + '>← 前へ</button><span class="muted">コマ ' + (step + 1) + ' / ' + flow.frames.length + '</span><button id="sb-next"' + (step >= flow.frames.length - 1 ? ' disabled' : '') + '>次へ →</button></div>' : '';
  const myFlows = scenarios.filter(s => s.frames.includes(id) && (!flow || s !== flow));
  panel.innerHTML =
    '<h2>' + esc(baseName(n)) + (subtitleOf(n) ? ' <span class="muted" style="font-weight:400">· ' + esc(subtitleOf(n)) + '</span>' : '') + '</h2>' +
    (exampleOf(n) ? '<div class="muted" style="margin:-2px 0 4px;font-size:12px" title="撮影したのはこの実例です。企業名・商品名などデータの部分を〇〇にした名前で表示しています">' + esc(exampleOf(n)) + '</div>' : '') +
    '<div class="url">' + esc(readable(n.url)) + '</div>' + (n.mergedUrls && n.mergedUrls.length ? '<details class="merged"><summary>同じ画面に合流した URL ' + n.mergedUrls.length + ' 件</summary><ul>' + n.mergedUrls.map(u => '<li><code>' + esc(pathOf(u)) + '</code></li>').join('') + '</ul></details>' : '') + (n.jevMerged && n.jevMerged.length ? '<details class="merged"><summary>Jev が同じ画面と判定して合流した URL ' + n.jevMerged.length + ' 件</summary><ul>' + n.jevMerged.map(m => '<li><code>' + esc(pathOf(m.url)) + '</code> <span class="cnt">' + m.score.toFixed(2) + '</span></li>').join('') + '</ul></details>' : '') + flowNav +
    '<h3>起点からの経路' + (chain.length ? '（' + chain.length + ' 回のクリック）' : '') + '</h3>' + (id === G.root ? '<p class="empty">この画面が起点です</p>' : crumbs) +
    '<h3>キャプチャ' + (isChanged(id) ? '（前回から内容が変わっています）' : '') + '</h3>' + capture +
    '<dl class="kv" style="margin-top:8px"><dt>グループ</dt><dd><button class="linkbtn" data-chapter="' + chapterOf(id).id + '" title="グループの木で開く">' + esc(chapterName(chapterOf(id))) + ' ↗</button></dd><dt>深さ</dt><dd>' + n.depth + '</dd><dt>操作</dt><dd>' + n.actionsTried + ' / ' + (n.actionsPlanned ?? n.actionsTotal) + ' 件を試行' + (n.actionsPlanned != null && n.actionsPlanned < n.actionsTotal ? '（列挙 ' + n.actionsTotal + ' 件を同種で畳んだ）' : '') + (n.actionsSkippedCommon ? '（共通の開閉操作 ' + n.actionsSkippedCommon + ' 件は他の画面で試したため省略）' : '') + '</dd>' + (n.route ? '<dt>ルート</dt><dd><code>' + esc(n.route) + '</code></dd>' : '') + (Array.isArray(n.headings) && n.headings.length ? '<dt>見出し</dt><dd>' + esc(n.headings.join(' / ')) + '</dd>' : '') + '<dt>シグネチャ</dt><dd><code>' + n.signature + '</code></dd>' + (n.truncated ? '<dt>打ち切り</dt><dd>' + esc(n.truncated) + '</dd>' : '') + '</dl>' +
    '<h3>この画面でできる操作</h3>' + list(outs.map(d => li(d, 'out')), n.truncated ? '（' + esc(n.truncated) + 'のため列挙していません）' : '画面が変わる操作はありませんでした') + navBlock(outsNav.map(d => li(d, 'out')), '') +
    (n.jevSkipped && n.jevSkipped.length ? '<h3 style="text-transform:none">Jev が危険と判定して押さなかった操作 (' + n.jevSkipped.length + ')</h3>' + list(n.jevSkipped.map(k => '<li>' + esc(k.label) + ' <span class="cnt">' + k.score.toFixed(2) + '</span></li>'), '') : '') +
    '<h3>ここへ来る操作</h3>' + list(ins.map(d => li(d, 'in')), n.id === G.root ? '起点' : 'なし') + navBlock(insNav.map(d => li(d, 'in')), '（他の画面から）') +
    (myFlows.length ? '<h3>この画面を通る操作フロー (' + myFlows.length + ')</h3><ul class="flows">' + myFlows.map(flowItem).join('') + '</ul>' : '') +
    '<h3>コンソールエラー (' + n.consoleErrors.length + ')</h3>' + (n.consoleErrors.length ? n.consoleErrors.map(e => '<div class="pre">' + esc(e) + '</div>').join('') : '<p class="empty">なし</p>') +
    '<h3>失敗したリクエスト (' + n.failedRequests.length + ')</h3>' + (n.failedRequests.length ? n.failedRequests.map(e => '<div class="pre">' + esc(e) + '</div>').join('') : '<p class="empty">なし</p>');
  bind();
  if (opts.flow) { panel.querySelector('#sb-prev').addEventListener('click', () => gotoStep(step - 1)); panel.querySelector('#sb-next').addEventListener('click', () => gotoStep(step + 1)); }
  panel.scrollTop = 0;
}
const helpEl = document.getElementById('help');
document.getElementById('help-btn').addEventListener('click', () => { helpEl.hidden = false; });
document.getElementById('help-close').addEventListener('click', () => { helpEl.hidden = true; });
helpEl.addEventListener('click', e => { if (e.target === helpEl) helpEl.hidden = true; });
const lb = document.getElementById('lightbox');
function zoom(src) { lb.querySelector('img').src = src; lb.hidden = false; }
lb.addEventListener('click', () => { lb.hidden = true; });
document.addEventListener('keydown', e => {
  if (mode === 'flow' && document.activeElement !== searchEl && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); gotoStep(step + (e.key === 'ArrowRight' ? 1 : -1)); return; }
  if (e.key !== 'Escape') return;
  if (!helpEl.hidden) { helpEl.hidden = true; return; }
  if (!lb.hidden) { lb.hidden = true; return; }
  if (document.activeElement === searchEl && searchEl.value) { searchEl.value = ''; query = ''; applyState(); if (mode === 'home') overviewPanel(); return; }
  if (selected && (mode === 'chapter' || mode === 'map')) { selected = null; applyState(); mode === 'chapter' ? chapterPanel() : overviewPanel(); commit(); return; }
  goUp();
});
// ---- URL ハッシュと履歴: 表示の切り替えを history に積み、戻る／進むと直リンクを効かせる ----
let routing = false;
function currentHash() {
  if (mode === 'chapter' && chapter) return '#g=' + encodeURIComponent(chapter.id) + (selected ? '&s=' + encodeURIComponent(selected) : '');
  if (mode === 'flow' && flow) return '#f=' + encodeURIComponent(flow.id) + '&k=' + step;
  if (mode === 'map') return '#map' + (selected ? '&s=' + encodeURIComponent(selected) : '');
  if (mode === 'issues') return '#issues';
  if (mode === 'home') return '#groups';
  return '#';
}
function commit(replace) {
  if (routing) return;
  const h = currentHash(); if (h === (location.hash || '#')) return;
  try { (replace ? history.replaceState : history.pushState).call(history, null, '', h); } catch { /* 履歴に積めない環境でも表示は続ける */ }
}
function applyHash(h) {
  const q = new URLSearchParams((h || '').replace(/^#/, '').replace(/^map/, 'map=1').replace(/^issues/, 'issues=1').replace(/^groups/, 'groups=1'));
  routing = true;
  try {
    if (q.get('g') && chapters.some(c => c.id === q.get('g'))) { openChapter(q.get('g'), q.get('s') && byId.has(q.get('s')) ? q.get('s') : null); return true; }
    if (q.get('f') && scenarios.some(sc => sc.id === q.get('f'))) { openFlow(q.get('f'), Number(q.get('k') || 0)); return true; }
    if (q.has('map')) { openMap(); if (q.get('s') && byId.has(q.get('s'))) selectNode(q.get('s')); return true; }
    if (q.has('issues')) { openIssues(); return true; }
    if (q.has('groups')) { goHome(); return true; }
    return false;
  } finally { routing = false; }
}
window.addEventListener('popstate', () => { if (!applyHash(location.hash)) { routing = true; try { goLanding(); } finally { routing = false; } } });
document.getElementById('compact-toggle').setAttribute('aria-pressed', String(!compact));
if (!applyHash(location.hash)) goLanding();
commit(true);
window.__flowmap = { LANDING, get originView() { return originView; }, E, parentOf, navEdgeCount, navGroups, subtitleOf, scenarios, chapters, chapterLinks, openChapter, openFlow, openMap, openIssues, issues, goHome, gotoStep, get mode() { return mode; }, get step() { return step; }, get selected() { return selected; }, get scale() { return scale; }, get compact() { return compact; }, get links() { return links; }, get items() { return items; }, labelVisible };
`;
