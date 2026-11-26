/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * FEATURE:    ThemeToggle — switch between the light and dark theme
 * USER STORY: As a user I want to choose light or dark mode and have it remembered so that the OS
 *             is comfortable to read.
 * ARCHITECTURE:
 *   - Used by `app/(entry)/settings/page.tsx`. Stores the choice in localStorage (`soa-theme`) and
 *     sets `<html data-theme>`; the boot script in `layout.tsx` reads the same key before paint.
 *   - Light is the default; the sidebar and topbar stay dark in both modes.
 */
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from '@core/i18n/client';

type Theme = 'light' | 'dark';

/**
 * Appearance toggle (Settings). Light is the default; the choice persists in
 * localStorage and is applied to <html data-theme> (the same key the inline
 * boot script in layout.tsx reads before paint). The sidebar + topbar stay dark
 * in both modes — only the main content area switches.
 */
export default function ThemeToggle() {
  const t = useTranslations('settings');
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    const saved = (typeof localStorage !== 'undefined' &&
      (localStorage.getItem('soa-theme') as Theme)) || 'light';
    setTheme(saved === 'dark' ? 'dark' : 'light');
  }, []);

  function apply(next: Theme) {
    setTheme(next);
    try {
      localStorage.setItem('soa-theme', next);
    } catch {
      /* private mode — ignore */
    }
    if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }

  return (
    <div className="theme-toggle" role="group" aria-label={t('theme.title')}>
      {(['light', 'dark'] as Theme[]).map((o) => (
        <button
          key={o}
          type="button"
          className={`theme-opt${theme === o ? ' active' : ''}`}
          aria-pressed={theme === o}
          onClick={() => apply(o)}
        >
          <span aria-hidden>{o === 'light' ? '☀' : '☾'}</span>
          {o === 'light' ? t('theme.light') : t('theme.dark')}
          {o === 'light' && <span className="default-tag">{t('theme.default')}</span>}
        </button>
      ))}
    </div>
  );
}
