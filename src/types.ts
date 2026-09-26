import type { PathRule, QueryParamMode } from './normalize.js';

// ---------- 設定 ----------
// 既定値・読み込み・検証は config.ts。ここは形だけを定義する（キーの意味は DESIGN.md §11）。

/** CI のゲートに使う条件（§10）。`flowmap explore --fail-on new-errors,removed` */
export type GateKind = 'new-errors' | 'removed' | 'errors' | 'failed-actions';

export interface FlowmapConfig {
  baseUrl: string;
  outDir: string;

  // ---- 上限（§4） ----
  maxStates: number;
  maxDepth: number;
  maxActionsPerState: number;
  /** 同じ形の操作（一覧の各行のリンク等）を 1 画面で試す上限。0 で無制限 */
  maxActionsPerPattern: number;
  /** リンクでない共通操作（ヘッダの開閉等）を別々の画面から試す回数。結果が毎回その場の変化だけなら、以後の画面では試さない */
  maxLocalActionRepeats: number;
  /** 同じ行き先のリンクを別々の画面から試す回数。毎回同じ画面に着けば、以後の画面では押さずに辺を推定する。0 で常に押す */
  maxLinkRepeats: number;
  /** 探索全体の時間の上限（分）。0 で無制限。到達したらそこまでの結果を書き出して止める */
  maxDurationMinutes: number;

  // ---- 実行（§4） ----
  /** 並列に動かすブラウザコンテキストの数。結果は並列数によらず同じになる */
  workers: number;
  /** 画面が落ち着いたあとに追加で待つミリ秒 */
  settleMs: number;
  /** 通信が途切れ DOM の変化が止まってから、この時間続けば落ち着いたとみなす */
  quietMs: number;
  /** 落ち着くのを待つ上限ミリ秒 */
  settleTimeoutMs: number;
  /** 落ち着かなかった画面で、骨格が 2 回続けて同じになるまで撮り直す上限ミリ秒 */
  stabilizeMs: number;
  /** クリックの上限ミリ秒 */
  actionTimeoutMs: number;
  /** ページ読み込みの上限ミリ秒 */
  navigationTimeoutMs: number;
  /** リンクで遷移した後、ストレージが変わっていなければ「戻る」で元の画面に戻り、起点からの再現を省く（一致を確かめたときだけ） */
  useBackNavigation: boolean;
  /** 別オリジンへのリンクを押して撮影するか。既定 false（外部サイトは撮らず、画面ごとにリンクの一覧だけ残す） */
  followExternalLinks: boolean;
  /**
   * 画面の中で完結する変化（比較パネルへの追加・開閉を開く・並べ替えなど）を別の画面にせず、元の画面に吸収する。
   * 変化で現れた操作（「比較ページで開く」など）は、元の画面からの続けての操作として探索する。既定 true（DESIGN.md §4）
   */
  absorbLocalChanges: boolean;
  viewport: { width: number; height: number };
  fullPageScreenshots: boolean;
  locale: string;
  timezoneId: string | null;
  headless: boolean;
  /** Playwright の channel（chrome, msedge など）。null なら同梱の Chromium */
  browserChannel: string | null;
  serviceWorkers: 'block' | 'allow';
  /** 送らせないリクエストの URL（正規表現）。解析タグなど。指定するとブラウザの HTTP キャッシュが無効になる */
  blockUrlPatterns: string[];

  // ---- 認証（§6） ----
  storageState: string | null;
  /** ログイン画面の URL（正規表現）。探索中にここへ連続して着いたら認証切れとして止める */
  loginUrlPattern: string | null;

  // ---- 安全（§7） ----
  denyText: string[];
  denySelectors: string[];
  denyUrlPatterns: string[];
  allowSubmit: boolean;
  allowedHosts: string[];
  /** alert / confirm / beforeunload を受け入れるか断るか */
  dialogs: 'accept' | 'dismiss';
  /** フォームの自動入力値。キーは input の type か `name=<name属性>` */
  fill: Record<string, string>;

  // ---- 画面の同定（§5） ----
  /** URL パスの正規化ルール（デコード済みパスに順に適用）。`^/companies/[^/]+` → `/companies/*` のように書く */
  pathRules: PathRule[];
  /** 同じ画面に同じ形の兄弟リンクが autoPathRulesMinSiblings 本以上あれば、その区間をデータとみなして合流させる */
  autoPathRules: boolean;
  autoPathRulesMinSiblings: number;
  /** クエリの扱い。ignore: 画面の区別に使わない（既定）／ names: 名前だけ見る／ values: 値も見る */
  queryParams: QueryParamMode;
  /** queryParams によらず値を画面の区別に使うパラメータ名（`?tab=...` など） */
  structuralParams: string[];
  /** 値がデータ（レコードの ID など）のパラメータ名。`/item?id=12` を `/item?id=*` として合流させる */
  dataParams: string[];
  /** 画面の同定と本文の比較から外す要素（時計・おすすめ枠など、開くたびに変わる部分）。操作は探索する */
  volatileSelectors: string[];
  /** 撮影と操作の前に非表示にする要素（Cookie の同意バナー、チャットの窓など） */
  hideSelectors: string[];

