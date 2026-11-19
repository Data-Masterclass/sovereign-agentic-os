/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    useApi — a small client-side GET hook returning { data, loading, error, reload }
 * USER STORY: As a page author I want a one-line way to load JSON from an OS API route, with
 *             the route's error message shown, so that read-only pages do not each write their
 *             own fetch state.
 * ARCHITECTURE:
 *   - Fetches `path` with `cache: 'no-store'` on mount and whenever `path` changes. A non-OK
 *     response sets `error` from the body's `error` field.
 *   - Used by app pages such as Monitoring, Components, MCP APIs and Software.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Tiny client-side fetch hook for the read-only surfaces (Software, Gateway,
 * Governance, Orchestration). Loads on mount, exposes { data, loading, error,
 * reload }. Errors surface the API route's `error` field.
 */
export function useApi<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(path, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? `Request failed (${res.status})`);
      else setData(body as T);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload };
}
