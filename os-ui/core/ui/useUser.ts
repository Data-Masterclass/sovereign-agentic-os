/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * FEATURE:    useUser — the client hook for the signed-in user, their role and domains
 * USER STORY: As a UI component I want the current user's role, domains and enabled tabs so that
 *             I can show or hide controls and scope lists without asking the server myself.
 * ARCHITECTURE:
 *   - Reads `GET /api/auth/me` on mount and returns `{ user, loading, reload, isAdmin,
 *     domainChosen }`. A failed fetch leaves `user` null.
 *   - `domainChosen` defaults to true so `DomainStartPrompt` does not flash before the response
 *     arrives. `enabledFeatures` comes from the server, so the sidebar does not depend on a
 *     build-time default.
 *   - UI gating only. The API routes do the real permission checks.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Role } from '@core/kernel/session';

export type Me = {
  id: string;
  name: string;
  /** Effective (active-domain-narrowed) scope. */
  domains: string[];
  /** Every domain the user belongs to — powers the sidebar domain switcher. */
  allDomains?: string[];
  /** The chosen active operating domain, or null = all domains. */
  activeDomain?: string | null;

  /** Enabled tab feature keys for this deployment (OS_ENABLED_TABS), read live
   *  from the server so a 'use client' sidebar never bakes in a build-time
   *  default. */
  enabledFeatures?: string[];
  role: Role;
};

/** Client hook for the signed-in user (role gating + workspace scoping in UI). */
export function useUser() {
  const [user, setUser] = useState<Me | null>(null);
  // Default true so the one-time prompt never flashes before /me resolves.
  const [domainChosen, setDomainChosen] = useState(true);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      const body = await res.json();
      setUser(body.user ?? null);
      setDomainChosen(Boolean(body.domainChosen));
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { user, loading, reload, isAdmin: user?.role === 'admin', domainChosen };
}
