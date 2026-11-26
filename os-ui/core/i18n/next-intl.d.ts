/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * Type-safe translation keys: next-intl checks every key against the English source catalogs
 * (core/i18n/en-messages.ts), and every locale against the closed list in core/i18n/config.ts.
 */
import type { AppMessages } from '@core/i18n/en-messages';
import type { Locale } from '@core/i18n/config';

declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: AppMessages;
  }
}
