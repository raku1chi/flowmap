// 探索の司令塔（DESIGN.md §4）。
//
// 探索は深さごとの幅優先で、各画面の操作を 1 つずつ試し、着いた先が新しい画面なら次の深さに回す。
// 正しさは次の 3 つで担保する。
//   1. 起点からの再現は、毎回 storageState だけを持った新しいブラウザコンテキストで行う（前の試行の localStorage・Cookie を持ち越さない）
//   2. 試行はワーカーで並列に走らせるが、結果は決まった順番（画面の順 → 操作の順）で 1 つずつ取り込む。
//      ノード id・発見辺・学習の順番は並列数やタイミングによらず同じになる
//   3. 再現した画面が元の画面と一致したかをシグネチャで確かめる。「戻る」は一致を確かめたときだけ近道として使う
//
// 同じ画面を何度も辿らないために、共通の操作（ヘッダのリンクや開閉）は別々の画面から数回試して結果が毎回同じなら、
// 以後の画面では押さずに辺を推定するか（リンク）、省く（その場の開閉）。
//
// 画面の中で完結する変化（比較パネルへの追加・開閉・並べ替え）は別の画面にせず、元の画面に吸収して「この画面の中の操作」として
// 記録する。変化で新しく現れた操作（「比較ページで開く」）は、元の画面から「並べる → 比較ページで開く」と続けて押して探索する。
// 変化で現れた部品（比較パネル）がストレージに残って他の画面にも出るときは、部品を除けば同じ既存の画面に合流させる。

import { chromium, type Browser } from 'playwright';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configSummary } from './config.js';
import { computeDiff, findBaseline, type BaselineRef } from './diff.js';
import type { RawAction, Snapshot } from './inpage.js';
import { clip, JevJudge, maskedPath } from './jev.js';
import { maskUrl, maskUrlsInText, paramMatcher } from './mask.js';
import {
  actionKey, documentUrl, isLocalChange, labelKey, lineMatcher, planActions, proposeDataSegments, proposeQueryVariantPaths, sha1, signatureOf, structureDiff, variantOf,
  type NormalizeContext, type SignatureResult,
} from './normalize.js';
import { ActionError, describeAction, PROFILE, Session, type StorageStateObject } from './session.js';
import { SCHEMA_VERSION, SIGNATURE_VERSION, type ActionDesc, type Edge, type FlowmapConfig, type Graph, type LocalAction, type RunStats, type StateNode } from './types.js';

export class ExploreError extends Error {
  constructor(message: string, readonly kind: 'browser' | 'unreachable' | 'auth' | 'baseline' | 'storage' | 'jev') {
    super(message);
    this.name = 'ExploreError';
  }
}

export interface ExploreOptions {
  config: FlowmapConfig;
  log?: (msg: string) => void;
  /** 中断（Ctrl-C）。中断してもそこまでの結果は書き出す */
  signal?: AbortSignal;
  /** 操作ごとのログを出さない（深さごとの進み具合と結果だけ） */
  quiet?: boolean;
}

export interface ExploreResult {
  runDir: string;
  graph: Graph;
}

type StopKind = NonNullable<Graph['meta']['stopKind']>;
/** ノードの代表のスナップショット（本文は持たない）。学習で正規化が変わったときにシグネチャを計算し直すのに使う */
type Rep = Snapshot;

interface Planned {
  action: ActionDesc;
  /** 共通の操作として数えるキー（推定・省略の対象になるもの）。対象外なら undefined */
  key?: string;
  /** 先に押す、その場の変化を起こす操作（元の画面から順に）。変化で現れた action を押すために通る */
  via?: ActionDesc[];
  /** この画面の同じ形の操作の 1 件目（`ノード|形`）。結果を 2 件目以降の判断に使う */
  fam?: string;
  /** この画面の同じ形の操作の 2 件目以降。1 件目がその場の変化だったら押さない */
  dupOf?: string;
  /** 変化で現れた操作を選ぶときに除く操作の形（元の画面と、途中の状態にあったもの） */
  seen?: Set<string>;
  /** 続けて押す操作の組の形（`途中の操作の形>操作の形`）。結果がその場の変化だけなら、他の画面では同じ組を押さない */
  ckey?: string;
}

interface Outcome {
  error?: string;
  kind?: 'navigation' | 'replay' | 'action' | 'internal';
  snap?: Snapshot;
  /** 撮影したスクリーンショットの一時ファイル（未知の画面のときだけ撮る） */
  shot?: string;
  errors: { consoleErrors: string[]; failedRequests: string[] };
  storageChanged?: boolean;
  drift?: { onlyHere: string[]; onlyReplayed: string[] };
  substituted?: boolean;
}

interface Task {
  /** A: 先に試す操作 / B: 保留した共通の操作のうち、結果がばらついたので試すもの / C: その場の変化で現れた操作 */
  phase: 'A' | 'B' | 'C';
  seq: number;
  node: string;
  path: ActionDesc[];
  items: Planned[];
}

type CommonOutcome = 'local' | 'error' | { nav: string };
interface CommonStat {
  /** この操作を試す（試した）画面。別々の画面から数える */
  sources: Set<string>;
  outcomes: CommonOutcome[];
}

/** 1 つのワーカーが続けて試す操作の数。この中では「戻る」の近道が使える。並列数によらず固定なので結果は変わらない */
const CHUNK = 4;
const MAX_SAMPLES = 20;
const MAX_MERGED = 50;
/** 起点に続けて接続できなかったら止める回数 */
const NAV_FAILURE_LIMIT = 5;
/** ログイン画面に続けて着いたら認証切れとみなす回数 */
const LOGIN_REPEAT_LIMIT = 3;
/** Jev の操作判定で、リンク（GET の遷移）を止める閾値。ボタンなどは設定の jev.actionThreshold */
const LINK_ACTION_THRESHOLD = 0.7;
/** その場の変化を続けて起こす段数の上限（「メニュー → サブメニュー → リンク」の 2 段まで） */
const MAX_VIA = 2;
/** 1 回のその場の変化で現れた操作のうち、続けて押す数の上限 */
const MAX_REVEALED = 8;
/** 1 画面に記録する「この画面の中の操作」の上限 */
const MAX_LOCAL_ACTIONS = 30;
/** 1 画面に覚えておく、吸収した状態の数（同じ状態に着いたら元の画面とすぐ分かるように） */
const MAX_LOCAL_REPS = 20;
/** 部品（その場の変化で現れた行）を学ぶ元にする変化の数の上限 */
const MAX_WIDGET_PAIRS = 200;
/** 1 画面に記録する外部リンクの上限 */
const MAX_EXTERNAL_LINKS = 30;

const EMPTY_ERRORS = () => ({ consoleErrors: [] as string[], failedRequests: [] as string[] });
const firstLine = (e: unknown): string => String((e as Error)?.message ?? e).split('\n')[0];
const readableUrl = (u: string): string => { try { return decodeURI(u); } catch { return u; } };
/** 実例・合流した URL として残す形。ページ内のアンカー違い（#breakdown）は同じ実例なので区別しない */
const instanceUrl = (u: string): string => readableUrl(documentUrl(u));
const round2 = (x: number) => Math.round(x * 100) / 100;

