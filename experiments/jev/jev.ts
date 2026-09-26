// 試験用の薄い層。問い・API の呼び出し・state の組み立ては本体の src/jev.ts をそのまま使い、
// 試験と探索で同じ問いを測るようにする。

export { callJev, loadApiKey as apiKey, mergeScore, PAGE_SPLIT, QUESTIONS, type Variant } from '../../src/jev.js';

export const MODEL = 'jev-latest';

/** items を n 本ずつ並行に処理する */
export async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
