/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       i18n
 * FEATURE:    next-intl's request config — which language THIS request renders in, and its catalogs
 * USER STORY: As a user who chose Deutsch, the very first byte of every page is German — no English flash,
 *             no /de/ in my URLs.
 * ARCHITECTURE:
 *   - Registered with `createNextIntlPlugin('./core/i18n/request.ts')` in next.config.mjs. next-intl is used
 *     WITHOUT locale routing: there is no middleware and no `[locale]` segment.
 *   - The locale is the user's saved preference: the user-bound cookie when present (set by PUT /api/prefs/locale,
 *     the freshest copy on this device), else the server-side store (`core/prefs/locale.ts`, so a new device is
 *     right on its first render), else English. Signed out (the sign-in page) reads the cookie's locale alone.
 *     `resolveRequestLocale` is the pure rule.
 *   - Only the SIGNED session id is read (no user-directory call): the language is not a permission, and the
 *     directory read belongs to the routes that authorise.
 *   - Missing keys: the catalogs are English-merged; a key missing even in English renders '' and is logged, never
 *     shown raw (`getMessageFallback`).
 */
import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { config as appConfig } from '@core/kernel/config';
import { sessionTokenFrom, verifySession } from '@core/kernel/session';
import { getSavedLocale } from '@core/prefs/locale';
import { LOCALE_COOKIE, resolveRequestLocale } from '@core/i18n/config';
import { loadMessages } from '@core/i18n/catalog';
import { missingMessageText } from '@core/i18n/fallback';

export default getRequestConfig(async () => {
  const store = await cookies();
  const cookie = store.get(LOCALE_COOKIE)?.value ?? null;
  let userId: string | null = null;
  try {
    const claims = await verifySession(sessionTokenFrom((n) => store.get(n)?.value), appConfig.sessionSecret);
    userId = claims?.id ?? null;
  } catch {
    userId = null;
  }
  let saved = null;
  if (userId) {
    try {
      saved = await getSavedLocale(userId);
    } catch {
      saved = null; // the prefs mirror is down: English (or the cookie) — never a failed page
    }
  }
  const locale = resolveRequestLocale({ cookie, userId, saved });
  return {
    locale,
    messages: loadMessages(locale),
    onError(error) {
      console.error(`[i18n] ${error.code}: ${error.message}`);
    },
    getMessageFallback: () => missingMessageText(),
  };
});