function timestampDir(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

export const TOOL_VERSION = (() => {
  try { return 'flowmap ' + (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version; } catch { return 'flowmap'; }
})();

function toDesc(a: RawAction): ActionDesc {
  const d: ActionDesc = { label: a.label, kind: a.kind, role: a.role, text: a.text, nth: a.nth };
  if (a.href !== undefined) d.href = a.href;
  if (a.toggle) d.toggle = true;
  if (a.testId) d.testId = a.testId;
  if (a.search) d.search = true;
  return d;
}

const isHttp = (href: string | undefined, base: string): boolean => {
  if (!href) return false;
  try { return /^https?:$/.test(new URL(href, base).protocol); } catch { return false; }
};

/**
 * 状態を変えない操作か（リンクの遷移・タブ・開閉・検索フォームの送信）。起点からこういう操作だけで来た画面は「きれい」で、
 * そこでの共通の操作の結果は他のきれいな画面でも同じとみなせる。ボタンや送信を経た画面ではカートの中身などが違いうるので推定しない
 */
function isCleanAction(a: ActionDesc): boolean {
  if (a.kind === 'submit') return !!a.search;
  if (a.href && !/^javascript:/i.test(a.href)) return true;
  return a.role === 'tab' || !!a.toggle;
}

class Explorer {
  readonly nodes: StateNode[] = [];
  readonly byId = new Map<string, StateNode>();
  readonly edges: Edge[] = [];
  readonly learned: string[] = [];
  readonly ctx: NormalizeContext;
  readonly stats: RunStats;
  stop?: { kind: StopKind; reason: string };
  root = '';

  private index = new Map<string, string>(); // シグネチャ → ノード id
  private redirects = new Map<string, string>(); // 合流させて消したノード → 残したノード
  private reps = new Map<string, Rep>();
  private aliasReps = new Map<string, Rep[]>();
  private paths = new Map<string, ActionDesc[]>();
  private plans = new Map<string, Planned[]>();
  private dirty = new Map<string, boolean>();
  private common = new Map<string, CommonStat>();
  private cut = new Map<string, number>();
  private runCount = new Map<string, number>();
  private rejected = new Set<string>();
  private warned = new Set<string>();
  private headed = new Set<string>();
  /** 学習したクエリ違いの一覧のルート（graph.json の meta に残す） */
  private learnedQueryVariants: string[] = [];
  /** 吸収したその場の変化の状態（ノード → 代表のスナップショット）。学習でシグネチャを計算し直すときに索引へ入れ直す */
  private localReps = new Map<string, Rep[]>();
  /** 吸収したその場の変化の前後。変化で現れた行（部品）を学ぶのに使う */
  private widgetPairs: { from: Rep; to: Rep }[] = [];
  private widgetCache?: (line: string) => boolean;
  /** その場の変化で現れた、続けて押す操作（深さ 1 段の中の画面 id → 操作） */
  private compounds = new Map<string, Planned[]>();
  private compoundKeys = new Map<string, Set<string>>();
  private compoundCount = new Map<string, number>();
  private compoundCut = new Map<string, number>();
  /** 同じ画面の同じ形の操作の 1 件目の結果（その場の変化だったか） */
  private famOutcome = new Map<string, 'local' | 'other'>();
  /** 続けて押した結果がその場の変化だけだった操作の組（`途中の操作の形>操作の形`）。他の画面では押さない */
  private localCompounds = new Set<string>();
  /** シグネチャの計算結果。学習で正規化が変わったら作り直す */
  private sigCache = new WeakMap<object, SignatureResult>();
  private nextLevel: string[] = [];
  private sessions: Session[] = [];
  private nextId = 1;
  private shotSeq = 0;
  private navFailures = 0;
  private loginHits = 0;
  private startedAt = new Date();
  private readonly loginRe?: RegExp;
  private readonly jevCounts = { skippedActions: 0, mergedStates: 0 };
  private readonly aliasScore = new Map<string, number>();

  constructor(
    readonly config: FlowmapConfig,
    readonly runDir: string,
    private readonly pendingDir: string,
    private readonly storageState: StorageStateObject | undefined,
    private readonly log: (msg: string) => void,
    private readonly quiet: boolean,
    private readonly judge?: JevJudge,
  ) {
    this.ctx = {
      origin: new URL(config.baseUrl).origin,
      pathRules: config.pathRules,
      learnedPrefixes: new Set<string>(),
      queryParams: config.queryParams,
      structuralParams: config.structuralParams,
      dataParams: config.dataParams,
      queryVariantPaths: new Set<string>(),
    };
    this.stats = {
      attempts: 0, replays: 0, backReturns: 0, inferredEdges: 0, skippedCommon: 0, replayDrift: 0,
      localChanges: 0, revealedTried: 0, variantJoins: 0, skippedRepeats: 0, workers: config.workers, durationMs: 0,
    };
    if (config.loginUrlPattern) this.loginRe = new RegExp(config.loginUrlPattern, 'i');
  }

  setStart(d: Date): void { this.startedAt = d; }

  get jevSummary(): Graph['meta']['jev'] {
    if (!this.judge) return undefined;
    return { model: this.judge.model, ...this.judge.stats, skippedActions: this.jevCounts.skippedActions, mergedStates: this.jevCounts.mergedStates, rejectedPathRules: [...this.rejected].map((p) => `${p}/*`) };
  }

  // ---------- ログ ----------

  private say(msg: string): void { if (!this.quiet) this.log(msg); }
  private warnOnce(key: string, msg: string): void { if (this.warned.has(key)) return; this.warned.add(key); this.say(msg); }

  halt(kind: StopKind, reason: string): void {
    if (this.stop) return;
    this.stop = { kind, reason };
    this.log(`停止: ${reason}`);
    // 走っている試行を早く終わらせる（結果は取り込まない）
    for (const s of this.sessions) void s.close();
  }

  // ---------- 索引 ----------

  private resolve(id: string): string {
    let cur = id;
    for (let i = 0; i < 100 && this.redirects.has(cur); i++) cur = this.redirects.get(cur)!;
    return cur;
  }

  private lookup(sig: string): string | undefined {
    const id = this.index.get(sig);
    return id ? this.resolve(id) : undefined;
  }

  private belongsTo(sig: string, nodeId: string): boolean {
    return this.lookup(sig) === this.resolve(nodeId);
  }

  /**
   * そのノードの画面そのもの（代表と同じシグネチャ）か。吸収したその場の変化の状態（開閉を開いたまま等）は含めない。
   * 「戻る」や失敗した操作のあとで、次の操作をこの状態から続けてよいかの判定に使う
   */
  private isAt(sig: string, nodeId: string): boolean {
    return this.byId.get(this.resolve(nodeId))?.signature === sig;
  }

  private sig(snap: Rep): SignatureResult {
    let s = this.sigCache.get(snap);
    if (!s) { s = signatureOf(snap, this.ctx); this.sigCache.set(snap, s); }
    return s;
  }

  /** ノードの代表の画面のデータ（企業名などの値と、行ごとの操作を畳んだ形） */
  private pageOf(id: string): SignatureResult | undefined {
    const rep = this.reps.get(this.resolve(id));
    return rep ? this.sig(rep) : undefined;
  }

  /** 吸収した状態を覚える。同じ状態に着いたら、元の画面の中の変化とすぐ分かる */
  private addLocalRep(id: string, snap: Snapshot, sig: string): void {
    if (!this.index.has(sig)) this.index.set(sig, id);
    const reps = this.localReps.get(id) ?? [];
    if (reps.length >= MAX_LOCAL_REPS) return;
    reps.push({ ...snap, bodyText: '' });
    this.localReps.set(id, reps);
  }

  /**
   * データ区間を学習したら、既存のノードのシグネチャを新しい正規化で計算し直す。
   * 学習前に撮った画面（/companies/サービス業）と学習後の画面（/companies/*）が別のノードに分かれないようにするため。
   * 計算し直して同じになったノードは、深さが同じなら合流させる（発見辺の木が崩れない）。深さが違えば両方残し、後のほうに印を付ける。
   */
  private rekey(): void {
    this.sigCache = new WeakMap();
    this.widgetCache = undefined;
    const next = new Map<string, string>();
    for (const n of [...this.nodes]) {
      const rep = this.reps.get(n.id);
      if (!rep) continue;
      const s = this.sig(rep);
      n.route = s.route;
      const owner = next.get(s.signature);
      if (owner && owner !== n.id) {
        const m = this.byId.get(owner)!;
        if (m.depth === n.depth) { this.mergeNodeInto(n, m); continue; }
        let k = 2;
        while (next.has(`${s.signature}~${k}`)) k++;
        n.signature = `${s.signature}~${k}`;
        next.set(n.signature, n.id);
        this.warnOnce(`dup:${n.id}`, `   ! [${n.id}] は学習したデータ区間で [${m.id}] と同じ画面になりましたが、深さが違うので別のノードのまま残します`);
      } else {
        n.signature = s.signature;
        next.set(s.signature, n.id);
      }
      const aliases = (this.aliasReps.get(n.id) ?? []).map((r) => this.sig(r).signature).filter((a) => a !== n.signature);
      for (const a of aliases) if (!next.has(a)) next.set(a, n.id);
      if (aliases.length) n.aliasSignatures = [...new Set(aliases)];
    }
    // 吸収したその場の変化の状態は、どのノードの代表とも重ならないときだけ元の画面に結び付ける
    for (const n of this.nodes) {
      for (const r of this.localReps.get(n.id) ?? []) {
        const sig = this.sig(r).signature;
        if (!next.has(sig)) next.set(sig, n.id);
      }
    }
    this.index = next;
  }

  /** n を m に合流させる。n の辺は m に付け替え、n のエラーと実例は m に足す */
  private mergeNodeInto(n: StateNode, m: StateNode): void {
    for (const e of this.edges) {
      if (e.from === n.id) e.from = m.id;
      if (e.to === n.id) e.to = m.id;
    }
    for (let i = this.edges.length - 1; i >= 0; i--) {
      const e = this.edges[i];
      if (e.from === e.to && !e.error) this.edges.splice(i, 1);
    }
    for (const x of n.consoleErrors) if (!m.consoleErrors.includes(x)) m.consoleErrors.push(x);
    for (const x of n.failedRequests) if (!m.failedRequests.includes(x)) m.failedRequests.push(x);
    const merged = m.mergedUrls ?? (m.mergedUrls = []);
    for (const u of [n.url, ...(n.mergedUrls ?? [])].map(instanceUrl)) if (u !== instanceUrl(m.url) && !merged.includes(u) && merged.length < MAX_MERGED) merged.push(u);
    if (n.route && n.route === m.route) {
      const samples = m.samples ?? (m.samples = []);
      for (const s of [{ url: instanceUrl(n.url), title: n.title, heading: n.headings[0] }, ...(n.samples ?? [])]) if (s.url !== instanceUrl(m.url) && !samples.some((x) => x.url === s.url) && samples.length < MAX_SAMPLES) samples.push(s);
    }
    m.actionsTried += n.actionsTried;
    for (const l of n.localActions ?? []) {
      const list = m.localActions ?? (m.localActions = []);
      if (!list.some((x) => x.key === l.key) && list.length < MAX_LOCAL_ACTIONS) list.push(l);
    }
    for (const l of n.externalLinks ?? []) {
      const list = m.externalLinks ?? (m.externalLinks = []);
      if (!list.some((x) => x.href === l.href) && list.length < MAX_EXTERNAL_LINKS) list.push(l);
    }
    const moved = [...(this.localReps.get(m.id) ?? []), ...(this.localReps.get(n.id) ?? [])].slice(0, MAX_LOCAL_REPS);
    if (moved.length) this.localReps.set(m.id, moved);
    this.localReps.delete(n.id);
    this.nodes.splice(this.nodes.indexOf(n), 1);
    this.byId.delete(n.id);
    this.redirects.set(n.id, m.id);
    if (n.screenshot) rmSync(join(this.runDir, n.screenshot), { force: true });
    this.nextLevel = this.nextLevel.filter((id) => id !== n.id);
    this.say(`   ≈ [${n.id}] を [${m.id}] に合流（データ区間の学習で同じ画面と分かった）`);
  }

  // ---------- 学習 ----------

  /** この画面の href から「同じ形の兄弟リンク」を学習する。Jev が有効なら、候補を認めたときだけ学習する */
  private async learnFrom(snap: Snapshot): Promise<void> {
    if (!this.config.autoPathRules) return;
    let sameOrigin = false;
    try { sameOrigin = new URL(snap.url).origin === this.ctx.origin; } catch { /* 読めない URL */ }
    if (!sameOrigin) return;
    const items = snap.actions.flatMap((a) => (a.href ? [{ href: a.href, label: a.label, inNav: a.inNav }] : []));
    let changed = false;
    for (const p of proposeDataSegments(items, snap.url, this.ctx, this.config.autoPathRulesMinSiblings, this.rejected)) {
      if (this.judge && this.config.jev.dataSegments) {
        const score = await this.judge.dataGroupScore(
          { title: snap.title, heading: snap.headings[0] ?? '', url: maskedPath(snap.url) },
          p.examples.map((e) => ({ label: clip(e.label ?? ''), href: maskedPath(e.href) })),
        );
        if (score !== undefined && score < this.config.jev.mergeThreshold) {
          this.rejected.add(p.prefix);
          this.say(`   ≉ データ区間の候補を見送り: ${p.prefix}/* （Jev ${score.toFixed(2)}。リンク先はそれぞれ別の画面と判定）`);
          continue;
        }
      }
      this.ctx.learnedPrefixes.add(p.prefix);
      this.learned.push(`${p.prefix}/*`);
      changed = true;
      this.say(`   ≈ データ区間を学習: ${p.prefix}/* （同じ形のリンクが ${this.config.autoPathRulesMinSiblings} 本以上）`);
    }
    for (const route of proposeQueryVariantPaths(items, snap.url, this.ctx)) {
      this.ctx.queryVariantPaths!.add(route);
      this.learnedQueryVariants.push(route);
      changed = true;
      this.say(`   ≈ クエリで絞り込む一覧を学習: ${route} （クエリだけ違うリンクが 2 通り以上。見出しの違いをデータとみなす）`);
    }
    if (changed) this.rekey();
  }

  // ---------- ノード ----------

  /** 別オリジンへの http(s) リンクか */
  private isExternalLink(a: { href?: string }, base: string): boolean {
    if (!isHttp(a.href, base)) return false;
    try { return new URL(a.href!, base).origin !== this.ctx.origin; } catch { return false; }
  }

  /** 探索する操作（別オリジンへのリンクは followExternalLinks のときだけ） */
  private enumerable(snap: Snapshot): ActionDesc[] {
    return snap.actions.filter((a) => this.config.followExternalLinks || !this.isExternalLink(a, snap.url)).map(toDesc);
  }

  /**
   * 新しいノードを作る。steps は親の画面からここまでに押した操作（その場の変化を起こす操作を含む）。
   * 押した操作に状態を変えるもの（ボタン・送信）があるか、ストレージが変わっていれば、この画面は「きれい」でない
   */
  private createNode(o: Outcome, from: string | undefined, path: ActionDesc[], depth: number, steps: ActionDesc[] = []): StateNode {
    const snap = o.snap!;
    const id = `s${String(this.nextId++).padStart(3, '0')}`;
    const s = this.sig(snap);
    const sameOrigin = s.route !== undefined;
    let screenshot = `shots/${id}.png`;
    if (o.shot && existsSync(o.shot)) {
      renameSync(o.shot, join(this.runDir, screenshot));
    } else {
      screenshot = '';
      this.warnOnce(`noshot:${id}`, `   ! [${id}] のスクリーンショットがありません`);
    }
    const enumerated = sameOrigin ? this.enumerable(snap) : [];
    const planned = planActions(enumerated, (a) => actionKey(a, snap.url, this.ctx, s.dataValues, s.fold), this.config.maxActionsPerPattern);
    const node: StateNode = {
      id,
      signature: s.signature,
      url: snap.url,
      route: s.route,
      title: snap.title,
      depth,
      screenshot,
      textHash: sha1(snap.bodyText).slice(0, 12),
      headings: snap.headings.slice(0, 8),
      consoleErrors: o.errors.consoleErrors,
      failedRequests: o.errors.failedRequests,
      actionsTotal: enumerated.length,
      actionsPlanned: planned.length,
      actionsTried: 0,
    };
    if (snap.dialog !== undefined) node.dialog = snap.dialog;
    if (snap.expanded?.length) node.expanded = snap.expanded.slice(0, 4);
    if (sameOrigin && !this.config.followExternalLinks) {
      const links: { label: string; href: string }[] = [];
      for (const a of snap.actions) {
        if (!this.isExternalLink(a, snap.url)) continue;
        const href = new URL(a.href!, snap.url).href;
        if (!links.some((l) => l.href === href) && links.length < MAX_EXTERNAL_LINKS) links.push({ label: a.label, href });
      }
      if (links.length) node.externalLinks = links;
    }
    if (!sameOrigin) node.truncated = '外部サイト';
    else if (depth >= this.config.maxDepth) node.truncated = '深さ上限';
    this.nodes.push(node);
    this.byId.set(id, node);
    this.index.set(s.signature, id);
    const rep = { ...snap, bodyText: '' };
    this.reps.set(id, rep);
    this.sigCache.set(rep, s);
    this.paths.set(id, path);
    this.plans.set(id, planned.map((action) => ({ action })));
    const parentDirty = from ? this.dirty.get(this.resolve(from)) ?? false : false;
    this.dirty.set(id, parentDirty || steps.some((a) => !isCleanAction(a)) || !!o.storageChanged);
    if (!node.truncated) this.nextLevel.push(id);
    return node;
  }

  /** 既知の画面に着いたとき。エラーは追記し、別 URL から合流した場合は記録する（ビューアで「何が畳まれたか」を見せる） */
  private joinKnown(known: StateNode, snap: Snapshot, s: SignatureResult, errors: Outcome['errors']): void {
    for (const e of errors.consoleErrors) if (!known.consoleErrors.includes(e)) known.consoleErrors.push(e);
    for (const f of errors.failedRequests) if (!known.failedRequests.includes(f)) known.failedRequests.push(f);
    const u = instanceUrl(snap.url);
    if (u === instanceUrl(known.url)) return;
    if (s.route && s.route === known.route) {
      const samples = known.samples ?? (known.samples = []);
      if (!samples.some((x) => x.url === u) && samples.length < MAX_SAMPLES) samples.push({ url: u, title: snap.title, heading: snap.headings[0] });
    }
    if (s.signature !== known.signature && this.aliasScore.has(s.signature)) {
      const merged = known.jevMerged ?? (known.jevMerged = []);
      if (!merged.some((m) => m.url === u) && merged.length < MAX_MERGED) merged.push({ url: u, score: this.aliasScore.get(s.signature) ?? 0 });
    } else {
      const merged = known.mergedUrls ?? (known.mergedUrls = []);
      if (!merged.includes(u) && merged.length < MAX_MERGED) merged.push(u);
    }
  }

  /**
   * Jev で、同じ区画（先頭のパス区間が同じ）の既存ノードから同じ画面を探す。
   * 同じルートのノードを先に、最大 8 件と比べ、mergeThreshold 以上で最も高いものを返す。
   * 比べる相手は各ノードの代表（最初に撮った状態）なので、A≈B・B≈C から A と C が繋がることはない。
   */
  private async findSameScreen(snap: Snapshot, route: string): Promise<{ node: StateNode; score: number } | undefined> {
    const sectionOf = (r: string) => r.split('?')[0].split('/')[1] ?? '';
    const section = sectionOf(route);
    const candidates = this.nodes
      .filter((n) => n.route && sectionOf(n.route) === section && this.reps.has(n.id))
      .sort((a, b) => Number(b.route === route) - Number(a.route === route))
      .slice(0, 8);
    const scores = await Promise.all(candidates.map((n) => this.judge!.sameScreenScore(this.reps.get(n.id)!, snap, this.ctx)));
    let best: { node: StateNode; score: number } | undefined;
    scores.forEach((score, i) => {
      if (score !== undefined && score >= this.config.jev.mergeThreshold && (!best || score > best.score)) best = { node: candidates[i], score: round2(score) };
    });
    return best;
  }

  /** Jev: サーバーのデータを変えると判定した操作は押さない（denyText による除外に加える） */
  private async jevFilter(node: StateNode): Promise<void> {
    const plan = this.plans.get(node.id);
    if (!this.judge || !this.config.jev.actions || node.truncated || !plan?.length) return;
    const kept = await this.jevScreen(node, plan);
    if (kept.length === plan.length) return;
    this.plans.set(node.id, kept);
    node.actionsPlanned = kept.length;
  }

  /**
   * Jev で危険と判定した操作を除き、除いたものはノードに記録する。画面の操作の計画と、その場の変化で現れた操作（パネルやメニューの中）の両方に使う。
   * タブと開閉は表示を切り替えるだけなので聞かない。リンクは GET の遷移なので閾値を上げる（DESIGN.md §5）
   */
  private async jevScreen(node: StateNode, items: Planned[]): Promise<Planned[]> {
    if (!this.judge || !this.config.jev.actions || !items.length) return items;
    const uiOnly = (a: ActionDesc) => a.role === 'tab' || a.role === 'summary' || !!a.toggle;
    const scores = await Promise.all(items.map((p) => (uiOnly(p.action) ? Promise.resolve(undefined) : this.judge!.actionScore(node.title, p.action))));
    const kept: Planned[] = [];
    items.forEach((p, i) => {
      const score = scores[i];
      const threshold = p.action.role === 'link' ? Math.max(this.config.jev.actionThreshold, LINK_ACTION_THRESHOLD) : this.config.jev.actionThreshold;
      if (score === undefined || score < threshold) { kept.push(p); return; }
      const k = { role: p.action.role, label: p.action.label, score: round2(score) };
      (node.jevSkipped ??= []).push(k);
      this.jevCounts.skippedActions++;
      this.say(`   ⊘ Jev が危険と判定して押しません: ${describeAction({ ...k, nth: 1 })} （${k.score.toFixed(2)}）`);
    });
    return kept;
  }

  // ---------- 共通の操作 ----------

  /**
   * 共通の操作として数えるキー。リンクは行き先の正規化ルート、それ以外は役割とラベル（数字は潰す）。
   * データを変えうる送信は対象にしない（検索フォームは除く）。
   */
  private commonKey(a: ActionDesc, pageUrl: string, page?: SignatureResult): string | undefined {
    if (a.kind === 'submit' && !a.search) return undefined;
    if (isHttp(a.href, pageUrl)) return 'L|' + actionKey(a, pageUrl, this.ctx, []);
    return `C|${this.familyOf(a, pageUrl, page)}`;
  }

  /**
   * 同じ画面の中で「同じ形」とみなす操作のキー（リンク以外）。ラベルの数字とデータ（企業名など）を潰し、
   * 行ごとの同種のボタン（「〇〇を並べて比べる」）は 1 つの形になる。開閉もラベルで区別する
   */
  private familyOf(a: ActionDesc, pageUrl: string, page?: SignatureResult): string | undefined {
    if (isHttp(a.href, pageUrl)) return undefined;
    return `${a.role}|${labelKey(a, page?.dataValues ?? [], page?.fold)}${a.kind === 'submit' ? '|submit' : ''}`;
  }

  /** 共通の操作を別々の画面から試す回数。開閉（summary・aria-expanded など）は性質上その場の変化なので 1 回で見極める */
  private repeatsFor(p: Planned): number {
    if (p.key!.startsWith('L|')) return this.config.maxLinkRepeats;
    return p.action.toggle ? Math.min(1, this.config.maxLocalActionRepeats) : this.config.maxLocalActionRepeats;
  }

  /**
   * 操作の結果を、共通の操作の判定用に分類する。リンクは行き先の画面そのもの（自分自身へのリンクも含めて、行き先が毎回同じかを見る）。
   * リンクでない操作は、変化なしと同じルートの中の変化（開閉・モーダル）を local とする
   */
  private classify(from: string, to: string, item: Planned): CommonOutcome {
    if (item.key?.startsWith('L|')) return { nav: to };
    if (from === to) return 'local';
    const a = this.byId.get(from);
    const b = this.byId.get(to);
    if (a?.route && b?.route && a.route === b.route) return 'local';
    return { nav: to };
  }

  private record(from: string, item: Planned, outcome: CommonOutcome): void {
    if (!item.key || this.dirty.get(from)) return;
    this.common.get(item.key)?.outcomes.push(outcome);
  }

  /** 保留した共通の操作の扱い。結果が毎回その場の変化だけなら local、毎回同じ画面に着いたならその画面、ばらついたら undefined（押す） */
  private consistency(key: string): 'local' | { nav: string } | undefined {
    const st = this.common.get(key);
    if (!st || !st.outcomes.length) return undefined;
    if (st.outcomes.every((o) => o === 'local')) return 'local';
    let dest: string | undefined;
    for (const o of st.outcomes) {
      if (typeof o !== 'object') return undefined;
      const d = this.resolve(o.nav);
      if (dest && dest !== d) return undefined;
      dest = d;
    }
    return dest && this.byId.has(dest) ? { nav: dest } : undefined;
  }

  // ---------- 計画 ----------

  /**
   * 深さ 1 段分の試行を決める。画面の順・操作の順に、共通の操作は別々の画面で合わせて maxLinkRepeats / maxLocalActionRepeats 回までだけ試し、
   * それ以上は保留する（結果を見てから推定・省略・試行を決める）。保留した操作は操作数の上限に数えない。
   */
  private planLevel(ids: string[]): { tasks: Task[]; deferred: Map<string, Planned[]> } {
    const tasks: Task[] = [];
    const deferred = new Map<string, Planned[]>();
    for (const id of ids) {
      const node = this.byId.get(id);
      if (!node || node.truncated) continue;
      const clean = !this.dirty.get(id);
      const page = this.pageOf(id);
      const run: Planned[] = [];
      const later: Planned[] = [];
      const families = new Set<string>();
      let budget = this.config.maxActionsPerState;
      let cut = 0;
      for (const p of this.plans.get(id) ?? []) {
        p.key = clean ? this.commonKey(p.action, node.url, page) : undefined;
        // 同じ画面の同じ形の操作（一覧の各行のボタン）は 1 件目だけ先に試し、残りは 1 件目の結果を見てから決める
        const fam = this.config.absorbLocalChanges ? this.familyOf(p.action, node.url, page) : undefined;
        if (fam) {
          if (families.has(fam)) { p.dupOf = `${id}|${fam}`; later.push(p); continue; }
          families.add(fam);
          p.fam = `${id}|${fam}`;
        }
        const R = p.key ? this.repeatsFor(p) : 0;
        if (p.key && R > 0) {
          const st = this.common.get(p.key) ?? { sources: new Set<string>(), outcomes: [] };
          this.common.set(p.key, st);
          if (!st.sources.has(id) && st.sources.size >= R) { later.push(p); continue; }
          if (budget <= 0) { cut++; continue; }
          st.sources.add(id);
        } else if (budget <= 0) { cut++; continue; }
        run.push(p);
        budget--;
      }
      this.cut.set(id, cut);
      this.runCount.set(id, run.length);
      if (later.length) deferred.set(id, later);
      for (let i = 0; i < run.length; i += CHUNK) tasks.push({ phase: 'A', seq: tasks.length, node: id, path: this.paths.get(id)!, items: run.slice(i, i + CHUNK) });
    }
    return { tasks, deferred };
  }

  /** 保留した共通の操作を、先に試した結果から推定・省略し、ばらついたものだけ試す */
  private resolveDeferred(ids: string[], deferred: Map<string, Planned[]>): Task[] {
    const tasks: Task[] = [];
    for (const id of ids) {
      const later = deferred.get(id);
      if (!later) continue;
      const N = this.resolve(id);
      const node = this.byId.get(N);
      if (!node) continue;
      let budget = this.config.maxActionsPerState - (this.runCount.get(id) ?? 0);
      let inferred = 0;
      let skipped = 0;
      let repeats = 0;
      const run: Planned[] = [];
      for (const p of later) {
        if (p.dupOf) {
          const f = this.famOutcome.get(p.dupOf);
          if (f === 'local') { repeats++; continue; } // 1 件目がその場の変化だった。残りの行も同じとみなす
          // 1 件目も共通の操作として保留されていれば、共通の操作の結果に従う（下）
          if (f !== undefined || !p.key) {
            if (budget > 0) { run.push(p); budget--; } else this.cut.set(id, (this.cut.get(id) ?? 0) + 1);
            continue;
          }
        }
        const c = this.consistency(p.key!);
        if (c === 'local') { skipped++; continue; }
        if (c) {
          if (c.nav !== N) this.edges.push({ from: N, to: c.nav, action: p.action, inferred: true });
          inferred++;
          continue;
        }
        if (budget > 0) { run.push(p); budget--; } else this.cut.set(id, (this.cut.get(id) ?? 0) + 1);
      }
      if (inferred) node.actionsInferred = (node.actionsInferred ?? 0) + inferred;
      if (skipped) node.actionsSkippedCommon = (node.actionsSkippedCommon ?? 0) + skipped;
      this.stats.inferredEdges += inferred;
      this.stats.skippedCommon += skipped;
      this.stats.skippedRepeats = (this.stats.skippedRepeats ?? 0) + repeats;
      if (inferred || skipped) this.say(`   ⇢ [${N}] 共通の操作: 推定 ${inferred} 件・省略 ${skipped} 件${run.length ? `・試行 ${run.length} 件` : ''}（他の画面で結果を確かめ済み）`);
      if (repeats) this.say(`   ⇢ [${N}] 同じ形の操作 ${repeats} 件は、1 件目がこの画面の中の変化だったので押しません`);
      for (let i = 0; i < run.length; i += CHUNK) tasks.push({ phase: 'B', seq: tasks.length, node: id, path: this.paths.get(id)!, items: run.slice(i, i + CHUNK) });
    }
    return tasks;
  }

  /**
   * その場の変化で現れた操作を、元の画面から続けて押す試行にする。深さ 1 段の中で、変化を見つけた順（決まった順番）に並ぶ。
   * 1 画面あたり maxActionsPerState 件まで
   */
  private planCompounds(ids: string[]): Task[] {
    const tasks: Task[] = [];
    for (const id of ids) {
      const list = this.compounds.get(id);
      if (!list?.length) continue;
      this.compounds.delete(id);
      if (!this.byId.has(this.resolve(id))) continue;
      let used = this.compoundCount.get(id) ?? 0;
      const run: Planned[] = [];
      for (const p of list) {
        if (used >= this.config.maxActionsPerState) { this.compoundCut.set(id, (this.compoundCut.get(id) ?? 0) + 1); continue; }
        run.push(p);
        used++;
      }
      this.compoundCount.set(id, used);
      for (let i = 0; i < run.length; i += CHUNK) tasks.push({ phase: 'C', seq: tasks.length, node: id, path: this.paths.get(id)!, items: run.slice(i, i + CHUNK) });
    }
    return tasks;
  }

  // ---------- 実行 ----------

  /**
   * 試行をワーカーに配り、結果は決まった順番で 1 つずつ取り込む（取り込み順が発見順・ノード id を決める）。
   * 取り込みは試行と並行して進むので、画面数上限に達したら残りの試行を打ち切れる。
   */
  private async runTasks(tasks: Task[]): Promise<void> {
    if (!tasks.length || this.stop) return;
    const results: (Outcome[] | undefined)[] = new Array(tasks.length);
    let next = 0;
    let cursor = 0;
    let chain: Promise<void> = Promise.resolve();
    const pump = (): Promise<void> => {
      chain = chain.then(async () => {
        while (cursor < tasks.length && results[cursor] && !this.stop) {
          const t = tasks[cursor];
          const outs = results[cursor]!;
          results[cursor] = undefined;
          for (let k = 0; k < outs.length && !this.stop; k++) await this.mergeOutcome(t, t.items[k], outs[k]);
          cursor++;
        }
      }).catch((e) => { this.halt('error', `探索中にエラー: ${firstLine(e)}`); });
      return chain;
    };
    const worker = async (s: Session) => {
      while (!this.stop) {
        const i = next++;
        if (i >= tasks.length) break;
        results[i] = await this.runTask(s, tasks[i]);
        void pump();
      }
    };
    await Promise.all(this.sessions.slice(0, Math.min(this.sessions.length, tasks.length)).map((s) => worker(s)));
    await pump();
  }

  /** 起点から経路を再現して、元の画面にいることを確かめる。一致しなければ 1 回だけやり直し、それでも違えば違いを記録して進む */
  private async replay(s: Session, task: Task): Promise<{ drift?: Outcome['drift'] } | { error: string; kind: 'navigation' | 'replay' }> {
    let lastError = '';
    let kind: 'navigation' | 'replay' = 'replay';
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.stop) return { error: '中断', kind: 'replay' };
      this.stats.replays++;
      await s.fresh();
      let settled: boolean;
      try {
        settled = await s.gotoRoot();
      } catch (e) {
        lastError = firstLine(e);
        kind = 'navigation';
        continue;
      }
      try {
        for (const step of task.path) settled = (await s.perform(step)).settled;
      } catch (e) {
        lastError = `経路再現失敗: ${firstLine(e)}`;
        kind = 'replay';
        continue;
      }
      const snap = await s.stableSnapshot(settled);
      const got = this.sig(snap);
      if (this.belongsTo(got.signature, task.node)) return {};
      if (attempt === 0) continue;
      const rep = this.reps.get(this.resolve(task.node));
      const d = rep ? structureDiff(this.sig(rep).structure, got.structure) : { onlyA: [], onlyB: [] };
      return { drift: { onlyHere: d.onlyA, onlyReplayed: d.onlyB } };
    }
    return { error: lastError, kind };
  }

  /** 失敗した操作のあと、まだ元の画面にいるか（いれば再現を省ける） */
  private async stillAt(s: Session, node: string, digest: string): Promise<boolean> {
    try {
      const snap = await s.snapshot();
      return this.isAt(this.sig(snap).signature, node) && (await s.storageDigest()) === digest;
    } catch {
      return false;
    }
  }

  /** ワーカー 1 つ分の試行。CHUNK 件の操作を順に試し、結果（取り込みはしない）を返す */
  private async runTask(s: Session, task: Task): Promise<Outcome[]> {
    const out: Outcome[] = [];
    let atSource = false;
    let sourceDigest = '';
    let drift: Outcome['drift'];
    for (const item of task.items) {
      if (this.stop) break;
      const before = out.length; // この操作の結果をもう記録したか（結果は操作 1 つにつき必ず 1 件。ずれると辺が別の操作に付く）
      try {
        if (!atSource) {
          const r = await this.replay(s, task);
          if ('error' in r) { out.push({ error: r.error, kind: r.kind, errors: EMPTY_ERRORS() }); continue; }
          drift = r.drift;
          sourceDigest = await s.storageDigest();
        }
        atSource = false;
        s.drain(); // 再現中のエラーは元の画面のもの
        if (item.via) {
          // その場の変化を起こす操作を先に押す（変化のエラーは、その変化を最初に試したときに記録済み）
          try {
            for (const step of item.via) await s.perform(step);
          } catch (e) {
            out.push({ error: `途中の操作に失敗: ${firstLine(e)}`, kind: 'replay', errors: EMPTY_ERRORS(), drift });
            drift = undefined;
            continue;
          }
          s.drain();
        }
        const beforeUrl = s.url();
        this.stats.attempts++;
        let settled: boolean;
        let substituted: boolean;
        try {
          ({ settled, substituted } = await s.perform(item.action));
        } catch (e) {
          out.push({ error: firstLine(e), kind: e instanceof ActionError ? 'action' : 'internal', errors: s.drain(), drift });
          drift = undefined;
          atSource = await this.stillAt(s, task.node, sourceDigest);
          continue;
        }
        const snap = await s.stableSnapshot(settled);
        const errors = s.drain();
        const sig = this.sig(snap).signature;
        let shot: string | undefined;
        if (!this.index.has(sig)) {
          shot = join(this.pendingDir, `${this.shotSeq++}.png`);
          await s.screenshot(shot);
        }
        const storageChanged = (await s.storageDigest()) !== sourceDigest;
        out.push({ snap, shot, errors, storageChanged, drift, substituted });
        drift = undefined;
        // 元の画面に戻れるなら戻り、次の操作の再現を省く。正しさはシグネチャとストレージの一致で確かめる。
        // 吸収したその場の変化の状態（開閉を開いたまま）は元の画面そのものではないので、ここでは代表との一致だけを見る
        if (storageChanged) continue;
        if (this.isAt(sig, task.node) && s.url() === beforeUrl) { atSource = true; continue; } // 画面が変わらなかった
        if (this.config.useBackNavigation && isCleanAction(item.action) && item.action.href && s.url() !== beforeUrl) {
          const b = await s.goBack();
          if (b.moved) {
            const back = await s.stableSnapshot(b.settled);
            if (this.isAt(this.sig(back).signature, task.node) && (await s.storageDigest()) === sourceDigest) {
              atSource = true;
              this.stats.backReturns++;
            }
          }
        }
      } catch (e) {
        if (this.stop) break;
        if (out.length === before) out.push({ error: `内部エラー: ${firstLine(e)}`, kind: 'internal', errors: EMPTY_ERRORS() });
        atSource = false;
      }
    }
    return out;
  }

  private header(id: string, phase: Task['phase']): void {
    const key = `${phase}:${id}`;
    if (this.headed.has(key)) return;
    this.headed.add(key);
    const n = this.byId.get(id);
    const note = phase === 'B' ? '（保留した共通の操作）' : phase === 'C' ? '（この画面の中の変化で現れた操作）' : '';
    if (n) this.say(`[${n.id}] ${n.title || n.url}  深さ ${n.depth}${note}`);
  }

  /** 操作の説明。その場の変化を経る操作は「並べる → 比較ページで開く」 */
  private describe(item: Planned): string {
    return [...(item.via ?? []), item.action].map(describeAction).join(' → ');
  }

  private edgeOf(from: string, to: string, item: Planned, extra: Partial<Edge> = {}): Edge {
    return { from, to, action: item.action, ...(item.via ? { via: item.via } : {}), ...extra };
  }

  private addErrors(n: StateNode, errors: Outcome['errors']): void {
    for (const e of errors.consoleErrors) if (!n.consoleErrors.includes(e)) n.consoleErrors.push(e);
    for (const f of errors.failedRequests) if (!n.failedRequests.includes(f)) n.failedRequests.push(f);
  }

  private checkLogin(item: Planned, snap: Snapshot): void {
    if (!this.loginRe) return;
    const aimedAtLogin = !!item.action.href && this.loginRe.test(item.action.href);
    if (this.loginRe.test(snap.url) && !aimedAtLogin) {
      if (++this.loginHits >= LOGIN_REPEAT_LIMIT) this.halt('auth', `ログイン画面（${readableUrl(snap.url)}）に ${LOGIN_REPEAT_LIMIT} 回続けて移りました。認証が切れています。storageState を取り直してください`);
    } else this.loginHits = 0;
  }

  // ---------- この画面の中の変化 ----------

  /**
   * 変化で現れた行（部品）に当たるか。吸収したその場の変化の前後の骨格の差から作る。
   * 元の画面に同じ形があった操作でも、変化で新しく増えたもの（比較パネルの「詳しく見る」リンク）は部品の行に入れる。
   * 部品が別の画面に出たとき、その画面には同じ形のリンクが無いことがあるため
   */
  private widgetMatcher(): (line: string) => boolean {
    if (!this.widgetCache) {
      const lines = new Set<string>();
      const instance = (a: RawAction) => `${a.role}|${a.label}|${a.href ?? ''}`;
      for (const w of this.widgetPairs) {
        const to = this.sig(w.to);
        const before = new Set(this.sig(w.from).structure.split('\n'));
        for (const l of to.structure.split('\n')) if (l && !before.has(l)) lines.add(l);
        const count = new Map<string, number>();
        for (const a of w.from.actions) count.set(instance(a), (count.get(instance(a)) ?? 0) + 1);
        for (const a of w.to.actions) {
          const c = count.get(instance(a)) ?? 0;
          if (c > 0) { count.set(instance(a), c - 1); continue; }
          if (!a.volatile) lines.add(`a:${actionKey(a, w.to.url, this.ctx, to.dataValues, to.fold)}`);
        }
      }
      this.widgetCache = lineMatcher(lines);
    }
    return this.widgetCache;
  }

  /**
   * 部品（比較パネルなど、その場の変化で現れたことのある行）が開いたままなだけで、中身は既存の画面と同じなら、その画面を返す。
   * ストレージに残った部品が他の画面にも出て、同じ画面が「部品あり」「部品なし」に分かれるのを防ぐ
   */
  private findVariantBase(s: SignatureResult): StateNode | undefined {
    if (!this.widgetPairs.length || !s.route) return undefined;
    const isWidget = this.widgetMatcher();
    for (const n of this.nodes) {
      if (n.route !== s.route) continue;
      const rep = this.reps.get(n.id);
      if (rep && variantOf(this.sig(rep).structure, s.structure, isWidget)) return n;
    }
    return undefined;
  }

  /** 操作の形の一覧（変化で「新しく現れた」操作を選ぶのに使う） */
  private keysOf(snap: Snapshot, page: SignatureResult): string[] {
    return this.enumerable(snap).map((a) => actionKey(a, snap.url, this.ctx, page.dataValues, page.fold));
  }

  /**
   * その場の変化で新しく現れた操作を、元の画面から続けて押す操作にする。元の画面（と途中の状態）に同じ形の操作があるもの、
   * この画面で既に続けて押すことにしたものは除く。段数は MAX_VIA まで
   */
  private revealedFor(levelId: string, N: StateNode, item: Planned, snap: Snapshot, s: SignatureResult): Planned[] {
    const via = [...(item.via ?? []), item.action];
    const rep = this.reps.get(N.id);
    const page = this.pageOf(N.id);
    if (via.length > MAX_VIA || !rep || !page) return [];
    const seen = item.seen ?? new Set(this.keysOf(rep, page));
    const keyOf = (a: ActionDesc) => actionKey(a, snap.url, this.ctx, s.dataValues, s.fold);
    const enumerated = this.enumerable(snap);
    // 最後の段では開閉を押しても先が無いので、続けて押すのはリンクやボタンだけにする。
    // この画面自身へのリンク（パネルの「詳しく見る」がこの画面を指すなど）は再表示にしかならないので押さない
    const self = (a: ActionDesc) => !!a.href && keyOf(a) === `${a.role}|${N.route}`;
    const fresh = planActions(enumerated.filter((a) => !seen.has(keyOf(a)) && !self(a) && !(via.length === MAX_VIA && a.toggle)), keyOf, 1);
    const done = this.compoundKeys.get(levelId) ?? new Set<string>();
    this.compoundKeys.set(levelId, done);
    const next = new Set([...seen, ...enumerated.map(keyOf)]);
    const viaKey = via.map((v) => this.familyOf(v, N.url, page) ?? actionKey(v, N.url, this.ctx, [])).join('>');
    const out: Planned[] = [];
    for (const a of fresh) {
      const k = keyOf(a);
      const ckey = `${viaKey}>${k}`;
      if (done.has(k)) continue;
      if (this.localCompounds.has(ckey)) { this.stats.skippedRepeats = (this.stats.skippedRepeats ?? 0) + 1; continue; }
      if (out.length >= MAX_REVEALED) break;
      done.add(k);
      out.push({ action: a, via, seen: next, ckey });
    }
    return out;
  }

  /**
   * 「この画面の中の操作」を記録する。同じ形の操作は 1 件にまとめ、変化のあとのスクリーンショットは形ごとに 1 枚だけ残す。
   * 続けて押した操作（via あり）の結果と、変化のない同じ画面へのリンク（ページ送りなど）は載せない
   */
  private noteLocal(N: StateNode, item: Planned, changed: boolean, shot?: string, revealed: Planned[] = []): void {
    if (item.via?.length) return;
    if (!changed && isHttp(item.action.href, N.url)) return;
    const page = this.pageOf(N.id);
    const rep = this.reps.get(N.id);
    // 開閉はラベルで区別する（actionKey は開閉のラベルを見ないので、別々の開閉が 1 つにまとまってしまう）
    const groupOf = (a: ActionDesc) => (a.toggle ? `${a.role}|~${labelKey(a, page?.dataValues ?? [], page?.fold)}` : actionKey(a, N.url, this.ctx, page?.dataValues ?? [], page?.fold));
    const key = groupOf(item.action);
    const list = N.localActions ?? (N.localActions = []);
    let e: LocalAction | undefined = list.find((x) => x.key === key);
    if (!e) {
      if (list.length >= MAX_LOCAL_ACTIONS) return;
      const count = rep ? this.enumerable(rep).filter((a) => groupOf(a) === key).length : 1;
      e = { key, action: item.action, count: Math.max(1, count), tried: 0, changed: false };
      const lk = labelKey(item.action, page?.dataValues ?? [], page?.fold);
      if (!item.action.href && !item.action.toggle && lk.includes('*')) e.pattern = lk;
      list.push(e);
    }
    e.tried++;
    if (changed) e.changed = true;
    if (revealed.length && !e.revealed) e.revealed = revealed.map((r) => r.action.label).slice(0, MAX_REVEALED);
    if (changed && shot && !e.screenshot && existsSync(shot)) {
      const file = `shots/${N.id}-${list.indexOf(e) + 1}.png`;
      renameSync(shot, join(this.runDir, file));
      e.screenshot = file;
    }
  }

  /** その場の変化を元の画面に吸収する。変化で現れた操作は、続けて押す操作として同じ深さの最後に試す */
  private async absorb(levelId: string, N: StateNode, item: Planned, o: Outcome, s: SignatureResult): Promise<void> {
    const snap = o.snap!;
    this.stats.localChanges = (this.stats.localChanges ?? 0) + 1;
    this.addErrors(N, o.errors);
    this.addLocalRep(N.id, snap, s.signature);
    const rep = this.reps.get(N.id);
    if (rep && this.widgetPairs.length < MAX_WIDGET_PAIRS) {
      this.widgetPairs.push({ from: rep, to: { ...snap, bodyText: '' } });
      this.widgetCache = undefined;
    }
    const revealed = await this.jevScreen(N, this.revealedFor(levelId, N, item, snap, s));
    if (revealed.length) this.compounds.set(levelId, [...(this.compounds.get(levelId) ?? []), ...revealed]);
    this.noteLocal(N, item, true, o.shot, revealed);
    this.say(`   ◇ ${this.describe(item)}: この画面の中の変化${revealed.length ? `（現れた操作 ${revealed.length} 件を続けて試す）` : ''}`);
  }

  /** 試行の結果を 1 つ取り込む。決まった順番で呼ばれる */
  private async mergeOutcome(task: Task, item: Planned, o: Outcome): Promise<void> {
    if (this.stop) return;
    let N = this.resolve(task.node);
    let node = this.byId.get(N);
    if (!node) return;
    this.header(N, task.phase);
    node.actionsTried++;
    if (item.via) this.stats.revealedTried = (this.stats.revealedTried ?? 0) + 1;
    if (o.drift) {
      const u = node.unstable ?? (node.unstable = { count: 0, onlyHere: o.drift.onlyHere, onlyReplayed: o.drift.onlyReplayed });
      u.count++;
      this.stats.replayDrift++;
      if (u.count === 1) this.say(`   ! [${N}] 起点から再現した画面が元と一致しません（元だけ: ${o.drift.onlyHere.slice(0, 3).join(' / ') || 'なし'}・再現だけ: ${o.drift.onlyReplayed.slice(0, 3).join(' / ') || 'なし'}）`);
    }
    if (o.error) {
      this.edges.push(this.edgeOf(N, N, item, { error: o.error }));
      this.record(N, item, 'error');
      if (item.fam) this.famOutcome.set(item.fam, 'other');
      this.say(`   ✗ ${this.describe(item)}: ${o.error}`);
      if (o.kind === 'navigation') {
        if (++this.navFailures >= NAV_FAILURE_LIMIT) this.halt('unreachable', `起点に ${NAV_FAILURE_LIMIT} 回続けて接続できませんでした（${o.error}）`);
      } else this.navFailures = 0;
      return;
    }
    this.navFailures = 0;
    const snap = o.snap!;
    if (o.substituted) this.warnOnce(`sub:${N}:${item.action.label}`, `   ≒ ${describeAction(item.action)} が見つからないため、同じ形のリンクで代用しました`);
    await this.learnFrom(snap);
    // 学習でノードが合流したかもしれないので引き直す
    N = this.resolve(task.node);
    node = this.byId.get(N);
    if (!node) return;
    const s = this.sig(snap);
    let K = this.lookup(s.signature);
    if (!K && s.route && this.config.absorbLocalChanges) {
      const rep = this.reps.get(N);
      if (rep && s.route === node.route && isLocalChange(this.sig(rep).structure, s.structure)) {
        await this.absorb(task.node, node, item, o, s);
        this.checkLogin(item, snap);
        this.record(N, item, this.classify(N, N, item));
        if (item.fam) this.famOutcome.set(item.fam, 'local');
        if (item.ckey) this.localCompounds.add(item.ckey);
        return;
      }
      const base = this.findVariantBase(s);
      if (base) {
        K = base.id;
        this.addLocalRep(K, snap, s.signature);
        this.stats.variantJoins = (this.stats.variantJoins ?? 0) + 1;
        if (K !== N) this.say(`   ≈ 開いたままの部品（比較パネルなど）を除けば [${K}] と同じ画面`);
      }
    }
    let isNew = false;
    if (!K && this.judge && this.config.jev.pages && s.route) {
      const found = await this.findSameScreen(snap, s.route);
      if (found) {
        K = found.node.id;
        this.index.set(s.signature, K);
        this.aliasScore.set(s.signature, found.score);
        const reps = this.aliasReps.get(K) ?? [];
        reps.push({ ...snap, bodyText: '' });
        this.aliasReps.set(K, reps);
        (found.node.aliasSignatures ??= []).push(s.signature);
        this.jevCounts.mergedStates++;
        this.say(`   ≡ Jev が同じ画面と判定して合流: ${readableUrl(snap.url)} → [${K}] （${found.score.toFixed(2)}）`);
      }
    }
    if (K) {
      this.joinKnown(this.byId.get(K)!, snap, s, o.errors);
    } else {
      const steps = [...(item.via ?? []), item.action];
      const created = this.createNode(o, N, [...task.path, ...steps], node.depth + 1, steps);
      await this.jevFilter(created);
      K = created.id;
      isNew = true;
    }
    this.checkLogin(item, snap);
    this.record(N, item, this.classify(N, K, item));
    if (item.fam) this.famOutcome.set(item.fam, K === N ? 'local' : 'other');
    if (K === N) {
      // 画面が変わらない操作（再表示だけ、または吸収済みのその場の変化）。地図には描かず、画面の中の操作として残す
      this.noteLocal(node, item, s.signature !== node.signature);
      if (item.ckey) this.localCompounds.add(item.ckey);
    } else {
      this.edges.push(this.edgeOf(N, K, item));
      const to = this.byId.get(K)!;
      this.say(`   ${isNew ? '＋' : '→'} ${this.describe(item)} → [${K}] ${to.title || to.url}`);
    }
    if (isNew && this.nodes.length >= this.config.maxStates) this.halt('maxStates', `画面数上限 ${this.config.maxStates} に到達`);
  }

  // ---------- 全体 ----------

  async run(browser: Browser): Promise<void> {
    const enumerate = {
      denyText: this.config.denyText,
      denySelectors: this.config.denySelectors,
      denyUrlPatterns: this.config.denyUrlPatterns,
      allowSubmit: this.config.allowSubmit,
      volatileSelectors: this.config.volatileSelectors,
    };
    this.sessions = Array.from({ length: this.config.workers }, () => new Session(browser, { config: this.config, storageState: this.storageState, enumerate, ctx: this.ctx }));
    await this.captureRoot();
    let level = [this.root];
    while (level.length && !this.stop) {
      this.nextLevel = [];
      const depth = this.byId.get(level[0])?.depth ?? 0;
      const { tasks, deferred } = this.planLevel(level);
      const tries = tasks.reduce((n, t) => n + t.items.length, 0);
      const held = [...deferred.values()].reduce((n, l) => n + l.length, 0);
      this.log(`── 深さ ${depth}: ${level.length} 画面・試行 ${tries} 件${held ? `（共通の操作 ${held} 件は結果を見て決める）` : ''}・これまでに ${this.nodes.length} 画面`);
      await this.runTasks(tasks);
      if (!this.stop && deferred.size) await this.runTasks(this.resolveDeferred(level, deferred));
      // その場の変化で現れた操作を続けて押す。続けて押した結果がまたその場の変化なら、MAX_VIA 段まで繰り返す
      for (let round = 0; round < MAX_VIA && !this.stop; round++) {
        const more = this.planCompounds(level);
        if (!more.length) break;
        await this.runTasks(more);
      }
      this.finishLevel(level);
      this.writeCheckpoint();
      level = this.nextLevel.filter((id) => this.byId.has(id));
    }
  }

  /** 起点を撮る。開けなければ探索を始めない */
  private async captureRoot(): Promise<void> {
    const s = this.sessions[0];
    await s.fresh();
    let settled: boolean;
    try {
      settled = await s.gotoRoot();
    } catch (e) {
      throw new ExploreError(`起点 ${this.config.baseUrl} を開けません（${firstLine(e).replace(/^起点を開けません: /, '')}）。アプリが起動しているか、URL が正しいか確かめてください`, 'unreachable');
    }
    const snap = await s.stableSnapshot(settled);
    if (this.loginRe?.test(snap.url) && !this.loginRe.test(this.config.baseUrl)) {
      throw new ExploreError(`起点がログイン画面（${readableUrl(snap.url)}）に移りました。storageState が無いか期限切れです。ログインし直して保存し、--storage で渡してください`, 'auth');
    }
    if (this.config.storageState && snap.hasPassword) this.log('注意: 起点にパスワードの入力欄があります。storageState が期限切れかもしれません');
    await this.learnFrom(snap);
    const shot = join(this.pendingDir, 'root.png');
    await s.screenshot(shot);
    const root = this.createNode({ snap, shot, errors: s.drain(), storageChanged: false }, undefined, [], 0);
    await this.jevFilter(root);
    this.root = root.id;
    await s.close();
  }

  /** 深さ 1 段を終えたら、操作数の上限で試さなかった操作を画面に記録する */
  private finishLevel(level: string[]): void {
    for (const id of level) {
      const n = this.byId.get(id);
      const cut = this.cut.get(id) ?? 0;
      const revealedCut = this.compoundCut.get(id) ?? 0;
      if (!n || (cut <= 0 && revealedCut <= 0) || n.truncated) continue;
      const planned = n.actionsPlanned ?? n.actionsTotal;
      const parts: string[] = [];
      if (cut > 0) parts.push(`${planned} 件中 ${planned - cut} 件を試行・推定し、${cut} 件は試していない`);
      if (revealedCut > 0) parts.push(`この画面の中の変化で現れた操作 ${revealedCut} 件は試していない`);
      n.truncated = `操作数上限（${parts.join('。')}）`;
    }
  }

  async closeSessions(): Promise<void> {
    await Promise.all(this.sessions.map((s) => s.close()));
  }

  /** graph.json の形にする。URL の機微なクエリ値はここで伏せる */
  buildGraph(running = false): Graph {
    const isSensitive = paramMatcher(this.config.maskUrlParams);
    const mu = (u: string) => maskUrl(u, isSensitive);
    const mt = (t: string) => maskUrlsInText(t, isSensitive);
    const nodes: StateNode[] = this.nodes.map((n) => {
      const c: StateNode = structuredClone(n);
      c.url = mu(c.url);
      c.consoleErrors = c.consoleErrors.map(mt);
      c.failedRequests = c.failedRequests.map(mt);
      if (c.mergedUrls) c.mergedUrls = c.mergedUrls.map(mu);
      if (c.samples) c.samples = c.samples.map((x) => ({ ...x, url: mu(x.url) }));
      if (c.jevMerged) c.jevMerged = c.jevMerged.map((x) => ({ ...x, url: mu(x.url) }));
      if (c.externalLinks) c.externalLinks = c.externalLinks.map((x) => ({ ...x, href: mu(x.href) }));
      for (const l of c.localActions ?? []) if (l.action.href) l.action.href = mu(l.action.href);
      return c;
    });
    const maskAction = (a: ActionDesc): ActionDesc => (a.href ? { ...a, href: mu(a.href) } : { ...a });
    const edges: Edge[] = this.edges.map((e) => {
      const c: Edge = { ...e, action: maskAction(e.action) };
      if (c.via) c.via = c.via.map(maskAction);
      if (c.error) c.error = mt(c.error);
      return c;
    });
    this.stats.durationMs = Date.now() - this.startedAt.getTime();
    const stop = running ? { kind: 'interrupted' as StopKind, reason: '探索の途中で終了しました（最後に保存した時点の結果です）' } : this.stop;
    return {
      meta: {
        schemaVersion: SCHEMA_VERSION,
        signatureVersion: SIGNATURE_VERSION,
        tool: TOOL_VERSION,
        baseUrl: mu(this.config.baseUrl),
        startedAt: this.startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        totalStates: nodes.length,
        totalEdges: edges.length,
        ...(stop ? { stoppedBecause: mt(stop.reason), stopKind: stop.kind } : {}),
        learnedPathRules: this.learned.length ? [...this.learned] : undefined,
        learnedQueryVariants: this.learnedQueryVariants.length ? [...this.learnedQueryVariants] : undefined,
        stats: { ...this.stats },
        config: configSummary(this.config),
        jev: this.jevSummary,
      },
      root: this.root,
      nodes,
      edges,
    };
  }

  /** ノードごとの骨格（FLOWMAP_DEBUG 用） */
  debugStructures(): { id: string; url: string; route?: string; signature: string; structure: string[] }[] {
    return this.nodes.map((n) => {
      const rep = this.reps.get(n.id);
      return { id: n.id, url: n.url, route: n.route, signature: n.signature, structure: rep ? this.sig(rep).structure.split('\n') : [] };
    });
  }

  /** 深さ 1 段ごとに途中経過を書き出す。途中で落ちても、そこまでの結果を pnpm render で見られる */
  private writeCheckpoint(): void {
    if (this.root) writeGraph(this.runDir, this.buildGraph(true));
  }
}

