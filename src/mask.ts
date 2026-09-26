// 生成物（graph.json・index.html）に残す URL から、トークンなどの値を伏せる（DESIGN.md §6）。
// 探索中はそのままの URL を使い、書き出すときだけ伏せる。

const MASK = '***';

/** maskUrlParams の各要素（大小無視、* は任意の文字列）を 1 つの判定関数にする */
export function paramMatcher(patterns: string[]): (name: string) => boolean {
  if (!patterns.length) return () => false;
  const res = patterns.map((p) => new RegExp('^' + p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i'));
  return (name) => res.some((re) => re.test(name));
}

/** `?a=1&b=2#c=3` のような文字列の、機微な名前の値だけを伏せる。符号化は変えない */
function maskParams(query: string, isSensitive: (name: string) => boolean): string {
  return query.replace(/([^&=?#]+)=([^&#]*)/g, (all, k: string, v: string) => {
    let name = k;
    try { name = decodeURIComponent(k.replace(/\+/g, ' ')); } catch { /* そのまま */ }
    return v && isSensitive(name) ? `${k}=${MASK}` : all;
  });
}

/**
 * URL（絶対でも相対でもよい）のクエリとハッシュの中のパラメータ、userinfo のパスワードを伏せる。
 * OAuth のインプリシットフローはトークンをハッシュに載せる（#access_token=...）ので、ハッシュも見る。
 */
export function maskUrl(url: string, isSensitive: (name: string) => boolean): string {
  let out = url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/@?#]*:)([^/@?#]*)@/i, (_all, head: string, pass: string) => (pass ? `${head}${MASK}@` : _all));
  const i = out.search(/[?#]/);
  if (i >= 0) out = out.slice(0, i) + maskParams(out.slice(i), isSensitive);
  return out;
}

/** 文章中の URL（エラーメッセージ・失敗したリクエスト）を伏せる */
export function maskUrlsInText(text: string, isSensitive: (name: string) => boolean): string {
  return text.replace(/https?:\/\/[^\s"'<>`]+/g, (u) => maskUrl(u, isSensitive));
}
