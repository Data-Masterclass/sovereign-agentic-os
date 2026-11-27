/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       i18n
 * FEATURE:    The translation API for components — one import path for every wave
 * USER STORY: As a contributor converting a tab I write `const t = useTranslations('data')` and `t('list.empty')`,
 *             and `useFormat().date(x)` for a date, in a client OR a shared server component alike.
 * ARCHITECTURE:
 *   - Thin re-exports of next-intl (`useTranslations`, `useLocale`) plus `useFormat`, our locale-bound Intl
 *     formatters (`core/i18n/format.ts`). These hooks work in client components AND in non-async server
 *     components; an async server component uses `@core/i18n/server` instead.
 *   - Keys are type-checked against the English catalogs (`core/i18n/next-intl.d.ts`).
 *   - `useServerMessage` renders a server error body (`{ error, code?, params? }`) in the active language
 *     (i18n wave 4; core/i18n/server-message.ts).
 */
import { useCallback, useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formattersFor, type Formatters } from '@core/i18n/format';
import { renderServerMessage, type ServerTranslator } from '@core/i18n/server-message';

export { useTranslations, useLocale } from 'next-intl';

/** Dates, relative times, numbers, compact numbers, currency and sizes in the active language. */
export function useFormat(): Formatters {
  const locale = useLocale();
  return useMemo(() => formattersFor(locale), [locale]);
}

/**
 * Show a server message in the active language: `msg(body, fallback)` renders `server.<code>` (+ `params`) when the
 * body carries a known dotted code, else the English `error` the server sent, else `fallback` — i.e. a drop-in for
 * `body.error ?? fallback` (core/i18n/server-message.ts). Pass `'reason'` as the third argument for a `reason` field.
 * Display only: branch on status / `ok`, never on the returned text.
 */
export function useServerMessage(): (body: unknown, fallback?: string, field?: 'error' | 'reason' | 'message') => string {
  const t = useTranslations('server') as unknown as ServerTranslator;
  return useCallback((body, fallback = '', field = 'error') => renderServerMessage(t, body, fallback, field), [t]);
}
