/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useUser } from '@/lib/useUser';
import { SCOPE_GROUPS, groupByScope, scopeCounts, type ScopeKey } from '@/lib/scopes';
import { TIER_BADGE, TIER_LABEL } from './shared';
import type { DashboardGroups, DashboardSummary } from './shared';
import DomainTag from '@/components/DomainTag';

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
  showArchived = false,
  onToggleArchived,
}: {
  data: DashboardGroups | null;
  loading: boolean;
  error: string;
  onOpen: (d: DashboardSummary) => void;
  showArchived?: boolean;
  onToggleArchived?: () => void;
}) {
  const [scope, setScope] = useState<ScopeKey>('all');
  const { user } = useUser();

  const uid = user?.id ?? '';
  const scoped = data ? groupByScope(data, uid) : null;
  const counts = data ? scopeCounts(data, uid) : null;
  // Split archived out of the working grid (they can arrive when ?archived=1); archived
  // tiles get their own openable section so their detail can expose Restore + Delete.
  const scopedAll = scoped ? scoped[scope] : [];
  const visible = scopedAll.filter((d) => !d.archived);
  const archived = scopedAll.filter((d) => d.archived);

  const card = (d: DashboardSummary) => (
    <button
      key={d.id}
      type="button"
      className="card tile"
      onClick={() => onOpen(d)}
      title="Open this dashboard — view, report, or govern it"
    >
      <div className="tile-top">
        <span className="tile-name">{d.name}</span>
        <div className="row" style={{ gap: 4, alignItems: 'center' }}>
          {(scope === 'shared' || scope === 'marketplace' || scope === 'all') ? <DomainTag domain={d.domain} /> : null}
          <span className={`badge ${TIER_BADGE[d.tier]}`}>{TIER_LABEL[d.tier]}</span>
        </div>
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
  );

  return (
    <>
      {error ? <div className="error" style={{ marginTop: 16 }}>{error}</div> : null}
      {loading && !data ? <div className="stub-page">Loading dashboards…</div> : null}

      {data ? (
        <div className="row" style={{ marginTop: 16, justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div className="seg">
            {SCOPE_GROUPS.map((g) => (
              <button key={g.key} type="button" className={scope === g.key ? 'on' : ''} onClick={() => setScope(g.key)}>
                {g.label('Dashboards')}{counts ? ` (${counts[g.key]})` : ''}
              </button>
            ))}
          </div>
          {onToggleArchived ? (
            <button
              className="btn ghost"
              style={{ opacity: showArchived ? 1 : 0.7 }}
              onClick={onToggleArchived}
              title="Archived dashboards are hidden by default"
            >
              {showArchived ? 'Hide archived' : 'Show archived'}
            </button>
          ) : null}
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
          {visible.map(card)}
        </div>
      ) : null}

      {/* Archived — openable tiles; the opened detail exposes Restore + Delete. */}
      {showArchived ? (
        archived.length > 0 ? (
          <>
            <div className="section-title" style={{ marginTop: 24 }}>
              Archived<span className="count-pill">{archived.length}</span>
            </div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Archived dashboards are hidden from the working lists (retained). Open one to Restore or Delete it.
            </p>
            <div className="tile-grid">{archived.map(card)}</div>
          </>
        ) : (
          <div className="hint" style={{ marginTop: 16 }}>No archived dashboards.</div>
        )
      ) : null}
    </>
  );
}
