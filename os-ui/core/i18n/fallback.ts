/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       i18n
 * FEATURE:    English fallback — a key a language has not translated yet shows the English text, never a raw key
 * USER STORY: As a Polish user on a page a later wave has not finished, I read English for the missing line
 *             rather than `data.list.empty`.
 * ARCHITECTURE:
 *   - Pure and import-free. `withEnglishFallback` deep-merges a locale's catalog OVER the English one, so a missing
 *     key resolves to English before next-intl ever looks it up. CI (scripts/check-i18n.mjs) keeps catalogs in
 *     parity, so in a release this is a belt-and-braces path, not the normal one.
 *   - `missingMessageText` is the last resort for a key missing even in English (a typo the type check would have
 *     caught): an empty string, never the dotted key.
 */

export type MessageTree = { [key: string]: string | MessageTree };

function isTree(v: unknown): v is MessageTree {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** English with the locale's translations laid over it. Empty strings in the locale do not override English. */
export function withEnglishFallback(en: MessageTree, other: MessageTree | null | undefined): MessageTree {
  if (!other) return en;
  const out: MessageTree = {};
  for (const [k, v] of Object.entries(en)) {
    const o = other[k];
    if (isTree(v)) out[k] = isTree(o) ? withEnglishFallback(v, o) : v;
    else out[k] = typeof o === 'string' && o.trim() !== '' ? o : v;
  }
  return out;
}

/** What a key that exists in NO catalog renders as: nothing (the error is logged by the caller). */
export function missingMessageText(): string {
  return '';
}
