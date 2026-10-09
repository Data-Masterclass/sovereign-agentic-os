/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { postJson, panelMetrics } from './shared';
import type { CubeMetaResponse, Panel, PanelQueryResponse, PanelViewMeta } from './shared';
import PanelChart, { type DrillRequest } from './PanelChart';

const leaf = (member: string) => (member.includes('.') ? member.slice(member.lastIndexOf('.') + 1) : member);

/**
 * DrillDrawer — the panel drill-down (the common-BI click-through). A datapoint click
 * narrows the SAME governed metrics to the clicked category (`region = DE`) and breaks
 * them down by another dimension of the view; a KPI click breaks the total down without
 * a filter. Runs the IDENTICAL governed panel-query path (per-viewer RLS, honest
 * warnings) with the drill filter pushed into the SQL WHERE — never a client-side
 * re-slice of already-aggregated rows. Centered modal on the `.pa-confirm` brand chrome.
 */
export default function DrillDrawer({
  view,
  panel,
  drill,
  onClose,
  metricIdOf,
}: {
  view: string;
  panel: Panel;
  /** The clicked category filter, or null for an unfiltered breakdown (KPI click). */
  drill: DrillRequest;
  onClose: () => void;
  /** Member → metric id (RLS-scoped registry) — powers the "Open in Metrics" backlink (P1-4). */
  metricIdOf?: (member: string) => string | undefined;
}) {
  // The view's governed dimensions — the "break down by" choices.
  const [meta, setMeta] = useState<PanelViewMeta | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/dashboards/cube-meta', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { views: [] }))
      .then((d: CubeMetaResponse) => { if (alive) setMeta(d.views?.find((v) => v.view === view) ?? null); })
      .catch(() => { if (alive) setMeta(null); });
    return () => { alive = false; };
  }, [view]);

  // Break down by: any view dimension that isn't the one we just filtered on.
  const dims = useMemo(
    () => (meta?.dimensions ?? []).filter((d) => d !== drill?.member),
    [meta, drill],
  );
  const [dim, setDim] = useState('');
  useEffect(() => { if (!dim && dims.length > 0) setDim(dims[0]); }, [dims, dim]);

  // The drill panel: same metrics, the drill filter pushed into the governed WHERE,
  // grouped by the chosen breakdown dimension.
  const drillPanel: Panel | null = useMemo(() => {
    if (!dim) return null;
    return {
      name: panel.name,
      vizType: 'bar',
      metrics: panel.metrics ?? (panel.metric ? [panel.metric] : []),
      dimensions: [dim],
      filters: [
        ...(panel.filters ?? []),
        ...(drill ? [{ member: drill.member, operator: 'equals', values: [drill.value] }] : []),
      ],
    };
  }, [panel, dim, drill]);

  const [res, setRes] = useState<PanelQueryResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!drillPanel) return;
    let alive = true;
    setLoading(true);
    setError('');
    postJson<PanelQueryResponse>('/api/dashboards/panel-query', { view, panel: drillPanel })
      .then((d) => { if (alive) setRes(d); })
      .catch((e: Error) => { if (alive) { setRes(null); setError(e.message); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [view, drillPanel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = drill
    ? `${panel.name} · ${leaf(drill.member)} = ${drill.value}`
    : `${panel.name} · breakdown`;

  // "Open in Metrics" (P1-4) — only when this panel charts exactly ONE metric whose id
  // resolves in the viewer's registry; otherwise there is no single metric to focus.
  const members = panelMetrics(panel);
  const focusId = members.length === 1 ? metricIdOf?.(members[0]) : undefined;

  return (
    <div className="pa-confirm-backdrop" onClick={onClose} role="presentation">
      <div
        className="pa-confirm"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 720, width: 'min(720px, 92vw)' }}
      >
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>{title}</h3>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            {focusId ? (
              <Link
                className="btn ghost sm"
                href={`/metrics?focus=${encodeURIComponent(focusId)}`}
                title={`Explore ${leaf(members[0])} in the Metrics tab`}
              >Open in Metrics ↗</Link>
            ) : null}
            <button className="btn ghost sm" onClick={onClose} aria-label="Close drill-down">✕ Close</button>
          </div>
        </div>

        <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
          <span className="hint" style={{ margin: 0 }}>Break down by</span>
          {dims.length > 0 ? (
            <select value={dim} onChange={(e) => setDim(e.target.value)}>
              {dims.map((d) => <option key={d} value={d}>{leaf(d)}</option>)}
            </select>
          ) : (
            <span className="hint" style={{ margin: 0 }}>
              {meta === null ? 'loading dimensions…' : 'no further dimensions on this view'}
            </span>
          )}
          {res ? <span className={`badge ${res.mode === 'live' ? 'ok' : 'muted'}`}>{res.mode}</span> : null}
        </div>

        <div style={{ marginTop: 12 }}>
          {error ? (
            <div className="error">{error}</div>
          ) : loading && !res ? (
            <div className="panel-state" style={{ height: 220 }}><span className="spin" /></div>
          ) : res && drillPanel ? (
            <>
              <PanelChart panel={drillPanel} rows={res.rows} pending={res.pending} warning={res.warning} height={220} />
              {/* The numbers behind the chart, in the open. */}
              {res.rows.length > 0 ? (
                <div style={{ marginTop: 10 }}>
                  <PanelChart panel={{ ...drillPanel, vizType: 'table' }} rows={res.rows} height={180} />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
