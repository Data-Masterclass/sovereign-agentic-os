/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import ToolEmbed from '@/components/ToolEmbed';
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

  const open = (d: DashboardSummary) => {
    onSelect(d);
    setOpened(d);
  };

  const groups: { title: string; sub: string; items: DashboardSummary[] }[] = data
    ? [
        { title: 'Personal', sub: 'dashboards you own', items: data.mine },
        { title: 'Domain', sub: 'shared in your domain', items: data.domain },
        { title: 'Marketplace', sub: 'certified across the org', items: data.marketplace },
      ]
    : [];

  const empty = data && groups.every((g) => g.items.length === 0);

  return (
    <>
      {error ? <div className="error" style={{ marginTop: 16 }}>{error}</div> : null}
      {loading && !data ? <div className="stub-page">Loading dashboards…</div> : null}
      {empty ? <div className="stub-page">No dashboards yet — build one in the New dashboard tab.</div> : null}

      {groups.map((g) =>
        g.items.length ? (
          <div key={g.title} style={{ marginTop: 18 }}>
            <div className="group-head">
              <span className="group-heading">{g.title}</span>
              <span className="group-sub">{g.sub}</span>
            </div>
            <div className="tile-grid">
              {g.items.map((d) => (
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
          </div>
        ) : null,
      )}

      {opened ? <EmbedPanel dashboard={opened} supersetUrl={supersetUrl} /> : null}

      <div className="section-title" style={{ marginTop: 28 }}>Superset BI — embedded</div>
      <ToolEmbed
        url={supersetUrl}
        title="Superset"
        toolKey="superset"
        note="The Sales Overview dashboard is built on the Cube Revenue metric — the same numbers the Sales agent returns."
      />
      <div className="hint">
        Set <code>SUPERSET_URL</code> to your Superset address (default <code>http://localhost:8088</code>).
      </div>
    </>
  );
}
