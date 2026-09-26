// Jev の試験に使う、正解ラベル付きのケース定義。
//
// 3 つの問いを試す。
//   links   : 同じ形の兄弟リンク群は「同じ画面を別データについて開く」ものか（データ区間の自動学習の代わりになるか）
//   pages   : 2 つの画面は「同じ画面に別データを表示したもの」か（探索後に、分かれたノードを合流させるレビュー）
//   actions : その操作はサーバーに記録されたデータを変えるか（denyText のキーワード除外の補強になるか）
//
// 正解は flowmap の設計（DESIGN.md §5）に合わせる。タブ切替・メニューの開閉・ダイアログは「別の状態」なので pages では false。
// 問いの criteria に書く例は、ここのケースと重ならないようにする（答えを教えてしまうと試験にならない）。

export const APPS = {
  nagaku: 'http://localhost:8787',
  demo: 'http://localhost:3210',
} as const;
export type AppKey = keyof typeof APPS;

/** 実際の探索で自動学習されたデータ区間。pages の機械的判定（シグネチャ一致）に使う */
export const LEARNED_PREFIXES: Record<AppKey, string[]> = {
  nagaku: ['/companies', '/company', '/ranking'],
  demo: ['/items'],
};

// ---------- links: 兄弟リンク群 ----------

/** 動いているアプリの画面から、条件に合うリンクを集めてリンク群にする */
export interface LiveLinkGroup {
  id: string;
  app: AppKey;
  pageUrl: string;
  /** デコード済みの href に対する条件 */
  pick: RegExp;
  max: number;
  truth: boolean;
  note: string;
}

/** 架空のリンク群。機械的ルールが苦手な形を試すために作る */
export interface SyntheticLinkGroup {
  id: string;
  origin: string;
  page: { title: string; heading: string; url: string };
  links: { label: string; href: string }[];
  truth: boolean;
  note: string;
}

export const LIVE_LINK_GROUPS: LiveLinkGroup[] = [
  { id: 'nagaku-industries', app: 'nagaku', pageUrl: '/companies', pick: /^\/companies\/[^/?]+$/, max: 8, truth: true, note: '業種ごとの企業一覧' },
  { id: 'nagaku-companies', app: 'nagaku', pageUrl: '/companies', pick: /^\/company\/\d+$/, max: 8, truth: true, note: '企業ごとの詳細' },
  { id: 'nagaku-kana', app: 'nagaku', pageUrl: '/companies', pick: /[?&]kana=/, max: 8, truth: true, note: '五十音の絞り込み（クエリ）' },
  { id: 'nagaku-pages', app: 'nagaku', pageUrl: '/companies', pick: /[?&]page=/, max: 8, truth: true, note: 'ページ送り（クエリ）' },
  { id: 'nagaku-ranking-axes', app: 'nagaku', pageUrl: '/ranking', pick: /^\/ranking\?axes=/, max: 6, truth: true, note: 'ランキングの軸の組み合わせ（クエリ）' },
  { id: 'nagaku-top-nav', app: 'nagaku', pageUrl: '/', pick: /^\/(companies|ranking|about\/score)$/, max: 8, truth: false, note: 'トップの主要セクション' },
  { id: 'demo-items', app: 'demo', pageUrl: '/items', pick: /^\/items\/\d+$/, max: 8, truth: true, note: '商品ごとの詳細（ラベルは全部「詳細」）' },
  { id: 'demo-nav', app: 'demo', pageUrl: '/', pick: /^\/(items|contact|settings|report|about)$/, max: 8, truth: false, note: 'ヘッダの各セクション' },
];

