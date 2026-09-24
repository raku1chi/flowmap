import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------- 設定 ----------

export interface FlowmapConfig {
  baseUrl: string;
  outDir: string;
  maxStates: number;
  maxDepth: number;
  maxActionsPerState: number;
  settleMs: number;
  viewport: { width: number; height: number };
  storageState: string | null;
  denyText: string[];
  denySelectors: string[];
  denyUrlPatterns: string[];
  fill: Record<string, string>;
  allowSubmit: boolean;
  allowedHosts: string[];
}

export const DEFAULT_CONFIG: FlowmapConfig = {
  baseUrl: 'http://localhost:3000',
  outDir: 'flowmap-out',
  maxStates: 60,
  maxDepth: 6,
  maxActionsPerState: 25,
  settleMs: 600,
  viewport: { width: 1280, height: 800 },
  storageState: null,
  denyText: ['ログアウト', '削除', '退会', 'logout', 'sign out', 'delete'],
  denySelectors: ['[data-flowmap-ignore]'],
  denyUrlPatterns: ['/logout', '/signout', '^mailto:', '^tel:'],
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
};

export type ConfigOverrides = Partial<Pick<FlowmapConfig, 'baseUrl' | 'outDir' | 'maxStates' | 'maxDepth' | 'storageState'>>;

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
  title: string;
  depth: number;
  screenshot: string;
  textHash: string;
  headings: string[]; // 可視の h1〜h3。同じタイトルの画面を区別する副題に使う
  consoleErrors: string[];
  failedRequests: string[];
  actionsTotal: number;
  actionsTried: number;
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
}

export interface Graph {
  meta: {
    baseUrl: string;
    startedAt: string;
    finishedAt: string;
    totalStates: number;
    totalEdges: number;
    stoppedBecause?: string;
  };
  root: string;
  nodes: StateNode[];
  edges: Edge[];
  diff?: Diff;
}
