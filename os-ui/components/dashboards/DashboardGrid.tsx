/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { panelMetrics } from './shared';
import type { EmbedMode, Panel, PanelFilter, PanelQueryResponse } from './shared';
import PanelChart, { type DrillRequest } from './PanelChart';
import DrillDrawer from './DrillDrawer';
import PanelExpand from './PanelExpand';
import SourceUnavailable from '@/components/core/SourceUnavailable';
import { panelSourceUnavailable } from '@/lib/core/source-availability';

/** Render a Cube security context as a human RLS note (e.g. "region = DE"). */
function rlsNote(ctx: Record<string, unknown>): string {
  const region = ctx.region;
  if (typeof region === 'string' && region) return `region = ${region}`;
  return 'unfiltered — you see every entitled row';
}

const leaf = (member: string) => (member.includes('.') ? member.slice(member.lastIndexOf('.') + 1) : member);

/** The time hierarchy a viewer can drill up/down (P1-1) — day is the finest, year the coarsest. */
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;
type Grain = (typeof GRAINS)[number];

/** Clamp a panel width (12-col units) to 1-12; absent ⇒ ½ (w:6) — the authored default. */
const spanOf = (p: Panel): number => Math.max(1, Math.min(12, p.gridPos?.w ?? 6));

/** One active cross-filter (the Power BI page-slicer, chip-shaped). Session state only. */
type ActiveFilter = { member: string; value: string };

/** Seed the session chips from persisted default filters (P1-3): one chip per single-value
 *  `equals` filter (the chip vocabulary). Non-equals / multi-value defaults are ignored here
 *  — they still thread through each panel's authored `filters`, never silently applied twice. */
function seedFilters(defaults?: PanelFilter[]): ActiveFilter[] {
  if (!defaults?.length) return [];
  const out: ActiveFilter[] = [];
  for (const f of defaults) {
    if (f.operator === 'equals' && f.values.length === 1 && !out.some((x) => x.member === f.member)) {
      out.push({ member: f.member, value: f.values[0] });
    }
  }
  return out;
}

/** The persisted-spec shape of the active chips (P1-3) — the equality filters Save stores. */
const chipsToFilters = (fs: ActiveFilter[]): PanelFilter[] =>
  fs.map((f) => ({ member: f.member, operator: 'equals', values: [f.value] }));

/** Merge the active chips into a panel's authored filters — the SAME equality shape the
 *  governed panel-query pushes into the Trino WHERE (per-viewer RLS unchanged). */
function withFilters(p: Panel, filters: ActiveFilter[]): Panel {
  if (filters.length === 0) return p;
  return {
    ...p,
    filters: [
      ...(p.filters ?? []),
      ...filters.map((f) => ({ member: f.member, operator: 'equals', values: [f.value] })),
    ],
  };
}

