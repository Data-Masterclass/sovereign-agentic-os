/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Role } from '@/lib/core/session';

export type Me = {
  id: string;
  name: string;
  /** Effective (active-domain-narrowed) scope. */
  domains: string[];
  /** Every domain the user belongs to — powers the sidebar domain switcher. */
  allDomains?: string[];
  /** The chosen active operating domain, or null = all domains. */
  activeDomain?: string | null;
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
