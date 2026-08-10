/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset } from '../data/index.ts';
import { cubeViewName } from '@/lib/data';
import type { CubeQuery } from '../infra/governed.ts';
import type { Granularity } from '../metrics/explorer.ts';

/**
 * The Dashboards tab CONSUMES governed metrics (it never defines them — that's the
 * Metrics tab). A dashboard is a NATIVE spec — a Cube view + panels (Tier 1: rendered
 * with Apache ECharts on the governed Cube layer, per-viewer RLS) — buildable two ways at
 * once (DUAL-MODE) that MUST land the same artifact:
 *
 *   • drag-and-drop (the user assembles panels), or
 *   • the dashboard AGENT ("build me a Sales overview") proposes the same panel list.
 *
 * Both edit the SAME dashboard. {@link fromTiles} and {@link fromAgent} both produce a
 * {@link DashboardSpec}, normalized + deduped, so the kind-gate "build a Sales Overview
 * both ways" yields one identical spec. Panels reference governed metric MEMBERS (from the
 * Metrics tab) so the dashboard's numbers match the explorer + the agent.
 *
 * {@link buildPanelCubeQuery} turns a panel into the exact Cube `load` query the viewer's
 * governed request resolves (RLS applied at Cube). Pure + tested.
 */

/** The native panel viz types. `big_number_total` is the legacy alias of `big_number`;
 *  both remain valid so a seeded/legacy spec never breaks. */
export type VizType = 'big_number_total' | 'big_number' | 'line' | 'area' | 'bar' | 'pie' | 'table';

/** A Cube `filters` clause (governed.ts shape). */
export type PanelFilter = { member: string; operator: string; values: string[] };

/** A panel's position on the dashboard grid (Superset-style 12-col units). Optional —
 *  the native grid falls back to a flow layout when absent. */
export type GridPos = { x: number; y: number; w: number; h: number };

/**
 * A native dashboard panel: one Apache-ECharts tile on the governed Cube view. A panel
 * charts one-or-more governed metric MEMBERS, optionally grouped by dimensions and/or a
 * time dimension at a chosen grain, optionally pre-filtered — all resolved live at Cube
 * under the viewer's RLS. Replaces the old Superset `ChartSpec`.
 */
export type Panel = {
  name: string;
  vizType: VizType;
  /** The governed metric members this panel resolves (`View.measure`). */
  metrics: string[];
  /** Back-compat: a single-member spec may carry `metric` instead of `metrics`;
   *  {@link normalizePanel} folds it into `metrics`. Never both authoritative at once. */
  metric?: string;
  /** Dimension members to group by. */
  dimensions?: string[];
  /** Optional time dimension member to trend over. */
  timeDimension?: string;
  /** Time grain for the time dimension (reuses the metrics Granularity). */
  timeGrain?: Granularity;
  /** Optional Cube filters pushed into the query (governed.ts filter shape). */
  filters?: PanelFilter[];
  /** Optional grid position for layout. */
  gridPos?: GridPos;
};

/** Back-compat alias — the old chart type is a panel (many call-sites still say `ChartSpec`). */
export type ChartSpec = Panel;

/** The metric members a panel resolves, folding the legacy single `metric` alias into
 *  `metrics`. Always returns at least the members the panel actually declares. */
export function panelMetrics(p: Panel): string[] {
  if (p.metrics && p.metrics.length) return p.metrics;
  return p.metric ? [p.metric] : [];
}

/** Coerce a (possibly legacy) panel to the canonical shape: `metrics` populated, the
 *  `metric` alias dropped. Idempotent; a legacy `{metric}` spec becomes `{metrics:[metric]}`. */
export function normalizePanel(p: Panel): Panel {
  const metrics = panelMetrics(p);
  const { metric: _drop, ...rest } = p;
  return { ...rest, metrics };
}

export type DashboardSpec = {
  name: string;
  /** The Cube view (one dataset's view) the dataset binds to. */
  view: string;
  charts: ChartSpec[];
  /** The OS domain the dashboard's data belongs to. When set, the Superset dataset is
   *  built on the Cube SQL API (Postgres-wire) as the domain's `bi_<domain>` principal —
   *  the ONLY endpoint that actually serves the Cube view's rows (Trino has no such view).
   *  When absent (legacy), the bundle falls back to the direct-Trino shape (no rows). */
  domain?: string;
  /** Default cross-filter chips saved WITH the dashboard: View opens narrowed to these
   *  (the same equality shape every panel pushes into its governed WHERE), Edit shows them
   *  as the authored defaults. Optional + verbatim — absent means today's behaviour (no
   *  default filter), so legacy specs are unchanged. */
  filters?: PanelFilter[];
};

/** The Cube view a dashboard is built on (one per gold dataset). */
export function viewFor(dataset: Dataset): string {
  return cubeViewName(dataset);
}

/** A panel's dedupe/identity key: viz type + metric members + the FULL slice (dimensions,
 *  time, filters). The old vizType+metrics key silently collapsed "revenue by region" and
 *  "revenue by product" into one panel on save — two panels are duplicates only when they
 *  chart the same members the same WAY. */
