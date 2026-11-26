/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { sessionCookieOptions } from '@core/kernel/session';
import { getUserLocale, setUserLocale } from '@core/prefs/locale';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, LOCALES, isLocale, serializeLocaleCookie } from '@core/i18n/config';

export const dynamic = 'force-dynamic';

/** GET /api/prefs/locale → { locale } — the session user's UI language (English when never chosen). */
export const GET = withRoute(async ({ user }) => {
  return NextResponse.json({ locale: await getUserLocale(user.id), locales: LOCALES });
}, { defaultStatus: 500 });

/**
 * PUT /api/prefs/locale { locale } — saves the session user's language server-side and mirrors it into the
 * user-bound locale cookie, so the next server render is already in that language. The user id always comes from
 * the session. A personal preference, not a governed artifact: nothing here widens any access.
 */
export const PUT = withRoute<Record<string, string>, Record<string, unknown>>(async ({ user, body }) => {
  const locale = body?.locale;
  if (!isLocale(locale)) {
    return NextResponse.json({ error: `locale must be one of ${LOCALES.join(', ')}` }, { status: 400 });
  }
  const saved = await setUserLocale(user.id, locale);
  if (!saved.ok) {
    return NextResponse.json({ error: 'Your language could not be saved right now. Try again in a moment.' }, { status: 503 });
  }
  const res = NextResponse.json({ ok: true, locale });
  res.cookies.set(LOCALE_COOKIE, serializeLocaleCookie(locale, user.id), sessionCookieOptions({ maxAge: LOCALE_COOKIE_MAX_AGE }));
  return res;
}, { parse: true, defaultStatus: 500 });
