/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useUser } from '@/lib/useUser';
import { SCOPE_GROUPS, groupByScope, scopeCounts, type ScopeKey } from '@/lib/scopes';
import DomainTag from '@/components/DomainTag';
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
function MetricCard({ m, onOpen, scope }: { m: MetricSummary; onOpen: (m: MetricSummary) => void; scope: ScopeKey }) {
  const showDomain = scope === 'shared' || scope === 'marketplace' || scope === 'all';
  // FAIL-SOFT: one metric's model couldn't load — render its reason inline, non-clickable,
  // so the rest of the registry stays live (one bad cube never 500s the whole surface).
  if (m.error) {
    return (
      <div
        className="card tile"
        style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 120, boxSizing: 'border-box', opacity: 0.85 }}
        title="This metric's model could not be loaded"
      >
        <div className="tile-top">
          <span className="tile-name">{m.name}</span>
          <span className="badge warn">unavailable</span>
        </div>
        <div className="error" style={{ marginTop: 4, fontSize: 12 }}>{m.error}</div>
      </div>
    );
  }
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
        <div className="row" style={{ gap: 4, alignItems: 'center' }}>
          {showDomain ? <DomainTag domain={m.domain} /> : null}
          <span className={`badge ${TIER_BADGE[m.tier]}`}>{TIER_WORD[m.tier]}</span>
        </div>
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
  showArchived = false,
  onToggleArchived,
}: {
  groups: MetricGroups | null;
  loading: boolean;
  error: string;
  onOpen: (m: MetricSummary) => void;
  onDefine: () => void;
  showArchived?: boolean;
  onToggleArchived?: () => void;
}) {
  const { user } = useUser();
  const [scope, setScope] = useState<ScopeKey>('all');

  const uid = user?.id ?? '';
  const scoped = groups ? groupByScope(groups, uid) : null;
  const counts = groups ? scopeCounts(groups, uid) : null;
  // The scoped slice can include soft-archived metrics (when ?archived=1) — split them
  // so the working grid stays live-only and archived get their own openable section.
  const scopedAll = scoped ? scoped[scope] : [];
  const visible = scopedAll.filter((m) => !m.archived);
  const archived = scopedAll.filter((m) => m.archived);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <p className="lead" style={{ marginTop: 4, flex: 1, minWidth: 280 }}>
          Every business metric, defined once. Each card carries its single canonical
          definition — the Cube <strong>member</strong> the explorer, dashboards and the agent
          all resolve. Open one to explore it under your own identity, govern its tier, or set an alert.
        </p>
        <div className="row" style={{ gap: 8, marginTop: 4 }}>
          {onToggleArchived ? (
            <button
              className="btn ghost"
              style={{ opacity: showArchived ? 1 : 0.7 }}
              onClick={onToggleArchived}
              title="Archived metrics are hidden by default"
            >
              {showArchived ? 'Hide archived' : 'Show archived'}
            </button>
          ) : null}
          <button className="btn" onClick={onDefine}>＋ Define metric</button>
        </div>
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
              <MetricCard key={m.id} m={m} onOpen={onOpen} scope={scope} />
            ))}
          </div>
        ) : null
      ) : loading && !error ? <div className="stub-page" style={{ marginTop: 20 }}>Loading metrics…</div> : null}

      {/* Archived — openable tiles; the opened detail exposes Restore + Delete. */}
      {showArchived ? (
        archived.length > 0 ? (
          <>
            <div className="section-title" style={{ marginTop: 24 }}>
              Archived<span className="count-pill">{archived.length}</span>
            </div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Archived metrics are hidden from the working registry (their definitions are retained).
              Open one to Restore it, or Delete it permanently.
            </p>
            <div className="tile-grid">
              {archived.map((m) => <MetricCard key={m.id} m={m} onOpen={onOpen} scope={scope} />)}
            </div>
          </>
        ) : (
          <div className="hint" style={{ marginTop: 16 }}>No archived metrics.</div>
        )
      ) : null}
    </>
  );
}
