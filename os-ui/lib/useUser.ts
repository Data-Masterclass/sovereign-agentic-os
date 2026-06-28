/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Role } from '@/lib/session';

export type Me = { id: string; name: string; domains: string[]; role: Role };

/** Client hook for the signed-in user (role gating + workspace scoping in UI). */
export function useUser() {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      const body = await res.json();
      setUser(body.user ?? null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { user, loading, reload, isAdmin: user?.role === 'admin' };
}
