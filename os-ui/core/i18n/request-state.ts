/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       i18n
 * FEATURE:    What THIS request says about the language — the locale to render and whether the cookie is stale
 * USER STORY: As a user who changed my language on my laptop, my phone switches on its next page load and its
 *             cookie is corrected, instead of keeping the old language for a year.
 * ARCHITECTURE:
 *   - The one reader of the request's language inputs (the locale cookie, the SIGNED session id, the saved
 *     preference), used by next-intl's request config AND the root layout, so the two never disagree. The rules are
 *     the pure `resolveRequestLocale` / `localeCookieStale` in `config.ts`.
 *   - Only the signed session id is read (no user-directory call): the language is not a permission.
 *   - A preference store that does not answer is not a failed page: the mirror hydrates empty (it never throws), so
 *     `saved` is null and the cookie (or English) stands in, exactly as for a user who never chose.
 */
import 'server-only';
import { cookies } from 'next/headers';
import { config as appConfig } from '@core/kernel/config';
import { sessionTokenFrom, verifySession } from '@core/kernel/session';
import { getSavedLocale } from '@core/prefs/locale';
import { LOCALE_COOKIE, localeCookieStale, resolveRequestLocale, type Locale } from '@core/i18n/config';

export type RequestLocaleState = { locale: Locale; cookieStale: boolean };

export async function requestLocaleState(): Promise<RequestLocaleState> {
  const store = await cookies();
  const cookie = store.get(LOCALE_COOKIE)?.value ?? null;
  const claims = await verifySession(sessionTokenFrom((n) => store.get(n)?.value), appConfig.sessionSecret);
  const userId = claims?.id ?? null;
  const saved: Locale | null = userId ? await getSavedLocale(userId) : null;
  const input = { cookie, userId, saved };
  return { locale: resolveRequestLocale(input), cookieStale: localeCookieStale(input) };
}
