/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import ToolEmbed from '@/components/ToolEmbed';
import { useUser } from '@/lib/useUser';
import { SCOPE_GROUPS, groupByScope, scopeCounts, type ScopeKey } from '@/lib/scopes';
import { TIER_BADGE, TIER_LABEL } from './shared';
import type { DashboardGroups, DashboardSummary } from './shared';
import EmbedPanel from './EmbedPanel';

/**
 * Tiles surface — dashboards grouped Mine / Domain / Marketplace. Single-click selects
 * (drives Reports + Govern); DOUBLE-click opens the embed panel below with the viewer's
 * guest token. The standing Superset link stays available at the bottom.
 */
export default function Tiles({
  data,
  loading,
  error,
  selected,
  onSelect,
  supersetUrl,
}: {
  data: DashboardGroups | null;
  loading: boolean;
  error: string;
  selected: DashboardSummary | null;
  onSelect: (d: DashboardSummary) => void;
  supersetUrl: string;
}) {
  const [opened, setOpened] = useState<DashboardSummary | null>(null);
  const [scope, setScope] = useState<ScopeKey>('all');
  const { user } = useUser();

  const open = (d: DashboardSummary) => {
    onSelect(d);
    setOpened(d);
  };

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
            ? 'No dashboards yet — build one in the New dashboard tab.'
            : scope === 'shared' ? 'Nothing shared in your domain yet.' : 'Nothing in the marketplace yet.'}
        </div>
      ) : null}

      {visible.length ? (
        <div className="tile-grid" style={{ marginTop: 16 }}>
          {visible.map((d) => (
            <button
              key={d.id}
              className="card tile"
              style={selected?.id === d.id ? { borderColor: 'var(--gold)', boxShadow: '0 0 0 1px var(--gold-line)' } : undefined}
              onClick={() => onSelect(d)}
              onDoubleClick={() => open(d)}
              title="Double-click to open"
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
                <span className="hint" style={{ marginTop: 0 }}>double-click to open ↗</span>
              </div>
            </button>
          ))}
        </div>
      ) : null}

      {opened ? <EmbedPanel dashboard={opened} supersetUrl={supersetUrl} /> : null}

      <div className="section-title" style={{ marginTop: 28 }}>Superset BI — embedded</div>
      <ToolEmbed
        url={supersetUrl}
        title="Superset"
        toolKey="superset"
        note="Dashboards are built on Cube metrics — so a chart returns the same number the agent's metrics tool does."
      />
      <div className="hint">
        Set <code>SUPERSET_URL</code> to your Superset address (default <code>http://localhost:8088</code>).
      </div>
    </>
  );
}