/** One panel tile — queries its own governed rows AS THE VIEWER, then paints with ECharts. */
function PanelCard({
  view,
  panel,
  onResolved,
  onDrill,
  metricIdOf,
  metricsReady = false,
}: {
  view: string;
  panel: Panel;
  onResolved: (info: { mode: EmbedMode; ctx: Record<string, unknown> }) => void;
  /** Datapoint drill request — the host cross-filters (category) or opens the drawer (KPI). */
  onDrill: (panel: Panel, drill: DrillRequest) => void;
  /** Member → metric id (RLS-scoped registry); resolves the "what is this number?" backlink. */
  metricIdOf?: (member: string) => string | undefined;
  /** True once the metric registry has finished loading — gates the source-unavailable
   *  degradation so a still-loading registry never white-outs a live panel. */
  metricsReady?: boolean;
}) {
  // GRACEFUL DEGRADATION (0.6.98): if — the registry having loaded — NONE of this panel's
  // metric members resolves to a live metric, its source dataset was demoted/archived/deleted.
  // Render the calm SourceUnavailable note for THIS tile instead of firing a doomed query
  // (whose metricIdOf backlink would also be undefined) or letting a downstream deref throw.
  const unavailable = metricsReady && !!metricIdOf
    ? panelSourceUnavailable(panelMetrics(panel), metricIdOf, true)
    : false;
  const [res, setRes] = useState<PanelQueryResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // Viewer-side time-grain override (P1-1) — session state, defaults to the authored grain.
  // Only a panel WITH a timeDimension offers it; drilling up/down re-queries via the fetch key.
  const [grain, setGrain] = useState<Grain | undefined>(undefined);
  // P1-6: a 30 s timeout on the governed fetch + a manual Retry (bump re-triggers the effect).
  const [timedOut, setTimedOut] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  // Open this panel into a near-full-viewport view (reuses the rows fetched below).
  const [expanded, setExpanded] = useState(false);

  // The panel actually queried: the authored panel with the viewer's grain override applied
  // (the serialized-panel fetch key below makes the override re-query automatically).
  const queried: Panel = panel.timeDimension && grain ? { ...panel, timeGrain: grain } : panel;

  // Key the fetch on the SERIALIZED panel — chip/grain changes re-query, render churn doesn't.
  const panelJson = JSON.stringify(queried);
  useEffect(() => {
    // Source gone — don't fire a doomed governed query; the tile degrades below.
    if (unavailable) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    setError('');
    setTimedOut(false);
    const controller = new AbortController();
    // The governed engine may be busy; never hang forever, never fall back to stale/mock data.
    const timer = setTimeout(() => { controller.abort(); }, 30_000);
    fetch('/api/dashboards/panel-query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ view, panel: JSON.parse(panelJson) as Panel }),
      signal: controller.signal,
    })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${r.status})`);
        return data as PanelQueryResponse;
      })
      .then((d) => {
        if (!alive) return;
        setRes(d);
        onResolved({ mode: d.mode, ctx: d.securityContext });
      })
      .catch((e: Error) => {
        if (!alive) return;
        // Distinguish the honest timeout (loud, retryable) from any other error.
        if (e.name === 'AbortError') setTimedOut(true);
        else setError(e.message);
      })
      .finally(() => { if (alive) { clearTimeout(timer); setLoading(false); } });
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
    // onResolved is a stable host callback; excluded to avoid re-querying on identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, panelJson, retryKey, unavailable]);

  // The panel is expandable once its rows have resolved — the expanded view reuses that
  // slice, never re-queries. The trigger (title + ⤢ corner button) is deliberately SEPARATE
  // from the chart canvas / table rows / KPI (which own drill clicks) and from the CSV and
  // Retry buttons, so opening the overlay never hijacks an existing interaction.
  const canExpand = !!res && !timedOut && !error;
  const openExpand = canExpand ? () => setExpanded(true) : undefined;

  return (
    <div className="panel-card">
      <div className="panel-card-head">
        {canExpand ? (
          <button
            type="button"
            className="panel-card-title panel-card-title-btn"
            onClick={openExpand}
            title="Open this panel in a larger view"
          >{panel.name}</button>
        ) : (
          <span className="panel-card-title">{panel.name}</span>
        )}
        {/* Viewer-side time-grain switcher (P1-1) — quiet, right of the header; only when the
            panel trends over time. Drilling up/down the hierarchy re-queries under RLS. */}
        {panel.timeDimension ? (
          <span className="seg" style={{ marginLeft: 'auto', transform: 'scale(0.82)', transformOrigin: 'right center' }}>
            {GRAINS.map((g) => (
              <button
                key={g}
                className={(grain ?? panel.timeGrain) === g ? 'on' : ''}
                onClick={() => setGrain(g)}
                title={`Show by ${g}`}
              >{g}</button>
            ))}
          </span>
        ) : null}
        {/* Every number is one click from its DEFINITION: the measure leaf links to the
            metric's View when the member resolves in the viewer's registry (plain text
            while metrics load or outside their entitlement — never a dead link). */}
        <span className="mono muted" style={{ fontSize: 11, marginLeft: panel.timeDimension ? 8 : 'auto' }}>
          {panelMetrics(panel).map((m, i) => {
            const id = metricIdOf?.(m);
            const text = leaf(m);
            return (
              <span key={m}>
                {i > 0 ? ', ' : ''}
                {id ? (
                  <Link
                    href={`/metrics?focus=${encodeURIComponent(id)}`}
                    title={`Open the definition of ${m}`}
                    style={{ color: 'inherit', textDecoration: 'underline dotted' }}
                  >{text}</Link>
                ) : text}
              </span>
            );
          })}
        </span>
      </div>
      {unavailable ? (
        <SourceUnavailable compact />
      ) : timedOut ? (
        <div className="panel-state" style={{ height: 240, flexDirection: 'column', gap: 10 }}>
          <span className="hint" role="alert" style={{ margin: 0, textAlign: 'center' }}>
            Query exceeded 30 s — the governed engine may be busy.
          </span>
          <button className="btn ghost sm" onClick={() => setRetryKey((k) => k + 1)}>Retry</button>
        </div>
      ) : error ? (
        <div className="panel-state" style={{ height: 240 }}><span className="hint">{error}</span></div>
      ) : loading && !res ? (
        <div className="panel-state" style={{ height: 240 }}><span className="spin" /></div>
      ) : res ? (
        <PanelChart
          panel={queried}
          rows={res.rows}
          pending={res.pending}
          warning={res.warning}
          onDrill={(d) => onDrill(panel, d)}
        />
      ) : null}

      {/* Expand affordance — quiet, in the card corner; sits ABOVE the chart canvas but
          out of the way of datapoints. Only when rows have resolved. */}
      {canExpand ? (
        <button
          type="button"
          className="panel-expand-btn"
          onClick={openExpand}
          title="Open this panel in a larger view"
          aria-label={`Expand ${panel.name}`}
        >⤢</button>
      ) : null}

      {expanded && res ? (
        <PanelExpand
          panel={queried}
          rows={res.rows}
          pending={res.pending}
          warning={res.warning}
          mode={res.mode}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * The native dashboard grid (Tier 1). Renders each panel with Apache ECharts on rows the
 * server resolved from the governed lakehouse UNDER THE VIEWER'S delegated identity (R3):
 * every tile is row-level-security scoped to the signed-in viewer via OPA identity.
 *
 * CROSS-FILTERING (the Power BI page interaction, chip-shaped): clicking a bar/slice/
 * table-row adds a filter chip above the grid and EVERY panel re-queries with it pushed
 * into its governed WHERE — same viewer identity, same honesty warnings. Chips are session
 * state (nothing persisted); "▸ break down" opens the drill drawer seeded with the chip,
 * "×" clears it. A KPI click opens the drawer directly (a total has no category to filter by).
 */
export default function DashboardGrid({
  view,
  panels,
  onLoaded,
  metricIdOf,
  metricsReady = false,
  initialFilters,
  onFiltersChange,
}: {
  view: string;
  panels: Panel[];
  /** Fired once panels resolve — lets the host reflect the resolved RLS clause. */
  onLoaded?: (info: { mode: EmbedMode; rls: string }) => void;
  /** Member → metric id for the panel-header definition backlink (optional). */
  metricIdOf?: (member: string) => string | undefined;
  /** True once the metric registry has loaded — gates the source-unavailable degradation
   *  (0.6.98) so a panel on a demoted/deleted dataset degrades instead of throwing. */
  metricsReady?: boolean;
  /** Seed the cross-filter chips (P1-3) — View opens narrowed to the dashboard's saved
   *  defaults. Absent = start unfiltered (today's behaviour). */
  initialFilters?: PanelFilter[];
  /** Surface the currently-active chips up (P1-3) so Edit can Save them as the defaults. */
  onFiltersChange?: (filters: PanelFilter[]) => void;
}) {
  const [modes, setModes] = useState<Record<string, EmbedMode>>({});
  const [ctx, setCtx] = useState<Record<string, unknown>>({});
  // Active cross-filter chips. One value per member (Power BI slicer behavior): clicking a
  // second value on the same member REPLACES it; clicking the same value again clears it.
  // Seeded from the persisted default filters (P1-3): each saved equals-filter → one chip.
  const [filters, setFilters] = useState<ActiveFilter[]>(() => seedFilters(initialFilters));
  // The open drill drawer — a KPI click or a chip's "break down".
  const [drill, setDrill] = useState<{ panel: Panel; request: DrillRequest } | null>(null);

  const filtered = useMemo(() => panels.map((p) => withFilters(p, filters)), [panels, filters]);
  // P1-2: any authored width switches the grid to the explicit 12-column layout.
  const hasGridPos = useMemo(() => panels.some((p) => p.gridPos), [panels]);

  // Surface the active chips up (P1-3) so Edit can Save them as the dashboard's defaults.
  useEffect(() => {
    onFiltersChange?.(chipsToFilters(filters));
    // onFiltersChange is a stable host callback; excluded to avoid a notify loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const onResolved = (key: string) => ({ mode: m, ctx: c }: { mode: EmbedMode; ctx: Record<string, unknown> }) => {
    setModes((prev) => (prev[key] === m ? prev : { ...prev, [key]: m }));
    setCtx(c);
  };

  // HONEST grid-wide mode: 'live' only when every resolved panel is live; a mix is loud.
  const resolvedModes = Object.values(modes);
  const liveCount = resolvedModes.filter((m) => m === 'live').length;
  const gridMode: EmbedMode | null = resolvedModes.length === 0 ? null : liveCount === resolvedModes.length ? 'live' : 'offline-mock';
  const mixed = resolvedModes.length > 0 && liveCount > 0 && liveCount < resolvedModes.length;
  useEffect(() => {
    if (gridMode) onLoaded?.({ mode: gridMode, rls: rlsNote(ctx) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridMode, ctx]);

  const toggleFilter = (f: ActiveFilter) =>
    setFilters((fs) => {
      const same = fs.find((x) => x.member === f.member);
      if (same && same.value === f.value) return fs.filter((x) => x.member !== f.member); // click again = clear
      return [...fs.filter((x) => x.member !== f.member), f]; // one value per member
    });

  const onDrill = (panel: Panel, request: DrillRequest) => {
    if (request === null) {
      // A KPI has no category to filter by — open its breakdown (respecting active chips).
      setDrill({ panel: withFilters(panel, filters), request: null });
      return;
    }
    toggleFilter({ member: request.member, value: request.value });
  };

  if (panels.length === 0) {
    return <div className="chat-empty">No panels yet — add one in Edit.</div>;
  }

  return (
    <div className="agent-editor" style={{ marginTop: 16 }}>
      <div className="agent-editor-head">
        <div>
          <div className="agent-editor-title">Native dashboard · {view}</div>
          <div className="hint" style={{ marginTop: 2 }}>
            Rendered on your governed metrics with Apache ECharts — every panel is row-level-security
            scoped to you (R3). Click a bar or slice to filter the whole dashboard.
          </div>
        </div>
      </div>

      {gridMode ? (
        <div className="passthrough-note" style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontWeight: 600 }}>Row-level security</span>
            {mixed ? (
              <span className="badge muted" role="alert">
                mixed · {liveCount} live / {resolvedModes.length - liveCount} mock
              </span>
            ) : (
              <span className={`badge ${gridMode === 'live' ? 'ok' : 'muted'}`}>{gridMode}</span>
            )}
          </div>
          <div>
            Resolved under your identity: <code>{rlsNote(ctx)}</code>
          </div>
        </div>
      ) : null}

      {/* Cross-filter chips — every panel below is narrowed to these (in its governed WHERE). */}
      {filters.length > 0 ? (
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          <span className="hint" style={{ margin: 0 }}>Filtered to</span>
          {filters.map((f) => (
            <span key={f.member} className="chip ok" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {leaf(f.member)} = {f.value}
              <button
                className="chip-x"
                onClick={() => setDrill({
                  // Drill the FIRST panel's metrics under the OTHER chips; this chip
                  // becomes the drawer's own filter (never doubled in the WHERE).
                  panel: withFilters(panels[0] ?? { name: '', vizType: 'bar', metrics: [] }, filters.filter((x) => x.member !== f.member)),
                  request: { member: f.member, value: f.value },
                })}
                title={`Break down ${leaf(f.member)} = ${f.value}`}
                aria-label={`Break down ${leaf(f.member)} = ${f.value}`}
                style={{ fontSize: 11 }}
              >▸</button>
              <button
                className="chip-x"
                onClick={() => setFilters((fs) => fs.filter((x) => x.member !== f.member))}
                aria-label={`Clear filter ${leaf(f.member)}`}
              >×</button>
            </span>
          ))}
          {filters.length > 1 ? (
            <button className="btn ghost sm" onClick={() => setFilters([])}>Clear all</button>
          ) : null}
        </div>
      ) : null}

      {/* P1-2: when ANY panel carries a gridPos, lay out as a 12-column grid and span each
          tile by its width; when NONE do, keep the flow layout untouched (back-compat). */}
      <div
        className="dash-grid"
        style={hasGridPos ? { gridTemplateColumns: 'repeat(12, 1fr)' } : undefined}
      >
        {filtered.map((panel, i) => {
          const key = `${JSON.stringify(panels[i])}`;
          return (
            <div key={key} style={hasGridPos ? { gridColumn: `span ${spanOf(panels[i])}`, minWidth: 0 } : undefined}>
              <PanelCard
                view={view}
                panel={panel}
                onResolved={onResolved(key)}
                onDrill={onDrill}
                metricIdOf={metricIdOf}
                metricsReady={metricsReady}
              />
            </div>
          );
        })}
      </div>

      {drill ? (
        <DrillDrawer
          view={view}
          panel={drill.panel}
          drill={drill.request}
          onClose={() => setDrill(null)}
          metricIdOf={metricIdOf}
        />
      ) : null}
    </div>
  );
}
