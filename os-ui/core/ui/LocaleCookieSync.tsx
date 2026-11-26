/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    LocaleCookieSync — re-sets a stale locale cookie from the saved preference
 * USER STORY: As a user with two devices, the one that still carries my old language cookie is corrected the
 *             first time it renders, so it keeps matching my choice (and the AI's language).
 * ARCHITECTURE:
 *   - Mounted by the root layout ONLY when `requestLocaleState()` found the cookie out of step with the saved
 *     preference (a server component cannot set a cookie). It asks `GET /api/prefs/locale`, which re-sets the
 *     cookie from the saved preference. The page itself already rendered in the saved language. Renders nothing.
 */
'use client';

import { useEffect } from 'react';

export default function LocaleCookieSync() {
  useEffect(() => {
    void fetch('/api/prefs/locale', { cache: 'no-store' }).catch(() => undefined);
  }, []);
  return null;
}