const SHOP = 'https://shop.example';
export const SYNTHETIC_LINK_GROUPS: SyntheticLinkGroup[] = [
  {
    id: 'syn-settings-sections', origin: SHOP, truth: false,
    note: '設定の各セクション。機械的ルールは /settings/* をデータ区間と誤って学習する',
    page: { title: 'アカウント設定', heading: '設定', url: '/settings' },
    links: [
      { label: 'プロフィール', href: '/settings/profile' },
      { label: 'セキュリティ', href: '/settings/security' },
      { label: 'お支払い方法', href: '/settings/billing' },
      { label: '通知', href: '/settings/notifications' },
    ],
  },
  {
    id: 'syn-admin-sections', origin: SHOP, truth: false,
    note: '管理画面の各セクション。機械的ルールは /admin/* を誤って学習する',
    page: { title: '管理画面', heading: 'ダッシュボード', url: '/admin' },
    links: [
      { label: 'ユーザー管理', href: '/admin/users' },
      { label: '注文管理', href: '/admin/orders' },
      { label: '商品管理', href: '/admin/products' },
      { label: '売上レポート', href: '/admin/reports' },
    ],
  },
  {
    id: 'syn-account-sections', origin: SHOP, truth: false,
    note: 'マイページの各セクション',
    page: { title: 'マイページ', heading: 'マイページ', url: '/account' },
    links: [
      { label: '注文履歴', href: '/account/orders' },
      { label: 'お届け先', href: '/account/addresses' },
      { label: 'お気に入り', href: '/account/favorites' },
      { label: 'クーポン', href: '/account/coupons' },
    ],
  },
  {
    id: 'syn-corporate-pages', origin: SHOP, truth: false,
    note: 'サイトの主要ページ（先頭区間）',
    page: { title: 'ホーム', heading: 'ようこそ', url: '/' },
    links: [
      { label: '料金', href: '/pricing' },
      { label: '導入事例', href: '/customers' },
      { label: '採用情報', href: '/careers' },
      { label: 'お問い合わせ', href: '/contact' },
    ],
  },
  {
    id: 'syn-users', origin: SHOP, truth: true,
    note: 'メンバーごとのページ',
    page: { title: 'メンバー', heading: 'メンバー一覧', url: '/users' },
    links: [
      { label: '佐藤 花子', href: '/users/hanako' },
      { label: '鈴木 一郎', href: '/users/ichiro' },
      { label: '高橋 美咲', href: '/users/misaki' },
      { label: '田中 翔', href: '/users/sho' },
    ],
  },
  {
    id: 'syn-products', origin: SHOP, truth: true,
    note: '商品ごとのページ（slug）',
    page: { title: '新着商品', heading: '新着商品', url: '/new' },
    links: [
      { label: 'リネンシャツ', href: '/products/linen-shirt' },
      { label: 'デニムジャケット', href: '/products/denim-jacket' },
      { label: 'ウールコート', href: '/products/wool-coat' },
      { label: 'キャンバススニーカー', href: '/products/canvas-sneakers' },
    ],
  },
  {
    id: 'syn-categories', origin: SHOP, truth: true,
    note: 'カテゴリごとの一覧',
    page: { title: 'カテゴリ', heading: 'カテゴリから探す', url: '/category' },
    links: [
      { label: '靴', href: '/category/shoes' },
      { label: 'バッグ', href: '/category/bags' },
      { label: '帽子', href: '/category/hats' },
      { label: '時計', href: '/category/watches' },
    ],
  },
  {
    id: 'syn-root-usernames', origin: SHOP, truth: true,
    note: '先頭区間がユーザー名。機械的ルールは先頭区間を対象にしないので取りこぼす',
    page: { title: 'おすすめのユーザー', heading: 'おすすめのユーザー', url: '/explore' },
    links: [
      { label: '@hanako', href: '/hanako' },
      { label: '@ichiro', href: '/ichiro' },
      { label: '@misaki', href: '/misaki' },
      { label: '@sho', href: '/sho' },
    ],
  },
];

// ---------- pages: 画面の組 ----------

export interface PageRef {
  app: AppKey;
  url: string;
  /** 撮影前にクリックする要素（Playwright のセレクタ）。タブ切替やダイアログ表示の状態を作る */
  click?: string;
}

export interface PagePair {
  id: string;
  a: PageRef;
  b: PageRef;
  truth: boolean;
  note: string;
}

const CO_A = '6010601048836';
const CO_B = '4120001074705';
const CO_C = '8010001039574';
const ALL_AXES = 'time%2Cretention%2Cfamily%2Cincome%2Cstability%2Cgrowth';

