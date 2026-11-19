/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Monaco editor theme that follows the OS light/dark toggle
 * USER STORY: As someone editing a file in the Agents or Software tab I want the code editor to
 *             switch to dark when I switch the OS to dark, without reloading.
 * ARCHITECTURE:
 *   - Watches `data-theme` on <html> (set by `ThemeToggle`) with a MutationObserver and maps it
 *     to Monaco's built-in theme names. One shared hook instead of a copy per tab.
 */
'use client';

import { useEffect, useState } from 'react';

export function useMonacoTheme(): 'vs-dark' | 'light' {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const read = () => setDark(document.documentElement.getAttribute('data-theme') === 'dark');
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return dark ? 'vs-dark' : 'light';
}
