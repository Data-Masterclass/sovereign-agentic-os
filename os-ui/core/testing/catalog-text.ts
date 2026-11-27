/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Render any namespace's catalog key in a given language, for the view-model unit tests
 * USER STORY: As a maintainer I want a converted tab's view-model tests to prove that the English a user reads is
 *             exactly what it was before i18n, and that every key a pure module returns exists in every language.
 * ARCHITECTURE: Reads `messages/<locale>/<namespace>.json` from disk (tests run with cwd `os-ui`) and formats the
 *   message with `intl-messageformat` — the same ICU engine next-intl uses at run time. A missing key throws, so a
 *   key a module returns but the catalog lacks fails the test. The namespace-generic twin of `home-messages.ts`.
 *   Test code only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IntlMessageFormat } from 'intl-messageformat';

const cache = new Map<string, Record<string, unknown>>();

function catalog(namespace: string, locale: string): Record<string, unknown> {
  const id = `${locale}/${namespace}`;
  let c = cache.get(id);
  if (!c) {
    c = JSON.parse(readFileSync(join(process.cwd(), 'messages', locale, `${namespace}.json`), 'utf8')) as Record<string, unknown>;
    cache.set(id, c);
  }
  return c;
}

function lookup(namespace: string, key: string, locale: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), catalog(namespace, locale));
}

export type CatalogMessage = { key: string; args?: Record<string, string | number | Date> };

/** True when `messages/<locale>/<namespace>.json` has a string at `key`. */
export function hasCatalogKey(namespace: string, key: string, locale = 'en'): boolean {
  return typeof lookup(namespace, key, locale) === 'string';
}

/** The formatted `<namespace>.<key>` message in `locale` (default English). Throws when the key is missing. */
export function catalogText(namespace: string, v: CatalogMessage | string, locale = 'en'): string {
  if (typeof v === 'string') return v;
  const msg = lookup(namespace, v.key, locale);
  if (typeof msg !== 'string') throw new Error(`messages/${locale}/${namespace}.json has no message "${v.key}"`);
  return String(new IntlMessageFormat(msg, locale).format(v.args ?? {}));
}

export const CATALOG_LOCALES = ['en', 'de', 'fr', 'es', 'it', 'pl', 'cs'] as const;