function panelKey(p: Panel): string {
  const filters = (p.filters ?? [])
    .map((f) => `${f.member}${f.operator}${[...f.values].sort().join('|')}`)
    .sort()
    .join(';');
  return [
    p.vizType,
    panelMetrics(p).join(','),
    (p.dimensions ?? []).join(','),
    p.timeDimension ?? '',
    p.timeGrain ?? '',
    filters,
  ].join(':');
}

function normalize(name: string, view: string, charts: Panel[], domain?: string, filters?: PanelFilter[]): DashboardSpec {
  // Coerce legacy `{metric}` panels to `{metrics}` and dedupe by (vizType, metrics) so the
  // two build modes can't double-add a tile.
  const seen = new Set<string>();
  const deduped: Panel[] = [];
  for (const raw of charts) {
    const c = normalizePanel(raw);
    const key = panelKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  const d = (domain ?? '').trim();
  // Default filters pass through VERBATIM — absent stays absent (legacy behaviour unchanged);
  // an empty array is treated as "no defaults" so a cleared chip bar never persists as [].
  const f = filters && filters.length ? filters : undefined;
  return { name: name.trim(), view, charts: deduped, ...(d ? { domain: d } : {}), ...(f ? { filters: f } : {}) };
}

/** DRAG-AND-DROP → the spec (the user dropped these chart tiles). */
export function fromTiles(name: string, view: string, charts: ChartSpec[], domain?: string, filters?: PanelFilter[]): DashboardSpec {
  return normalize(name, view, charts, domain, filters);
}

/**
 * AGENT → the spec. The dashboard agent proposes the SAME chart list (a structured
 * plan), routed through the same normalizer, so agent + drag-drop converge on one spec.
 */
export type AgentDashboardPlan = { name: string; view: string; charts: ChartSpec[]; domain?: string; filters?: PanelFilter[] };

export function fromAgent(plan: AgentDashboardPlan): DashboardSpec {
  return normalize(plan.name, plan.view, plan.charts, plan.domain, plan.filters);
}

/** Two specs are the same dashboard iff name+view+panel-set match (order-independent). */
export function sameDashboard(a: DashboardSpec, b: DashboardSpec): boolean {
  if (a.name !== b.name || a.view !== b.view || a.charts.length !== b.charts.length) return false;
  const as = a.charts.map(panelKey).sort();
  const bs = b.charts.map(panelKey).sort();
  return as.every((k, i) => k === bs[i]);
}

/**
 * The governed Cube `load` query for a native panel (Tier 1). Charts the panel's metric
 * MEMBERS as measures, groups by its dimensions + time dimension (at the chosen grain),
 * and pushes any filters through — the exact shape {@link cubeLoad} POSTs to Cube, so RLS
 * still applies. A `pie`/`bar` panel groups by its first dimension; a `line`/`area` panel
 * trends over its time dimension. Pure — the RLS security context is added at the server.
 */
export function buildPanelCubeQuery(panel: Panel): CubeQuery {
  const p = normalizePanel(panel);
  const query: CubeQuery = { measures: p.metrics, limit: 1000 };
  if (p.dimensions && p.dimensions.length) query.dimensions = p.dimensions;
  if (p.timeDimension) {
    query.timeDimensions = [{ dimension: p.timeDimension, ...(p.timeGrain ? { granularity: p.timeGrain } : {}) }];
  }
  if (p.filters && p.filters.length) query.filters = p.filters;
  return query;
}

/** The full member set a panel REQUESTS from the served model (measures + group-by
 *  dimensions + the time dimension). The Cube query must be able to resolve every one of
 *  these; a member the served model lacks means the panel would render wrong (silently). */
export function panelRequestedMembers(panel: Panel): string[] {
  const p = normalizePanel(panel);
  const out = [...p.metrics];
  if (p.dimensions) out.push(...p.dimensions);
  if (p.timeDimension) out.push(p.timeDimension);
  return out;
}

/** The served model's member set for a view (measures + dimensions + timeDimensions). */
export type ServedModel = { measures: string[]; dimensions: string[]; timeDimensions: string[] };

/**
 * The members a panel requests that the SERVED Cube model does NOT expose — the Northpeak
 * silent-degradation guard. When a promoted dataset's domain table is missing/stale, its Cube
 * view can't be served with those dimensions, so a group-by would vanish and the chart collapse
 * to a single bar. This returns exactly which members are absent so the caller can WARN loudly
 * instead of silently dropping the group-by. Empty result ⇒ every requested member resolves.
 * A served model with NO members at all (view entirely unserved) returns every requested member.
 */
export function missingPanelMembers(panel: Panel, served: ServedModel): string[] {
  const have = new Set<string>([...served.measures, ...served.dimensions, ...served.timeDimensions]);
  return panelRequestedMembers(panel).filter((m) => !have.has(m));
}