  // ---- 出力（§9・§10） ----
  /** graph.json と index.html に残す URL で値を伏せるクエリ名（大小無視、* は任意の文字列） */
  maskUrlParams: string[];
  /** 比較対象の実行ディレクトリ（または graph.json）。null なら同じ outDir の直前の実行 */
  baseline: string | null;
  /** 終了コード 1 にする条件 */
  failOn: GateKind[];
  /** ビューアでの画面名の上書き。キーはルート（`/company/*` や `/search?q`）、値は表示する名前（DESIGN.md §8） */
  screenNames: Record<string, string>;
  /** Jev（typesafe.ai）による判定。既定は無効。有効にすると画面の要約を外部 API に送る（DESIGN.md §5・§7） */
  jev: JevConfig;
}

export interface JevConfig {
  enabled: boolean;
  model: string;
  /** 危険と判定した操作を押さない（denyText に加える）。既定 true */
  actions: boolean;
  /**
   * 同じ区画の画面を、同じ画面と判定したら既存のノードに合流させる。既定 false。
   * 判定は実行ごとに揺れうるので、有効にすると画面の同定が決定的でなくなる（キャッシュが無い CI で差分が揺れる）
   */
  pages: boolean;
  /** 機械的ルールが見つけたデータ区間の候補を、Jev が認めたときだけ学習する。既定 false（理由は pages と同じ） */
  dataSegments: boolean;
  /** この値以上なら押さない。安全側に倒すため低め */
  actionThreshold: number;
  /** この値以上なら合流・学習する。合流は画面を見落とす側の誤りなので高め */
  mergeThreshold: number;
}

// ---------- graph.json（§9） ----------

/** graph.json の形の版。項目を足したり意味を変えたりしたら上げる */
export const SCHEMA_VERSION = 3;
/** シグネチャの計算方法の版。変えると前回との比較で「消失＋追加」が出るので、差分に注意書きを付ける */
export const SIGNATURE_VERSION = 3;

export interface ActionDesc {
  label: string;
  kind: 'click' | 'submit';
  role: string;
  text: string;
  href?: string;
  nth: number;
  /** 開閉・ポップアップの操作（ラベルに今の値が出ることがあるので、画面の同定ではラベルを見ない） */
  toggle?: boolean;
  /** data-testid などの識別子。経路の再生で要素を見つけ直すのに使う */
  testId?: string;
  /** 検索フォームの送信（データを変えない送信） */
  search?: boolean;
}

export interface StateNode {
  id: string;
  signature: string;
  url: string;
  /** シグネチャに使った正規化済みパス（例 `/companies/*`）。データ区間は `*`。外部サイトには無い */
  route?: string;
  title: string;
  depth: number;
  screenshot: string;
  textHash: string;
  headings: string[]; // 可視の h1〜h3。同じタイトルの画面を区別する副題に使う
  /** 開いているダイアログの名前（ダイアログが無ければ無し） */
  dialog?: string;
  /** 開いている開閉（メニュー・details など）のラベル。同じ画面の開いた状態をビューアで見分ける */
  expanded?: string[];
  consoleErrors: string[];
  failedRequests: string[];
  /** 列挙した操作数 */
  actionsTotal: number;
  /** 同じ形の操作を畳んだあとに試す予定の操作数（省略時は actionsTotal と同じ） */
  actionsPlanned?: number;
  actionsTried: number;
  /** 共通の開閉 UI とみなして省いた操作数（他の画面で既に試したもの） */
  actionsSkippedCommon?: number;
  /** 他の画面で行き先を確かめたので、押さずに辺を推定した操作数 */
  actionsInferred?: number;
  /** このノードに合流した別 URL（最初に到達した url と異なるもの。最大 50 件） */
  mergedUrls?: string[];
  /**
   * 同じルートで合流した別の実例（最大 20 件）。ビューアが実例どうしのタイトルと見出しを比べて、
   * 企業名・商品名などデータの部分を〇〇に置き換えた画面名を作るのに使う（DESIGN.md §8）
   */
  samples?: { url: string; title: string; heading?: string }[];
  /** 起点から経路を再現したとき、この画面と骨格が一致しなかった回数と、最初に見つかった違い */
  unstable?: { count: number; onlyHere: string[]; onlyReplayed: string[] };
  /** Jev が同じ画面と判定して合流させた状態のシグネチャ。実行間の比較（§10）でもこのノードのシグネチャとして扱う */
  aliasSignatures?: string[];
  /** Jev が同じ画面と判定して合流させた URL と、そのときの値（最大 50 件） */
  jevMerged?: { url: string; score: number }[];
  /** Jev がサーバーのデータを変えると判定して押さなかった操作 */
  jevSkipped?: { role: string; label: string; score: number }[];
  /**
   * この画面の中で完結する操作（押しても別の画面にならない操作）。同じ形の操作は 1 件にまとめる（DESIGN.md §4・§8）。
   * 地図には描かず、ビューアの右パネルに一覧する
   */
  localActions?: LocalAction[];
  /** 押さなかった別オリジンへのリンク（followExternalLinks が false のとき。最大 30 件） */
  externalLinks?: { label: string; href: string }[];
  truncated?: string;
}

