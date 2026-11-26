/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       i18n
 * FEATURE:    The translation API for async server components, route handlers and server code
 * USER STORY: As a contributor I write `const t = await getTranslations('settings')` in a server page, and the AI
 *             call sites ask `getUserLocale(user.id)` for the language to answer in.
 * ARCHITECTURE:
 *   - Re-exports next-intl's request-scoped helpers (`getTranslations`, `getLocale`) — these need a Next request.
 *   - `getUserLocale` / `getUserLocaleFresh` (from `core/prefs/locale.ts`) need none: the run worker and the AI
 *     generators use them with a user id. `answerLanguageInstruction` / `withAnswerLanguage` turn the result into
 *     the model instruction (`core/i18n/answer-language.ts`).
 */
import 'server-only';
import { getLocale } from 'next-intl/server';
import { formattersFor, type Formatters } from '@core/i18n/format';

export { getTranslations, getLocale } from 'next-intl/server';
export { getUserLocale, getUserLocaleFresh } from '@core/prefs/locale';
export { answerLanguageInstruction, withAnswerLanguage } from '@core/i18n/answer-language';

/** The locale-bound formatters for the current request. */
export async function getFormat(): Promise<Formatters> {
  return formattersFor(await getLocale());
}
