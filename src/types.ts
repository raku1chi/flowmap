import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PathRule, QueryParamMode } from './normalize.js';

// ---------- 設定 ----------

export interface FlowmapConfig {
  baseUrl: string;
  outDir: string;
  maxStates: number;
  maxDepth: number;
  maxActionsPerState: number;
  /** 同じ形の操作（一覧の各行のリンク等）を 1 画面で試す上限。0 で無制限 */
  maxActionsPerPattern: number;
  settleMs: number;
  /** リンクでない操作を別々の画面から試して、毎回その場の状態変化（開閉・モーダル）しか起きなければ、この回数以降は他の画面で試さない */
  maxLocalActionRepeats: number;
  /** 操作のあと、ブラウザの「戻る」で元の画面に戻れたら（シグネチャが一致したら）起点からの再現を省く */
  useBackNavigation: boolean;
  /** 骨格が 2 回続けて同じになるまで撮り直す上限ミリ秒。networkidle 後に描画するアプリの読み込み途中の撮影を防ぐ */
  stabilizeMs: number;
  viewport: { width: number; height: number };
  storageState: string | null;
  denyText: string[];
  denySelectors: string[];
  denyUrlPatterns: string[];
  /** URL パスの正規化ルール（デコード済みパスに順に適用）。`/companies/[^/]+` → `/companies/*` のように書く */
  pathRules: PathRule[];
  /** 同じ画面に同じ形の兄弟リンクが autoPathRulesMinSiblings 本以上あれば、その区間をデータとみなして自動で合流させる */
  autoPathRules: boolean;
  autoPathRulesMinSiblings: number;
  /** クエリの扱い。names: 名前だけ見て値は捨てる（既定）／ values: 値も見る／ ignore: クエリを無視 */
  queryParams: QueryParamMode;
  /** queryParams が names のときも値を画面の区別に使うパラメータ名（`?tab=...` など） */
  structuralParams: string[];
  fill: Record<string, string>;
  allowSubmit: boolean;
  allowedHosts: string[];
  /** Jev（typesafe.ai）による判定。既定は無効。有効にすると画面の要約を外部 API に送る（DESIGN.md §5・§7） */
  jev: JevConfig;
  /** ビューアでの画面名の上書き。キーはルート（`/company/*` や `/search?q`）、値は表示する名前（DESIGN.md §8） */
  screenNames: Record<string, string>;
}

export interface JevConfig {
  enabled: boolean;
  model: string;
  /** 危険と判定した操作を押さない（denyText に加える） */
  actions: boolean;
  /** 同じ区画の画面を、同じ画面と判定したら既存のノードに合流させる */
  pages: boolean;
  /** 機械的ルールが見つけたデータ区間の候補を、Jev が認めたときだけ学習する */
  dataSegments: boolean;
  /** この値以上なら押さない。安全側に倒すため低め */
  actionThreshold: number;
  /** この値以上なら合流・学習する。合流は画面を見落とす側の誤りなので高め */
  mergeThreshold: number;
}

export const DEFAULT_CONFIG: FlowmapConfig = {
  baseUrl: 'http://localhost:3000',
  outDir: 'flowmap-out',
  maxStates: 60,
  maxDepth: 6,
  maxActionsPerState: 25,
  maxActionsPerPattern: 3,
  settleMs: 600,
  maxLocalActionRepeats: 2,
  useBackNavigation: true,
  stabilizeMs: 2000,
  viewport: { width: 1280, height: 800 },
  storageState: null,
  denyText: ['ログアウト', '削除', '退会', 'logout', 'sign out', 'delete'],
  denySelectors: ['[data-flowmap-ignore]'],
  denyUrlPatterns: ['/logout', '/signout', '^mailto:', '^tel:'],
  pathRules: [],
  autoPathRules: true,
  autoPathRulesMinSiblings: 3,
  queryParams: 'names',
  structuralParams: [],
  fill: {
    email: 'flowmap@example.com',
    password: 'flowmap-pass-1234',
    text: 'flowmap テスト入力',
    number: '1',
    tel: '0312345678',
    search: 'flowmap',
  },
  allowSubmit: true,
  allowedHosts: ['localhost', '127.0.0.1'],
  jev: {
    enabled: false,
    model: 'jev-latest',
    actions: true,
    pages: true,
    dataSegments: true,
    actionThreshold: 0.5,
    mergeThreshold: 0.7,
  },
  screenNames: {},
};

