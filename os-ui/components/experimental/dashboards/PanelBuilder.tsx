/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { postJson, VIZ_TYPES, panelMetrics, metricTierSections, viewDatasetName } from './shared';
import type { CubeMetaResponse, MetricSummary, Panel, PanelQueryResponse, PanelViewMeta, VizType } from './shared';
import PanelChart from './PanelChart';

/** The Cube view a metric member belongs to (`View.measure` → `View`). */
const viewOf = (member: string) => (member.includes('.') ? member.slice(0, member.indexOf('.')) : member);
const leaf = (member: string) => (member.includes('.') ? member.slice(member.lastIndexOf('.') + 1) : member);

const GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;

/** The three panel widths (P1-2) — 12-col units: ⅓ · ½ (default) · full. */
const WIDTHS = [
  { w: 4, label: '⅓' },
  { w: 6, label: '½' },
  { w: 12, label: 'full' },
] as const;
type PanelWidth = (typeof WIDTHS)[number]['w'];

/** The tier NOUN a metric chip's hover details reads — the OS scope vocabulary. */
const TIER_WORD: Record<MetricSummary['tier'], string> = { personal: 'My', domain: 'Domain', marketplace: 'Company' };

/**
 * A single selectable metric chip in the panel picker. The FACE shows the metric name only —
 * the source dataset, formula, tier and description live in a hover/focus popover so the
 * palette stays calm. The popover is a plain CSS hover-card (no browser dialog); it also
 * opens on keyboard focus, and carries an "Open in Metrics" link to the metric's detail.
 */
function MetricChip({ m, selected, onToggle }: { m: MetricSummary; selected: boolean; onToggle: () => void }) {
  return (
    <span className="metric-chip-wrap">
      <button
        type="button"
        className={`chip${selected ? ' ok' : ''}`}
        aria-pressed={selected}
        onClick={onToggle}
      >
        {m.name}
      </button>
      {/* Hover/focus details — dataset (friendly), formula flag, tier, description + a link
          to the full definition. `role="tooltip"`; shown via CSS on hover of the wrap or
          focus-within (keyboard accessible), never as a modal dialog. */}
      <span className="metric-chip-pop" role="tooltip">
        <span className="metric-chip-pop-name">{m.name}</span>
        <span className="metric-chip-pop-row">
          <span className="muted">Source</span>
          <span>{m.datasetName}</span>
        </span>
        <span className="metric-chip-pop-row">
          <span className="muted">Scope</span>
          <span>{TIER_WORD[m.tier]}</span>
        </span>
        {m.composite ? (
          <span className="metric-chip-pop-row">
            <span className="muted">Type</span>
            <span>Composite (formula over other metrics)</span>
          </span>
        ) : null}
        {m.description ? <span className="metric-chip-pop-desc">{m.description}</span> : null}
        <a
          className="metric-chip-pop-link"
          href={`/metrics?focus=${encodeURIComponent(m.id)}`}
          onClick={(e) => e.stopPropagation()}
        >
          Open in Metrics →
        </a>
      </span>
    </span>
  );
}

/**
 * The native panel designer (Tier 1). Pick one-or-more governed metric members from the
 * palette (already fetched by the tab), choose a viz type, and — for charts — group by a
 * dimension or trend over a time dimension at a grain, from the caller's governed cube-meta.
 * A LIVE preview resolves the exact panel-query the grid will run (per-viewer RLS), so what
 * you see is what the dashboard renders. "Add panel" hands the finished panel to the host.
 *
 * The single-view guard is honoured: only members on the bound `view` are selectable, so a
 * dashboard's panels can never span two Cube views.
 */
