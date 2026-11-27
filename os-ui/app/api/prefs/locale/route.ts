/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute, apiError } from '@core/kernel/route-server';
import { sessionCookieOptions } from '@core/kernel/session';
import { getSavedLocale, getUserLocale, setUserLocale } from '@core/prefs/locale';
import { authorize, userPrefWriteDecision } from '@core/infra/governed';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, LOCALES, isLocale, serializeLocaleCookie } from '@core/i18n/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/prefs/locale → { locale } — the session user's UI language (English when never chosen). When a language
 * is saved, the response also re-sets the user-bound cookie to it: the root layout calls this when the cookie on
 * this device lags the saved preference (changed on another device). Writes nothing server-side.
 */
export const GET = withRoute(async ({ user }) => {
  const saved = await getSavedLocale(user.id);
  const res = NextResponse.json({ locale: saved ?? (await getUserLocale(user.id)), locales: LOCALES });
  if (saved) res.cookies.set(LOCALE_COOKIE, serializeLocaleCookie(saved, user.id), sessionCookieOptions({ maxAge: LOCALE_COOKIE_MAX_AGE }));
  return res;
}, { defaultStatus: 500 });

/**
 * PUT /api/prefs/locale { locale } — saves the session user's language server-side and mirrors it into the
 * user-bound locale cookie, so the next server render is already in that language. The user id always comes from
 * the session. Governed like every write (GLUE-7): OPA's `user_pref_write` allows a user their OWN preference
 * only, and an OPA that does not answer denies — nothing is saved then.
 */
export const PUT = withRoute<Record<string, string>, Record<string, unknown>>(async ({ user, body }) => {
  const locale = body?.locale;
  if (!isLocale(locale)) {
    return apiError(400, `locale must be one of ${LOCALES.join(', ')}`, 'governance.prefs.localeInvalid', { locales: LOCALES.join(', ') });
  }
  const authz = await authorize(`user:${user.id}`, 'user.pref.write', userPrefWriteDecision(user, 'locale'));
  if (!authz.allowed) {
    return apiError(403, 'Policy did not allow saving your language (or the policy engine did not answer). Nothing was changed.', 'policy.languageSaveDenied');
  }
  const saved = await setUserLocale(user.id, locale);
  if (!saved.ok) {
    return apiError(503, 'Your language could not be saved right now. Try again in a moment.', 'governance.prefs.languageSaveUnavailable');
  }
  const res = NextResponse.json({ ok: true, locale });
  res.cookies.set(LOCALE_COOKIE, serializeLocaleCookie(locale, user.id), sessionCookieOptions({ maxAge: LOCALE_COOKIE_MAX_AGE }));
  return res;
}, { parse: true, defaultStatus: 500 });
