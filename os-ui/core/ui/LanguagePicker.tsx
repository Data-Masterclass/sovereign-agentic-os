/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    LanguagePicker — the user's UI language, under My Settings
 * USER STORY: As a user I pick my language from a list that shows each one in its own name (English, Deutsch,
 *             Français, …); the whole OS switches at once, without signing out, and stays that way on every device.
 * ARCHITECTURE:
 *   - A native <select> with a visible <label>: keyboard, screen reader and mobile pickers work with no custom
 *     widget. The options are `LOCALE_NAMES` (endonyms — never translated).
 *   - Saving PUTs `/api/prefs/locale` (server-side preference + the user-bound cookie mirror), then
 *     `router.refresh()` re-renders the server tree in the new language; the client provider receives the new
 *     messages with it. No full reload, no logout.
 *   - The status line is an aria-live region; a failed save puts the previous choice back and says so.
 * I18N:       converted (wave 1) — texts from `settings.language.*`.
 */
'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from '@core/i18n/client';
import { LOCALES, LOCALE_NAMES, isLocale, type Locale } from '@core/i18n/config';

export default function LanguagePicker() {
  const t = useTranslations('settings');
  const current = useLocale() as Locale;
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState<Locale>(current);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [, startTransition] = useTransition();

  async function choose(next: string) {
    if (!isLocale(next) || next === value) return;
    const previous = value;
    setValue(next);
    setStatus('saving');
    try {
      const res = await fetch('/api/prefs/locale', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setStatus('saved');
      startTransition(() => router.refresh());
    } catch {
      setValue(previous);
      setStatus('failed');
    }
  }

  return (
    <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <label htmlFor={id} style={{ fontWeight: 600 }}>{t('language.label')}</label>
      <select
        id={id}
        value={value}
        disabled={status === 'saving'}
        onChange={(e) => choose(e.target.value)}
        aria-describedby={`${id}-status`}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
      <span id={`${id}-status`} className="muted" role="status" aria-live="polite">
        {status === 'saving' ? t('language.saving') : status === 'saved' ? t('language.saved') : status === 'failed' ? t('language.failed') : ''}
      </span>
    </div>
  );
}
