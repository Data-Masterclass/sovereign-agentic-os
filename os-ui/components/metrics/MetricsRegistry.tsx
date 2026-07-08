/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useUser } from '@/lib/useUser';
import { SCOPE_GROUPS, groupByScope, scopeCounts, type ScopeKey } from '@/lib/scopes';
import {
  type MetricGroups,
  type MetricSummary,
  TIER_BADGE,
  TIER_WORD,
} from './shared';

/**
 * The governed metric registry — every measure the user can see, grouped All · My · Shared ·
 * Marketplace via the OS-wide scope helper. Each tile shows the one canonical `member` (the
 * single definition of the number), the owner, a tier badge, and the aggregation. Clicking a
 * tile OPENS its detail, where explore / govern / alert fold in. The parent owns the fetch so
 * the same grouped payload warms the alert palette.
 */
function MetricCard({ m, onOpen }: { m: MetricSummary; onOpen: (m: MetricSummary) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(m)}
      className="card tile"
      style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 120, boxSizing: 'border-box' }}
      title="Open this metric — explore, govern, or set an alert"
    >
      <div className="tile-top">
        <span className="tile-name">{m.name}</span>
        <span className={`badge ${TIER_BADGE[m.tier]}`}>{TIER_WORD[m.tier]}</span>
      </div>
      <div className="muted mono" style={{ fontSize: 12 }}>{m.member}</div>
      <div className="tile-meta" style={{ marginTop: 'auto' }}>
        <span className="muted">{m.owner}</span>
        <span className="dot-sep">·</span>
        <span className="muted">{m.datasetName}</span>
        <span className="dot-sep">·</span>
        <span className="badge muted">{m.type}</span>
      </div>
    </button>
  );
}

export default function MetricsRegistry({
  groups,
  loading,
  error,
  onOpen,
  onDefine,
}: {
  groups: MetricGroups | null;
  loading: boolean;
  error: string;
  onOpen: (m: MetricSummary) => void;
  onDefine: () => void;
}) {
  const { user } = useUser();
  const [scope, setScope] = useState<ScopeKey>('all');

  const uid = user?.id ?? '';
  const scoped = groups ? groupByScope(groups, uid) : null;
  const counts = groups ? scopeCounts(groups, uid) : null;
  const visible = scoped ? scoped[scope] : [];

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <p className="lead" style={{ marginTop: 4, flex: 1, minWidth: 280 }}>
          Every business metric, defined once. Each card carries its single canonical
          definition — the Cube <strong>member</strong> the explorer, dashboards and the agent
          all resolve. Open one to explore it under your own identity, govern its tier, or set an alert.
        </p>
        <button className="btn" onClick={onDefine} style={{ marginTop: 4 }}>＋ Define metric</button>
      </div>

      {/* Scope switcher — the OS-wide four groups: All · My · Shared · Marketplace. */}
      <div className="seg" style={{ marginTop: 14 }}>
        {SCOPE_GROUPS.map((g) => (
          <button key={g.key} type="button" className={scope === g.key ? 'on' : ''} onClick={() => setScope(g.key)}>
            {g.label('Metrics')}{counts ? ` (${counts[g.key]})` : ''}
          </button>
        ))}
      </div>

      {error ? <div className="error" style={{ marginTop: 14 }}>{error}</div> : null}

      {groups && visible.length === 0 ? (
        <div className="stub-page" style={{ marginTop: 20 }}>
          {scope === 'mine' || scope === 'all'
            ? <>No metrics yet. <strong>Define</strong> one on a governed Gold dataset to see it here.</>
            : scope === 'shared'
              ? 'Nothing shared in your domain yet — promote a metric to share it.'
              : 'Nothing in the marketplace yet.'}
        </div>
      ) : null}

      {scoped ? (
        visible.length > 0 ? (
          <div className="tile-grid" style={{ marginTop: 16 }}>
            {visible.map((m) => (
              <MetricCard key={m.id} m={m} onOpen={onOpen} />
            ))}
          </div>
        ) : null
      ) : loading && !error ? <div className="stub-page" style={{ marginTop: 20 }}>Loading metrics…</div> : null}
    </>
  );
}