/** 画面の中で完結する操作の記録（同じ形の操作をまとめたもの） */
export interface LocalAction {
  /** 同じ形の操作を束ねるキー（`button|*を並べて比べる` など） */
  key: string;
  /** 代表の操作（最初に押したもの） */
  action: ActionDesc;
  /** 行ごとの同種の操作を畳んだ形（`*を並べて比べる`）。ラベルにデータを含む操作だけ */
  pattern?: string;
  /** この画面にある同じ形の操作の数 */
  count: number;
  /** 押した数（残りは 1 件目の結果から同じと判断して押していない） */
  tried: number;
  /** 画面の骨格が変わったか。false なら押しても再表示だけ（ページ送り・変化のないボタン） */
  changed: boolean;
  /** 変化で新しく現れた操作のラベル（最大 8 件）。これらは続けて押して探索する */
  revealed?: string[];
  /** 変化のあとのスクリーンショット（形ごとに 1 枚） */
  screenshot?: string;
}

export interface Edge {
  from: string;
  to: string;
  action: ActionDesc;
  error?: string;
  /** 押さずに、他の画面での結果から推定した辺（共通のナビゲーション） */
  inferred?: true;
  /**
   * 先に押した、その場の変化を起こす操作（元の画面から順に）。変化で現れた操作 action を押すために通る。
   * 「並べる → 比較ページで開く」の「並べる」
   */
  via?: ActionDesc[];
}

export interface RemovedNode {
  url: string;
  title: string;
  screenshot: string;
  signature: string;
}

export interface Diff {
  previousRun: string;
  added: string[];
  removed: RemovedNode[];
  changed: string[];
  newErrors: string[];
  /** シグネチャが一致した画面の、前回のキャプチャと textHash（今回のノード id → 前回の情報）。変化画面の比較表示に使う */
  previous?: Record<string, { screenshot: string; textHash: string }>;
  /** 比較の前提が崩れているときの注意書き（前回とシグネチャの版や Jev の有無が違う、探索が途中で止まった など） */
  warning?: string;
  /** 消失と追加が比較の前提の違いを含む（シグネチャの版・Jev の有無の違い、今回の探索の中断）。CI のゲートで消失を数えない */
  unreliable?: true;
}

export interface RunStats {
  /** 試した操作の数 */
  attempts: number;
  /** 起点から経路を再現した回数 */
  replays: number;
  /** 「戻る」で元の画面に戻れて再現を省いた回数 */
  backReturns: number;
  /** 押さずに推定した辺の数 */
  inferredEdges: number;
  /** 共通の開閉 UI とみなして省いた操作の数 */
  skippedCommon: number;
  /** 経路を再現した画面が元の画面と一致しなかった回数 */
  replayDrift: number;
  /** その場の変化として元の画面に吸収した回数 */
  localChanges?: number;
  /** その場の変化で現れた操作を続けて押した回数 */
  revealedTried?: number;
  /** 部品（比較パネルなど）が開いたままの画面を、既存の画面に合流させた回数 */
  variantJoins?: number;
  /** 同じ画面の同じ形の操作で、1 件目がその場の変化だったので押さなかった数 */
  skippedRepeats?: number;
  workers: number;
  durationMs: number;
}

export interface Graph {
  meta: {
    schemaVersion?: number;
    signatureVersion?: number;
    tool?: string;
    baseUrl: string;
    startedAt: string;
    finishedAt: string;
    totalStates: number;
    totalEdges: number;
    stoppedBecause?: string;
    /** 途中で止めた種類。maxStates は毎回同じところで止まるので比較に使えるが、それ以外は「消失」に未到達の画面が混ざる */
    stopKind?: 'maxStates' | 'maxDuration' | 'interrupted' | 'error' | 'auth' | 'unreachable';
    /** 探索中に自動学習したデータ区間（`/companies/*` の形）。設定 pathRules に書き写せば次回から明示的になる */
    learnedPathRules?: string[];
    /** 探索中に学習した「クエリで絞り込む一覧」のルート。h1 をデータとみなして絞り込み違いを合流させた */
    learnedQueryVariants?: string[];
    stats?: RunStats;
    /** 比較の前提になる設定（探索の範囲と画面の同定に効くものだけ。認証情報は含めない） */
    config?: Record<string, unknown>;
    /** Jev を使ったときの集計 */
    jev?: {
      model: string;
      requests: number;
      cacheHits: number;
      errors: number;
      lastError?: string;
      skippedActions: number;
      mergedStates: number;
      /** 機械的ルールが見つけたが Jev が認めなかったデータ区間の候補 */
      rejectedPathRules: string[];
    };
  };
  root: string;
  nodes: StateNode[];
  edges: Edge[];
  diff?: Diff;
}
