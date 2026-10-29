/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

/**
 * Appearance toggle (Settings). Light is the default; the choice persists in
 * localStorage and is applied to <html data-theme> (the same key the inline
 * boot script in layout.tsx reads before paint). The sidebar + topbar stay dark
 * in both modes — only the main content area switches.
 */
export default function ThemeToggle() {
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
    <div className="theme-toggle" role="group" aria-label="Theme">
      {(['light', 'dark'] as Theme[]).map((t) => (
        <button
          key={t}
          type="button"
          className={`theme-opt${theme === t ? ' active' : ''}`}
          aria-pressed={theme === t}
          onClick={() => apply(t)}
        >
          <span aria-hidden>{t === 'light' ? '☀' : '☾'}</span>
          {t === 'light' ? 'Light' : 'Dark'}
          {t === 'light' && <span className="default-tag">default</span>}
        </button>
      ))}
    </div>
  );
}
