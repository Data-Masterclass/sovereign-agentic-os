/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       i18n
 * FEATURE:    Server text in a GIVEN language, outside a request — notifications, report and alert bodies
 * USER STORY: As the recipient of a dashboard alert I read "Alarm ausgelöst: revenue" because I chose German, even
 *             though the alert was sent by someone else's request or by the worker.
 * ARCHITECTURE:
 *   - `serverTextFor(locale)` returns `text(code, params)` over the `server` catalog of that locale (merged over
 *     English, `core/i18n/catalog.ts`), formatted by next-intl's own `createTranslator` — the ICU engine the UI
 *     uses. A code the catalog lacks, or a formatting failure, returns the caller's English fallback.
 *   - The caller resolves WHOSE language: the recipient's saved preference (`getUserLocale(userId)`), never the
 *     sender's request locale. Text is rendered once, at write time, so the stored notification reads the same in
 *     the bell, the mirror and any later export.
 *   - No request, no React: usable in route handlers, the worker and unit tests.
 */
import { createTranslator } from 'next-intl';
import { loadMessages } from '@core/i18n/catalog';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@core/i18n/config';
import { translateServerCode, type ServerTranslator } from '@core/i18n/server-message';
import type { ServerParams } from '@core/kernel/server-message';

const cache = new Map<Locale, ServerTranslator>();

function translatorFor(locale: Locale): ServerTranslator {
  let t = cache.get(locale);
  if (!t) {
    const messages = loadMessages(locale) as Record<string, unknown>;
    t = createTranslator({
      locale,
      messages: { server: messages.server } as never,
      namespace: 'server' as never,
      onError: () => {},
      getMessageFallback: () => '',
    }) as unknown as ServerTranslator;
    cache.set(locale, t);
  }
  return t;
}

/** `text(code, params, english)` — `server.<code>` in `locale`, else the English fallback. */
export function serverTextFor(locale: string | null | undefined): (code: string, params: ServerParams | undefined, english: string) => string {
  const l: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const t = translatorFor(l);
  return (code, params, english) => translateServerCode(t, code, params) || english;
}