export const PAGE_PAIRS: PagePair[] = [
  { id: 'nagaku-industry-lists', truth: true, note: '業種違いの企業一覧', a: { app: 'nagaku', url: '/companies/サービス業' }, b: { app: 'nagaku', url: '/companies/小売業' } },
  { id: 'nagaku-company-diff-skeleton', truth: true, note: '開示項目が違う企業詳細（骨格が違うので flowmap は分ける）', a: { app: 'nagaku', url: `/company/${CO_A}` }, b: { app: 'nagaku', url: `/company/${CO_B}` } },
  { id: 'nagaku-company-same-skeleton', truth: true, note: '企業詳細', a: { app: 'nagaku', url: `/company/${CO_A}` }, b: { app: 'nagaku', url: `/company/${CO_C}` } },
  { id: 'nagaku-pagination', truth: true, note: 'ページ送り', a: { app: 'nagaku', url: '/companies?page=2' }, b: { app: 'nagaku', url: '/companies?page=42' } },
  { id: 'nagaku-search-terms', truth: true, note: '検索語違い（結果なし／あり）', a: { app: 'nagaku', url: '/search?q=flowmap' }, b: { app: 'nagaku', url: '/search?q=トヨタ' } },
  { id: 'nagaku-compare-count', truth: true, note: '比較する社数の違い', a: { app: 'nagaku', url: `/compare?cn=${CO_A}` }, b: { app: 'nagaku', url: `/compare?cn=${CO_A}&cn=${CO_C}` } },
  { id: 'nagaku-small-industry', truth: true, note: '件数が少なくページ送りのない業種', a: { app: 'nagaku', url: '/companies/サービス業' }, b: { app: 'nagaku', url: '/companies/鉱業' } },
  { id: 'nagaku-ranking-axes', truth: true, note: 'ランキングの軸違い', a: { app: 'nagaku', url: `/ranking?axes=${ALL_AXES}` }, b: { app: 'nagaku', url: '/ranking?axes=income%2Cstability%2Cgrowth' } },
  // 違いのない組。「別のデータ」と書いた問いは、これを字義どおり false と答えた
  { id: 'nagaku-identical-company', truth: true, note: '同じ企業詳細を 2 回（違いなし）', a: { app: 'nagaku', url: `/company/${CO_A}` }, b: { app: 'nagaku', url: `/company/${CO_A}` } },
  { id: 'nagaku-ranking-default', truth: true, note: '既定のランキングと全軸の指定（内容は同じ）', a: { app: 'nagaku', url: '/ranking' }, b: { app: 'nagaku', url: `/ranking?axes=${ALL_AXES}` } },
  { id: 'demo-identical-list', truth: true, note: '同じ商品一覧を 2 回（違いなし）', a: { app: 'demo', url: '/items' }, b: { app: 'demo', url: '/items' } },
  { id: 'nagaku-top-vs-list', truth: false, note: 'トップと企業一覧', a: { app: 'nagaku', url: '/' }, b: { app: 'nagaku', url: '/companies' } },
  { id: 'nagaku-list-vs-ranking', truth: false, note: 'どちらも企業の一覧だが目的が違う', a: { app: 'nagaku', url: '/companies' }, b: { app: 'nagaku', url: '/ranking' } },
  { id: 'nagaku-company-vs-compare', truth: false, note: '企業詳細と比較', a: { app: 'nagaku', url: `/company/${CO_A}` }, b: { app: 'nagaku', url: `/compare?cn=${CO_A}` } },
  { id: 'nagaku-menu-open', truth: false, note: 'ヘッダのメニューの開閉', a: { app: 'nagaku', url: '/' }, b: { app: 'nagaku', url: '/', click: 'summary >> nth=0' } },
  { id: 'nagaku-about-vs-company', truth: false, note: '説明ページと企業詳細', a: { app: 'nagaku', url: '/about/score' }, b: { app: 'nagaku', url: `/company/${CO_A}` } },
  { id: 'demo-item-details', truth: true, note: '商品詳細', a: { app: 'demo', url: '/items/1' }, b: { app: 'demo', url: '/items/2' } },
  { id: 'demo-settings-tab', truth: false, note: 'タブ切替', a: { app: 'demo', url: '/settings' }, b: { app: 'demo', url: '/settings', click: 'role=tab[name="通知設定"]' } },
  { id: 'demo-help-dialog', truth: false, note: 'ダイアログ表示', a: { app: 'demo', url: '/' }, b: { app: 'demo', url: '/', click: 'text=ヘルプを開く' } },
  { id: 'demo-contact-vs-thanks', truth: false, note: '入力と完了', a: { app: 'demo', url: '/contact' }, b: { app: 'demo', url: '/thanks' } },
  { id: 'demo-list-vs-detail', truth: false, note: '一覧と詳細', a: { app: 'demo', url: '/items' }, b: { app: 'demo', url: '/items/1' } },
];

// ---------- actions: 操作の判定 ----------

export interface ActionCase {
  id: string;
  lang: 'ja' | 'en';
  page: string;
  element: 'button' | 'link' | 'tab' | 'summary';
  label: string;
  /** true = サーバーに記録されたデータを変える（探索で押すべきでない） */
  truth: boolean;
}

const ja = (id: string, page: string, element: ActionCase['element'], label: string, truth: boolean): ActionCase => ({ id: `ja-${id}`, lang: 'ja', page, element, label, truth });
const en = (id: string, page: string, element: ActionCase['element'], label: string, truth: boolean): ActionCase => ({ id: `en-${id}`, lang: 'en', page, element, label, truth });

