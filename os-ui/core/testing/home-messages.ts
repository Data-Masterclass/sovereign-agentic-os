/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Render a `home` catalog key in a given language, for the view-model unit tests
 * USER STORY: As a maintainer I want the Ask-the-OS view-model tests to prove that the English a user reads is
 *             exactly what it was before i18n, and that every key a pure module returns exists in every language.
 * ARCHITECTURE: Reads `messages/<locale>/home.json` from disk (tests run with cwd `os-ui`) and formats the message
 *   with `intl-messageformat` — the same ICU engine next-intl uses at run time. A missing key throws, so a key a
 *   module returns but the catalog lacks fails the test. Test code only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IntlMessageFormat } from 'intl-messageformat';

const cache = new Map<string, Record<string, unknown>>();

function catalog(locale: string): Record<string, unknown> {
  let c = cache.get(locale);
  if (!c) {
    c = JSON.parse(readFileSync(join(process.cwd(), 'messages', locale, 'home.json'), 'utf8')) as Record<string, unknown>;
    cache.set(locale, c);
  }
  return c;
}

/** The formatted `home.<key>` message in `locale` (default English). Throws when the key is missing. */
export function homeText(v: { key: string; args?: Record<string, string | number> } | string, locale = 'en'): string {
  if (typeof v === 'string') return v;
  const msg = v.key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), catalog(locale));
  if (typeof msg !== 'string') throw new Error(`messages/${locale}/home.json has no message "${v.key}"`);
  return String(new IntlMessageFormat(msg, locale).format(v.args ?? {}));
}

export const HOME_LOCALES = ['en', 'de', 'fr', 'es', 'it', 'pl', 'cs'] as const;