function writeGraph(runDir: string, graph: Graph): void {
  const tmp = join(runDir, 'graph.json.tmp');
  writeFileSync(tmp, JSON.stringify(graph, null, 2));
  renameSync(tmp, join(runDir, 'graph.json'));
}

function readStorageState(path: string): StorageStateObject {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StorageStateObject;
  } catch (e) {
    throw new ExploreError(`storageState を読めません: ${path}（${(e as Error).message}）`, 'storage');
  }
}

/** 探索して graph.json と shots/ を書き出す。前回の実行があれば差分も付ける */
export async function explore({ config, log = console.log, signal, quiet = false }: ExploreOptions): Promise<ExploreResult> {
  const startedAt = new Date();
  const runsDir = resolve(config.outDir, 'runs');
  const runName = timestampDir(startedAt);
  const runDir = join(runsDir, runName);

  // 始める前に確かめられることは確かめる（比較対象・認証状態・Jev のキー）
  let baseline: BaselineRef | undefined;
  try {
    baseline = findBaseline(runsDir, runName, config.baseline);
  } catch (e) {
    throw new ExploreError((e as Error).message, 'baseline');
  }
  const storageState = config.storageState ? readStorageState(config.storageState) : undefined;
  let judge: JevJudge | undefined;
  if (config.jev.enabled) {
    const cachePath = join(resolve(config.outDir), 'jev-cache.json');
    try {
      judge = await JevJudge.open({ model: config.jev.model, cachePath });
    } catch (e) {
      throw new ExploreError((e as Error).message, 'jev');
    }
    const uses = [config.jev.actions && '危険な操作', config.jev.pages && '画面の合流', config.jev.dataSegments && 'データ区間'].filter(Boolean).join('・');
    log(`Jev を使います（${config.jev.model}・${uses || '判定なし'}）。画面のタイトル・見出し・操作のラベル・URL のパスを typesafe.ai に送ります`);
    // Jev の値は実行ごとに少し揺れる。キャッシュが無いと前回と違う判定になり、押す操作や合流が変わって差分に出ることがある
    if (baseline && !existsSync(cachePath)) log(`注意: Jev の判定のキャッシュ（${cachePath}）がありません。前回と判定が変わると差分に表れます。CI ではこのファイルを実行間で引き継いでください`);
  }

  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: config.headless,
      channel: config.browserChannel ?? undefined,
      executablePath: process.env.FLOWMAP_CHROMIUM_PATH || undefined,
      // Ctrl-C は CLI が受けて、そこまでの結果を書き出してから終える。Playwright の既定はブラウザを閉じてすぐ終了してしまう
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  } catch (e) {
    throw new ExploreError(`ブラウザを起動できません（${firstLine(e)}）。pnpm exec playwright install chromium を実行するか、環境変数 FLOWMAP_CHROMIUM_PATH に Chromium の実行ファイルを指定してください`, 'browser');
  }

  const pendingDir = join(runDir, 'shots', '.pending');
  mkdirSync(pendingDir, { recursive: true });
  log(`探索開始: ${config.baseUrl} → ${runDir}（並列 ${config.workers}）`);
  const ex = new Explorer(config, runDir, pendingDir, storageState, log, quiet, judge);
  ex.setStart(startedAt);
  const onAbort = () => ex.halt('interrupted', '中断されました（Ctrl-C）。そこまでの結果を書き出します');
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort);
  const timer = config.maxDurationMinutes > 0
    ? setTimeout(() => ex.halt('maxDuration', `時間上限 ${config.maxDurationMinutes} 分に到達`), config.maxDurationMinutes * 60_000)
    : undefined;
  try {
    await ex.run(browser);
  } catch (e) {
    if (!ex.root) {
      // 起点を撮る前に失敗したら、空の実行ディレクトリは残さない（比較対象の選択を乱さないため）
      rmSync(runDir, { recursive: true, force: true });
      throw e;
    }
    ex.halt('error', `探索中にエラー: ${firstLine(e)}`);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await ex.closeSessions();
    await browser.close().catch(() => {});
    judge?.save();
    rmSync(pendingDir, { recursive: true, force: true });
  }

  const graph = ex.buildGraph();
  if (baseline) graph.diff = computeDiff(graph, runDir, baseline);
  writeGraph(runDir, graph);

  const st = ex.stats;
  const secs = Math.round(st.durationMs / 1000);
  log(`試行 ${st.attempts} / 起点からの再現 ${st.replays} / 「戻る」で復帰 ${st.backReturns} / 推定した辺 ${st.inferredEdges} / 省いた共通操作 ${st.skippedCommon}${st.replayDrift ? ` / 再現の不一致 ${st.replayDrift}` : ''}`);
  if (st.localChanges) log(`この画面の中の変化 ${st.localChanges}（現れた操作を続けて試行 ${st.revealedTried ?? 0}・同じ形の行で省いた操作 ${st.skippedRepeats ?? 0}・部品を除いて合流 ${st.variantJoins ?? 0}）`);
  if (judge) {
    const j = graph.meta.jev!;
    log(`Jev: 問い合わせ ${j.requests} 回（キャッシュ ${j.cacheHits} 回）/ 押さなかった操作 ${j.skippedActions} / 合流 ${j.mergedStates} / 見送ったデータ区間 ${j.rejectedPathRules.length}${j.errors ? ` / 失敗 ${j.errors} 回（${j.lastError}）` : ''}`);
  }
  const d = graph.diff;
  log(`完了: 画面 ${graph.nodes.length} / 操作 ${graph.edges.length} / ${Math.floor(secs / 60)}分${secs % 60}秒${d ? ` / 前回比 追加 ${d.added.length} 消失 ${d.removed.length} 変化 ${d.changed.length} 新エラー ${d.newErrors.length}` : ''}`);
  if (d?.warning) log(`注意: ${d.warning}`);
  if (process.env.FLOWMAP_DEBUG) {
    // なぜ別の画面になったかを調べる用に、各ノードの骨格と処理ごとの所要時間を残す
    writeFileSync(join(runDir, 'debug-structures.json'), JSON.stringify(ex.debugStructures(), null, 2));
    log('所要時間の内訳（合計ミリ秒 / 回数）: ' + [...PROFILE].sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => `${k} ${Math.round(v.ms)}/${v.n}`).join(', '));
  }
  return { runDir, graph };
}
