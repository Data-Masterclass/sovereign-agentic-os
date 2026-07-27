/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import { postJson, panelMetrics } from './shared';
import type { EmbedMode, Panel, PanelQueryResponse } from './shared';
import PanelChart from './PanelChart';

const REGIONS = [
  { key: 'me', label: 'Me (my entitlements)' },
  { key: 'DE', label: 'DE' },
  { key: 'FR', label: 'FR' },
  { key: 'US', label: 'US' },
] as const;

/** Render a Cube security context as a human RLS note (e.g. "region = DE"). */
function rlsNote(ctx: Record<string, unknown>): string {
  const region = ctx.region;
  if (typeof region === 'string' && region) return `region = ${region}`;
  return 'unfiltered — you see every entitled row';
}

/** One panel tile — queries its own governed rows AS THE VIEWER, then paints with ECharts. */
function PanelCard({
  view,
  panel,
  viewerRegion,
  onResolved,
}: {
  view: string;
  panel: Panel;
  viewerRegion?: string;
  onResolved: (info: { mode: EmbedMode; ctx: Record<string, unknown> }) => void;
}) {
  const [res, setRes] = useState<PanelQueryResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    postJson<PanelQueryResponse>('/api/dashboards/panel-query', { view, panel, viewerRegion })
      .then((d) => {
        if (!alive) return;
        setRes(d);
        onResolved({ mode: d.mode, ctx: d.securityContext });
      })
      .catch((e: Error) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // onResolved is a stable host callback; excluded to avoid re-querying on identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, panel, viewerRegion]);

  return (
    <div className="panel-card">
      <div className="panel-card-head">
        <span className="panel-card-title">{panel.name}</span>
        <span className="mono muted" style={{ fontSize: 11 }}>{panelMetrics(panel).map((m) => m.split('.').pop()).join(', ')}</span>
      </div>
      {error ? (
        <div className="panel-state" style={{ height: 240 }}><span className="hint">{error}</span></div>
      ) : loading && !res ? (
        <div className="panel-state" style={{ height: 240 }}><span className="spin" /></div>
      ) : res ? (
        <PanelChart panel={panel} rows={res.rows} pending={res.pending} warning={res.warning} />
      ) : null}
    </div>
  );
}

/**
 * The native dashboard grid (Tier 1). Renders each panel with Apache ECharts on rows the
 * server resolved from the governed Cube layer UNDER THE VIEWER'S delegated identity (R3):
 * every tile is row-level-security scoped to the viewer. Switch "View as" and every panel
 * re-queries as that viewer — the RLS note changes with it, the whole point of per-viewer
 * governance. Replaces the retired Superset iframe embed. No Cube URL/token ever reaches
 * the browser — panels receive only rows.
 */
export default function DashboardGrid({
  view,
  panels,
  onLoaded,
}: {
  view: string;
  panels: Panel[];
  /** Fired once panels resolve — lets the staged builder mark View reached and hand the
   *  RLS clause to the stage assistant (replaces EmbedPanel's onEmbed). */
  onLoaded?: (info: { mode: EmbedMode; rls: string }) => void;
}) {
  const [region, setRegion] = useState<string>('me');
  const [mode, setMode] = useState<EmbedMode | null>(null);
  const [ctx, setCtx] = useState<Record<string, unknown>>({});
  const viewerRegion = region === 'me' ? undefined : region;

  const onResolved = ({ mode: m, ctx: c }: { mode: EmbedMode; ctx: Record<string, unknown> }) => {
    setMode(m);
    setCtx(c);
    onLoaded?.({ mode: m, rls: rlsNote(c) });
  };

  if (panels.length === 0) {
    return <div className="chat-empty">No panels yet — add one in Design.</div>;
  }

  return (
    <div className="agent-editor" style={{ marginTop: 16 }}>
      <div className="agent-editor-head">
        <div>
          <div className="agent-editor-title">Native dashboard · {view}</div>
          <div className="hint" style={{ marginTop: 2 }}>
            Rendered on your governed metrics with Apache ECharts — every panel is row-level-security
            scoped to you (R3). No BI tool in the loop.
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="comp-label" style={{ margin: 0 }}>View as</span>
          <select value={region} onChange={(e) => setRegion(e.target.value)}>
            {REGIONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </label>
      </div>

      {mode ? (
        <div className="passthrough-note" style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontWeight: 600 }}>Row-level security</span>
            <span className={`badge ${mode === 'live' ? 'ok' : 'muted'}`}>{mode}</span>
          </div>
          <div>
            Resolved under your identity: <code>{rlsNote(ctx)}</code>
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            Switch “View as” to resolve every panel as a different viewer — the rows (and this clause) change with it.
          </div>
        </div>
      ) : null}

      <div className="dash-grid">
        {panels.map((panel, i) => (
          <PanelCard
            key={`${panel.name}-${i}`}
            view={view}
            panel={panel}
            viewerRegion={viewerRegion}
            onResolved={onResolved}
          />
        ))}
      </div>
    </div>
  );
}
