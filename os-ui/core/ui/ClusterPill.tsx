/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The page-header cluster pill
 * USER STORY: As a user I want the header pill to show the real state of the platform services.
 * ARCHITECTURE:
 *   - Client component: reads `/api/status` on mount and every minute; the wording comes from
 *     the pure `cluster-pill.ts`. A failed read says "Cluster status unknown", never "Live".
 */
'use client';
import { useEffect, useState } from 'react';
import { clusterPillState, type ClusterStatus } from '@core/ui/cluster-pill';

/** The page-header cluster pill: the real stack status from `/api/status`, re-read every minute. */
export default function ClusterPill() {
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/status', { cache: 'no-store' });
        const data = (await res.json()) as { up?: number; total?: number };
        if (!alive) return;
        if (!res.ok || typeof data.up !== 'number' || typeof data.total !== 'number') setFailed(true);
        else {
          setFailed(false);
          setStatus({ up: data.up, total: data.total });
        }
      } catch {
        if (alive) setFailed(true);
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const s = clusterPillState(status, failed);
  return (
    <span className="pill" title={s.title}>
      <span className={s.tone === 'up' ? 'live' : `status-dot ${s.tone}`} />
      {s.label}
    </span>
  );
}