export type ConfigOverrides = Partial<Pick<FlowmapConfig, 'baseUrl' | 'outDir' | 'maxStates' | 'maxDepth' | 'storageState'>> & {
  /** --jev で Jev を有効にする */
  jev?: boolean;
};

/** flowmap.config.json（あれば）→ 既定値にマージ → CLI 上書きの順で設定を組み立てる */
export function loadConfig(configPath: string | undefined, overrides: ConfigOverrides): FlowmapConfig {
  const path = resolve(configPath ?? 'flowmap.config.json');
  let fromFile: Partial<FlowmapConfig> = {};
  if (existsSync(path)) {
    fromFile = JSON.parse(readFileSync(path, 'utf8')) as Partial<FlowmapConfig>;
  } else if (configPath) {
    throw new Error(`設定ファイルが見つかりません: ${path}`);
  }
  const cleanOverrides = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  return {
    ...DEFAULT_CONFIG,
    ...fromFile,
    ...cleanOverrides,
    viewport: { ...DEFAULT_CONFIG.viewport, ...(fromFile.viewport ?? {}) },
    fill: { ...DEFAULT_CONFIG.fill, ...(fromFile.fill ?? {}) },
    jev: { ...DEFAULT_CONFIG.jev, ...(fromFile.jev ?? {}), ...(overrides.jev ? { enabled: true } : {}) },
  };
}

// ---------- graph.json ----------

export interface ActionDesc {
  label: string;
  kind: 'click' | 'submit';
  role: string;
  text: string;
  href?: string;
  nth: number;
}

export interface StateNode {
  id: string;
  signature: string;
  url: string;
  /** シグネチャに使った正規化済みパス（例 `/companies/*?axes`）。データ区間は `*` */
  route?: string;
  title: string;
  depth: number;
  screenshot: string;
  textHash: string;
  headings: string[]; // 可視の h1〜h3。同じタイトルの画面を区別する副題に使う
  consoleErrors: string[];
  failedRequests: string[];
  /** 列挙した操作数 */
  actionsTotal: number;
  /** 同じ形の操作を畳んだあとに試す予定の操作数（省略時は actionsTotal と同じ） */
  actionsPlanned?: number;
  actionsTried: number;
  /** 共通の開閉 UI とみなして省いた操作数（他の画面で既に試したもの） */
  actionsSkippedCommon?: number;
  /** このノードに合流した別 URL（最初に到達した url と異なるもの。最大 50 件） */
  mergedUrls?: string[];
  /**
   * 同じルートで合流した別の実例（最大 20 件）。ビューアが実例どうしのタイトルと見出しを比べて、
   * 企業名・商品名などデータの部分を〇〇に置き換えた画面名を作るのに使う（DESIGN.md §8）
   */
  samples?: { url: string; title: string; heading?: string }[];
  /** Jev が同じ画面と判定して合流させた状態のシグネチャ。実行間の比較（§10）でもこのノードのシグネチャとして扱う */
  aliasSignatures?: string[];
  /** Jev が同じ画面と判定して合流させた URL と、そのときの値（最大 50 件） */
  jevMerged?: { url: string; score: number }[];
  /** Jev がサーバーのデータを変えると判定して押さなかった操作 */
  jevSkipped?: { role: string; label: string; score: number }[];
  truncated?: string;
}

export interface Edge {
  from: string;
  to: string;
  action: ActionDesc;
  error?: string;
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
  /** 比較の前提が崩れているときの注意書き（前回と Jev の有無が違うなど） */
  warning?: string;
}

export interface Graph {
  meta: {
    baseUrl: string;
    startedAt: string;
    finishedAt: string;
    totalStates: number;
    totalEdges: number;
    stoppedBecause?: string;
    /** 探索中に自動学習したデータ区間（`/companies/*` の形）。設定 pathRules に書き写せば次回から明示的になる */
    learnedPathRules?: string[];
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