export const ACTION_CASES: ActionCase[] = [
  // データを変える操作
  ja('ship', '注文詳細', 'button', '出荷する', true),
  ja('approve', '申請詳細', 'button', '承認する', true),
  ja('reject', '申請詳細', 'button', '却下する', true),
  ja('transfer', '送金', 'button', '送金する', true),
  ja('place-order', 'カート', 'button', '注文を確定する', true),
  ja('cancel-order', '注文詳細', 'button', '注文をキャンセルする', true),
  ja('publish', '記事の編集', 'button', '公開する', true),
  ja('invite', 'メンバー', 'button', '招待を送る', true),
  ja('archive', '受信トレイ', 'button', 'アーカイブ', true),
  ja('like', '投稿', 'button', 'いいね', true),
  ja('follow', 'プロフィール', 'button', 'フォローする', true),
  ja('restock', '商品詳細', 'button', '在庫を補充する', true),
  ja('submit', 'お問い合わせ', 'button', '送信する', true),
  ja('save', '設定', 'button', '保存する', true),
  ja('withdraw', '設定', 'button', '退会する', true),
  ja('delete-item', '商品詳細', 'button', 'この商品を削除', true),
  ja('logout', 'ヘッダ', 'button', 'ログアウト', true),
  ja('apply', 'キャンペーン', 'button', '申し込む', true),
  ja('pay', '請求書', 'button', '支払う', true),
  ja('cancel-reservation', '予約詳細', 'button', '予約を取り消す', true),
  // 見るだけの操作
  ja('view-products', 'ダッシュボード', 'link', '商品一覧を見る', false),
  ja('details', '商品一覧', 'link', '詳細', false),
  ja('next', '検索結果', 'link', '次へ', false),
  ja('close', 'ダイアログ', 'button', '閉じる', false),
  ja('cancel-dialog', 'ダイアログ', 'button', 'キャンセル', false),
  ja('search', 'ヘッダ', 'button', '検索', false),
  ja('open-help', 'ダッシュボード', 'button', 'ヘルプを開く', false),
  ja('tab', '設定', 'tab', '通知設定', false),
  ja('sort', '商品一覧', 'button', '新しい順に並べ替え', false),
  ja('filter', '商品一覧', 'button', '絞り込む', false),
  ja('more', 'お知らせ', 'button', 'もっと見る', false),
  ja('print', '請求書', 'button', '印刷する', false),
  ja('csv', '売上レポート', 'link', 'CSV をダウンロード', false),
  ja('back', '商品詳細', 'link', '一覧へ戻る', false),
  ja('compare', '企業詳細', 'link', 'この会社を他社と比べる', false),
  ja('edit', '商品詳細', 'link', '編集', false),
  ja('version', 'このアプリについて', 'summary', 'バージョン情報を表示', false),
  ja('industry', '企業一覧', 'link', 'サービス業 668', false),
  ja('weights', 'ヘッダ', 'summary', '重視する点： 均等（6 つの軸を同じ重さで見る）', false),
  ja('copy-link', '記事', 'button', '共有リンクをコピー', false),
  // 英語の対照（日本語との精度差を見る）
  en('ship', 'Order details', 'button', 'Ship', true),
  en('approve', 'Request details', 'button', 'Approve', true),
  en('place-order', 'Cart', 'button', 'Place order', true),
  en('cancel-order', 'Order details', 'button', 'Cancel order', true),
  en('publish', 'Edit post', 'button', 'Publish', true),
  en('invite', 'Members', 'button', 'Send invite', true),
  en('save', 'Settings', 'button', 'Save', true),
  en('logout', 'Header', 'button', 'Log out', true),
  en('view-products', 'Dashboard', 'link', 'View products', false),
  en('details', 'Product list', 'link', 'Details', false),
  en('next', 'Search results', 'link', 'Next', false),
  en('close', 'Dialog', 'button', 'Close', false),
  en('cancel-dialog', 'Dialog', 'button', 'Cancel', false),
  en('edit', 'Product details', 'link', 'Edit', false),
  en('csv', 'Sales report', 'link', 'Download CSV', false),
  en('print', 'Invoice', 'button', 'Print', false),
];

// ---------- 組み立て後のデータセット（capture.ts が書き、ask.ts が読む） ----------

export type Experiment = 'links' | 'pages' | 'actions';

export interface DatasetCase {
  id: string;
  experiment: Experiment;
  truth: boolean;
  note: string;
  source: 'live' | 'synthetic';
  /** state の中身の言語 */
  lang: 'ja' | 'en';
  /** 現行の機械的ルールの判定（links: データ区間として合流するか / pages: シグネチャが一致するか / actions: denyText に当たるか） */
  baseline: boolean;
  /** Jev に送る state */
  state: unknown;
}

export interface Dataset {
  createdAt: string;
  cases: DatasetCase[];
}