export default function PanelBuilder({
  view,
  palette,
  onAdd,
  editing,
  editKey,
  onCancelEdit,
  initialMetrics,
}: {
  /** The bound Cube view (empty until the first metric is chosen). */
  view: string;
  /** The metric registry palette (MetricSummary[]) already fetched by DashboardsTab. */
  palette: MetricSummary[];
  onAdd: (panel: Panel) => void;
  /** When set, the builder is EDITING this panel — its spec seeds the controls and the
   *  add button reads "Update panel". `onAdd` replaces the original panel in the host list. */
  editing?: Panel | null;
  /** A stable key that changes each time a NEW edit begins, so the seed effect re-runs even
   *  if the same panel object is re-selected. */
  editKey?: number;
  /** Clear the edit selection (host drops it; the builder returns to add-mode). */
  onCancelEdit?: () => void;
  /** Pre-select these metric members (Metric View → "Add to a dashboard" deep-link). */
  initialMetrics?: string[];
}) {
  const [name, setName] = useState('');
  const [vizType, setVizType] = useState<VizType>('big_number');
  const [metrics, setMetrics] = useState<string[]>(initialMetrics ?? []);
  const [dimension, setDimension] = useState('');
  const [timeDimension, setTimeDimension] = useState('');
  const [timeGrain, setTimeGrain] = useState<(typeof GRAINS)[number]>('month');
  // Panel width (P1-2) — ½ by default; when editing, seed from the panel's gridPos (absent = ½).
  const [width, setWidth] = useState<PanelWidth>(6);

  // Seed the controls from the panel being edited (once per edit — keyed by editKey).
  useEffect(() => {
    if (!editing) return;
    setName(editing.name);
    setVizType(editing.vizType);
    setMetrics(panelMetrics(editing));
    setDimension(editing.dimensions?.[0] ?? '');
    setTimeDimension(editing.timeDimension ?? '');
    if (editing.timeGrain && (GRAINS as readonly string[]).includes(editing.timeGrain)) {
      setTimeGrain(editing.timeGrain as (typeof GRAINS)[number]);
    }
    // Seed the width from the panel's authored gridPos — absent (or a non-standard w) = ½.
    const w = editing.gridPos?.w;
    setWidth(w === 4 || w === 12 ? w : 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editKey]);

  // The governed cube-meta for the caller's views (narrowed server-side).
  const [meta, setMeta] = useState<PanelViewMeta[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/dashboards/cube-meta', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { views: [] }))
      .then((d: CubeMetaResponse) => { if (alive) setMeta(d.views ?? []); })
      .catch(() => { if (alive) setMeta([]); });
    return () => { alive = false; };
  }, []);

  // The EFFECTIVE view: the bound `view` once the dashboard has a panel, else the view of
  // the metric(s) being selected for the FIRST panel. Before the first panel is added the
  // parent `view` (derived from committed charts) is empty — keying the group-by palette off
  // it left the dimension picker permanently empty while designing the very first panel
  // (BUG B). Deriving it from the current selection binds the palette as soon as a metric is
  // picked, while still honouring the single-view guard (`inView` filters the rest).
  const effectiveView = useMemo(() => view || (metrics.length > 0 ? viewOf(metrics[0]) : ''), [view, metrics]);
  const inView = useMemo(() => palette.filter((m) => !effectiveView || viewOf(m.member) === effectiveView), [palette, effectiveView]);
  const viewMeta = useMemo(() => meta?.find((v) => v.view === effectiveView), [meta, effectiveView]);
  // Presentation: the selectable metrics grouped My · Domain · Company (empty tiers dropped),
  // and the FRIENDLY dataset name for the bound view (never the UPPER_SNAKE identifier).
  const sections = useMemo(() => metricTierSections(inView), [inView]);
  const friendlyView = useMemo(() => viewDatasetName(inView, effectiveView), [inView, effectiveView]);

  // Bar/pie REQUIRE a dimension to chart; a table can OPTIONALLY group by one (and trend
  // over time), so it too offers the group-by control. Big-number stays scalar.
  const needsDimension = vizType === 'bar' || vizType === 'pie' || vizType === 'table';
  // Line/area trend over time by design; a table may optionally carry a time column too.
  const isTimeSeries = vizType === 'line' || vizType === 'area' || vizType === 'table';

  const draft: Panel | null = useMemo(() => {
    if (metrics.length === 0) return null;
    const p: Panel = { name: name.trim() || leaf(metrics[0]), vizType, metrics };
    if (needsDimension && dimension) p.dimensions = [dimension];
    if (isTimeSeries && timeDimension) { p.timeDimension = timeDimension; p.timeGrain = timeGrain; }
    // Panel width (P1-2) — the grid lays out by w; x/y unused by the flow renderer, h:1.
    p.gridPos = { x: 0, y: 0, w: width, h: 1 };
    return p;
  }, [name, vizType, metrics, needsDimension, dimension, isTimeSeries, timeDimension, timeGrain, width]);

  // Live preview — the exact panel-query the grid will run (per-viewer RLS).
  const [preview, setPreview] = useState<PanelQueryResponse | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  useEffect(() => {
    if (!draft || !effectiveView) { setPreview(null); return; }
    let alive = true;
    setPreviewErr('');
    postJson<PanelQueryResponse>('/api/dashboards/panel-query', { view: effectiveView, panel: draft })
      .then((d) => { if (alive) setPreview(d); })
      .catch((e: Error) => { if (alive) { setPreview(null); setPreviewErr(e.message); } });
    return () => { alive = false; };
  }, [draft, effectiveView]);

  const toggleMetric = (member: string) =>
    setMetrics((ms) => (ms.includes(member) ? ms.filter((m) => m !== member) : [...ms, member]));

  const add = () => {
    if (!draft) return;
    onAdd(draft);
    setName('');
    setVizType('big_number');
    setMetrics([]);
    setDimension('');
    setTimeDimension('');
    setWidth(6);
    onCancelEdit?.();
  };

  return (
    <div className="agent-editor" style={{ marginTop: 4 }}>
      {/* A panel charts ONE view — a calm caption naming the source dataset by its friendly
          name (never the raw UPPER_SNAKE view id). Metrics are grouped My · Domain · Company
          below, so the tier is explicit and there is no "governed" claim to make here. */}
      <label className="comp-label">
        {effectiveView
          ? <>Charting from <strong>{friendlyView}</strong> — pick one or more metrics (multi-select)</>
          : <>Pick one or more metrics to chart (multi-select)</>}
      </label>
      {inView.length === 0 ? (
        <div className="hint">No metrics available on this dataset yet — go back to Define to pick another.</div>
      ) : (
        <div className="metric-picker" style={{ marginTop: 4 }}>
          {sections.map((s) => (
            <div key={s.key} className="metric-picker-group">
              <div className="metric-picker-label">{s.label}</div>
              <div className="chip-row">
                {s.metrics.map((m) => (
                  <MetricChip
                    key={m.id}
                    m={m}
                    selected={metrics.includes(m.member)}
                    onToggle={() => toggleMetric(m.member)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 16 }}>
        <label className="comp-label" style={{ margin: 0 }}>Panel</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={metrics[0] ? leaf(metrics[0]) : 'Panel name'} style={{ maxWidth: 220 }} />
        <select value={vizType} onChange={(e) => setVizType(e.target.value as VizType)}>
          {VIZ_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>

        {needsDimension ? (
          <select value={dimension} onChange={(e) => setDimension(e.target.value)}>
            <option value="">group by…</option>
            {(viewMeta?.dimensions ?? []).map((d) => <option key={d} value={d}>by {leaf(d)}</option>)}
          </select>
        ) : null}

        {isTimeSeries ? (
          <>
            <select value={timeDimension} onChange={(e) => setTimeDimension(e.target.value)}>
              <option value="">over time…</option>
              {(viewMeta?.timeDimensions ?? []).map((d) => <option key={d} value={d}>by {leaf(d)}</option>)}
            </select>
            {timeDimension ? (
              <select value={timeGrain} onChange={(e) => setTimeGrain(e.target.value as (typeof GRAINS)[number])}>
                {GRAINS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            ) : null}
          </>
        ) : null}

        {/* Panel width (P1-2) — how many columns the tile spans in View. Default ½. */}
        <span className="seg" title="Panel width on the dashboard grid" style={{ marginLeft: 'auto' }}>
          {WIDTHS.map((x) => (
            <button
              key={x.w}
              className={width === x.w ? 'on' : ''}
              onClick={() => setWidth(x.w)}
              title={`${x.label} width`}
              aria-label={`${x.label} width`}
            >{x.label}</button>
          ))}
        </span>

        <button className="btn" onClick={add} disabled={!draft}>
          {editing ? 'Update panel' : '＋ Add panel'}
        </button>
        {editing ? (
          <button
            className="btn ghost"
            onClick={() => {
              setName(''); setVizType('big_number'); setMetrics([]); setDimension(''); setTimeDimension(''); setWidth(6);
              onCancelEdit?.();
            }}
          >Cancel</button>
        ) : null}
      </div>

      {/* Panels serve as governed SQL resolved through the registry (Phase 2) — the
          palette IS what the executor can compute, so there is no "not served" state
          to warn about anymore. */}
      {(needsDimension && !viewMeta?.dimensions?.length) || (isTimeSeries && !viewMeta?.timeDimensions?.length) ? (
        <div className="hint" style={{ marginTop: 8 }}>
          {meta === null
            ? 'Loading the view’s dimensions…'
            : 'No dimensions on this view — the palette comes from the dataset’s documented Gold columns. Document them in Data (or rebuild Gold) and they appear here.'}
        </div>
      ) : null}

      {/* Live preview — exactly what the grid will render, resolved under your RLS. */}
      {draft ? (
        <div className="grant-block" style={{ marginTop: 14 }}>
          <div className="comp-label" style={{ marginBottom: 6 }}>Live preview</div>
          {previewErr ? (
            <div className="error">{previewErr}</div>
          ) : preview ? (
            <div className="panel-card">
              <div className="panel-card-head">
                <span className="panel-card-title">{draft.name}</span>
                <span className={`badge ${preview.mode === 'live' ? 'ok' : 'muted'}`}>{preview.mode}</span>
              </div>
              <PanelChart panel={draft} rows={preview.rows} pending={preview.pending} height={200} />
            </div>
          ) : (
            <div className="panel-state" style={{ height: 200 }}><span className="spin" /></div>
          )}
        </div>
      ) : (
        <div className="hint" style={{ marginTop: 12 }}>Select at least one metric to preview a panel.</div>
      )}
    </div>
  );
}
