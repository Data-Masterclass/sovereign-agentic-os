/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useUser } from '@/lib/useUser';
import { SCOPE_GROUPS, groupByScope, scopeCounts, type ScopeKey } from '@/lib/scopes';
import { TIER_BADGE, TIER_LABEL } from './shared';
import type { DashboardGroups, DashboardSummary } from './shared';

/**
 * The dashboards LIST surface — every dashboard the user can see, grouped All · My · Shared ·
 * Marketplace via the OS-wide scope helper. Clicking a tile OPENS its detail, where the
 * embedded viewer (per-viewer guest token + RLS), Reports and Govern fold in.
 */
export default function Tiles({
  data,
  loading,
  error,
  onOpen,
}: {
  data: DashboardGroups | null;
  loading: boolean;
  error: string;
  onOpen: (d: DashboardSummary) => void;
}) {
  const [scope, setScope] = useState<ScopeKey>('all');
  const { user } = useUser();

  const uid = user?.id ?? '';
  const scoped = data ? groupByScope(data, uid) : null;
  const counts = data ? scopeCounts(data, uid) : null;
  const visible = scoped ? scoped[scope] : [];

  return (
    <>
      {error ? <div className="error" style={{ marginTop: 16 }}>{error}</div> : null}
      {loading && !data ? <div className="stub-page">Loading dashboards…</div> : null}

      {data ? (
        <div className="seg" style={{ marginTop: 16 }}>
          {SCOPE_GROUPS.map((g) => (
            <button key={g.key} type="button" className={scope === g.key ? 'on' : ''} onClick={() => setScope(g.key)}>
              {g.label('Dashboards')}{counts ? ` (${counts[g.key]})` : ''}
            </button>
          ))}
        </div>
      ) : null}

      {data && visible.length === 0 ? (
        <div className="stub-page" style={{ marginTop: 16 }}>
          {scope === 'mine' || scope === 'all'
            ? 'No dashboards yet — build one with ＋ New dashboard.'
            : scope === 'shared' ? 'Nothing shared in your domain yet.' : 'Nothing in the marketplace yet.'}
        </div>
      ) : null}

      {visible.length ? (
        <div className="tile-grid" style={{ marginTop: 16 }}>
          {visible.map((d) => (
            <button
              key={d.id}
              type="button"
              className="card tile"
              onClick={() => onOpen(d)}
              title="Open this dashboard — view, report, or govern it"
            >
              <div className="tile-top">
                <span className="tile-name">{d.name}</span>
                <span className={`badge ${TIER_BADGE[d.tier]}`}>{TIER_LABEL[d.tier]}</span>
              </div>
              <div className="tile-meta muted">
                <span className="mono">{d.view}</span>
                <span className="dot-sep">·</span>
                <span>{d.charts} chart{d.charts === 1 ? '' : 's'}</span>
              </div>
              <div className="tile-foot">
                <span className="hint" style={{ marginTop: 0 }}>owner {d.owner}</span>
                <span className="hint" style={{ marginTop: 0 }}>open ↗</span>
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
