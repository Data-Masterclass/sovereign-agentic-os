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
 *   - The locale comes from `requestLocaleState()` (the saved preference, else this user's cookie, else English;
 *     signed out: the cookie alone) — the same reader the root layout uses to re-set a stale cookie.
 *   - Missing keys: the catalogs are English-merged; a key missing even in English renders '' and is logged, never
 *     shown raw (`getMessageFallback`).
 */
import { getRequestConfig } from 'next-intl/server';
import { requestLocaleState } from '@core/i18n/request-state';
import { loadMessages } from '@core/i18n/catalog';
import { missingMessageText } from '@core/i18n/fallback';

export default getRequestConfig(async () => {
  const { locale } = await requestLocaleState();
  return {
    locale,
    messages: loadMessages(locale),
    onError(error) {
      console.error(`[i18n] ${error.code}: ${error.message}`);
    },
    getMessageFallback: () => missingMessageText(),
  };
});
