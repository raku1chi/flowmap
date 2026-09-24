# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 現状

flowmap は「SPA を自動探索して画面遷移をフローチャートとスクリーンショットで一望する」ツール。
設計の情報源は `DESIGN.md`、実行手順は `README.md`。本ファイルはその要点と、複数章を読まないと分からない不変条件だけを書く。

- 実装は `src/` の 4 ファイル（types / explore / render / cli）。TypeScript を tsx で直接実行し、ビルド工程はない。
- `demo/` はビルド不要のデモ SPA（Node の http サーバー + vanilla JS）。flowmap の設計要素を一通り踏む画面を持つ。
- テストは未整備。動作確認は「デモを探索して index.html を開く」で行う。

## コマンド

```sh
pnpm install && pnpm exec playwright install chromium   # 初回のみ
pnpm typecheck                 # tsc --noEmit
pnpm demo                      # デモアプリを http://localhost:3210 で起動（DEMO_BREAK=1 で商品 API を壊す）
pnpm explore                   # flowmap.config.json を読んで探索 → flowmap-out/runs/<ISO日時>/ に出力し index.html も生成
pnpm explore --url <URL> --storage auth.json --max-states 30 --no-render
pnpm render flowmap-out/runs/<dir>   # graph.json からビューアだけ再生成
```

CLI 面は `explore` と `render` の 2 つだけで、これ以外のサブコマンドは増やさない方針（§3）。
リポジトリ直下の `flowmap.config.json` はデモ用（起点 localhost:3210）。

### 実装上の注意

- `page.evaluate` に渡す関数（`snapshotInBrowser` / `fillFormsInBrowser`）は外側スコープを参照しない自己完結の関数として書く。tsx(esbuild) が挿入する `__name` ヘルパーはブラウザに無いので、`context.addInitScript` で恒等関数を定義している。
- ビューアの HTML/CSS/JS は `render.ts` 内の文字列。graph.json は `<` を `\u003c` にエスケープして `<script type="application/json">` に埋め込む。
- ビューアのレイアウトは「各ノードに最初に到達した辺（発見辺）」を木とみなす tidy tree。探索が幅優先なので発見辺の from は必ず depth-1 のノードになり、列 = 深さと矛盾しない。探索順を変えるときはこの前提を崩さないこと。
- ビューアの着地は画面数で決まる（`LANDING_MAX_TREE` = 40 以下ならサムネイルなしの全画面の木、超えたらグループ図）。木はサムネイルなしが既定で、これは「構造は木で読み、絵は右パネルで見る」という役割分担による。
- ビューアの読む単位は「グループ」と「操作フロー」で、全画面の木は索引。グループ = 探索の木で起点の子ごとの部分木（起点と同じ URL の状態は起点のグループ）。グループをまたぐ辺のうち共通ナビは関係図にも札にも出さない。ここを崩すとグループの関係図が完全グラフになる。コード上の識別子は chapter のまま。
- ビューアは「ほぼ全画面から同じ行き先へ向かう辺」を共通ナビとして畳む（既定で非表示、トグルで表示）。各ノードに最初に到達した発見辺と失敗した辺は畳まない。この不変条件を崩すと到達経路の見えないノードができる。
- `render.ts` 内に U+2028/2029 のリテラルを書くと esbuild が正規表現の終端と誤認する。`String.fromCharCode` で扱うこと。

## アーキテクチャ（§3）

探索エンジン・グラフモデル・ビューアの 3 層を **graph.json で切る**。レンダラは graph.json だけから index.html を描けるので、探索をやり直さずに見た目だけ直せる。

| モジュール | ファイル | 役割 |
| --- | --- | --- |
| 設定 | src/types.ts | `flowmap.config.json` の読み込み・既定値・CLI 引数による上書き（設定キー一覧は §11） |
| 探索エンジン | src/explore.ts | Playwright で幅優先探索、操作対象の列挙、シグネチャ算出、撮影、エラー収集、前回実行との差分計算 |
| レンダラ | src/render.ts | graph.json → 単体で開ける index.html |
| CLI | src/cli.ts | explore / render |

出力は 1 実行 1 ディレクトリ: `flowmap-out/runs/<ISO日時>/{graph.json, shots/sNNN.png, index.html}`。
差分は既定で同じ outDir 内の直前の実行と比較する（`--baseline` は追加予定）。graph.json のスキーマ（meta / nodes / edges / diff）は §9。

## 変更時に守る不変条件

- **画面の同一性はシグネチャで決まる**（§5）。`sha1(normalize(path) ‖ structure)`、数字は `#` に正規化して `/items/12` と `/items/34` を 1 ノードに合流させる。ここを緩めるとノードが無限に増え、厳しくすると別画面が混ざる。設計の要なので変更は慎重に。
- **ノード id（s001…）は実行ごとに振り直される。実行間の比較は必ずシグネチャで行い、id を突き合わせてはいけない**（§9）。
- 「変化」= シグネチャ同一で textHash が違う画面。データ差でも点灯する参考情報なので **CI のゲート条件に入れない**（§10）。ゲートは「新エラー」と「消失」のみ。
- 骨格が変わった画面は「消失＋追加」の組で出る。これは誤検知ではなく仕様（§10）。
- モーダルは意図的に別ノードにする（§5）。
- **探索はブラウザの「戻る」を使わず、毎回起点から経路を再現する**（§4）。SPA では履歴の戻りが状態を正しく戻さないため。
- **認証は storageState のみ**。ツールにログイン手順を持たせず、ID・パスワードを `flowmap.config.json` に書かない。storageState ファイルは `.gitignore` に入れる（§6）。
- **探索は本物のクリックと送信を行う。本番環境には向けない。** 安全層は `denyText` / `denySelectors`（`[data-flowmap-ignore]`）/ `denyUrlPatterns`、別オリジンは撮影のみで操作しない、画面数・深さ・操作数・タイムアウトの上限（§7）。除外文言の既定を削らないこと。
- ビューアは**外部ライブラリなしの単体 HTML**で、graph.json を埋め込んで生成する。ファイルを開くだけで動くことが要件（§8）。
- 生成物（index.html / graph.json）に認証情報を含めない（§6）。

## 参考

- 拡張候補の優先順位（`--baseline`・認証切れ検知 → ピクセル比較 → 入力パターン → 並列化 …）と週次計画は §12〜§13。
