/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset } from '@tabs/data/lib/index';
import { viewName } from '@tabs/data/lib/index';
import type { Granularity } from '@tabs/metrics/lib/explorer';

/**
 * The Dashboards tab CONSUMES governed metrics (it never defines them — that's the
 * Metrics tab). A dashboard is a NATIVE spec — a governed view + panels (Tier 1: rendered
 * with Apache ECharts over governed Trino SQL, per-viewer RLS) — buildable two ways at
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
 * A panel's numbers are resolved by `runPanelQuery` (dashboards/build/panel-query.ts) through
 * the SAME compiled governed-Trino SQL path the Metrics explorer uses, under the viewer's
 * delegated identity. This module is the pure, tested SPEC model only — no query execution.
 */

/**
 * The native panel viz types, as DATA. `VizType` is derived from this array, so the MCP
 * `create_dashboard` enum, the PanelBuilder dropdown and the type can never drift from each other
 * — `mcp/dashboard-write-tools.ts` spreads this verbatim and `lib/viz-enum.test.ts` asserts the
 * equality (D11; before this, the MCP tool advertised four of the seven and silently rejected a
 * `pie` or an `area` an agent had every reason to ask for).
 *
 * `big_number_total` is the legacy alias of `big_number`; both remain valid so a seeded or legacy
 * spec never breaks.
 */
export const VIZ_TYPES = ['big_number', 'big_number_total', 'line', 'area', 'bar', 'pie', 'table'] as const;

/** The native panel viz types. Derived from {@link VIZ_TYPES} — never written out twice. */
export type VizType = (typeof VIZ_TYPES)[number];

/** A panel filter clause: a comparison pushed into the governed WHERE. */
export type PanelFilter = { member: string; operator: string; values: string[] };

/**
 * The time grains the governed query path can serve — the RUNTIME list behind
 * `@tabs/metrics/lib/explorer`'s `Granularity`, which is a bare type union with no value form.
 *
 * H-1 (SQL INJECTION, live): a panel arrives from the wire at
 * `app/api/dashboards/panel-query/route.ts` and `lib/build/panel-query.ts` used to cast
 * `p.timeGrain as Granularity` with NO runtime check. `tabs/metrics/lib/explorer.ts` then
 * interpolates it directly — `date_trunc('${spec.granularity}', "col")` — so a panel carrying
 * `timeGrain: "month'), (SELECT …"` would have closed the quote and appended SQL. The values are
 * a closed five-member set, so the fix is an allow-list check at EVERY door into the panel: the
 * query path and the `git push` reader. Never a sanitiser, never an escape — an allow-list.
 *
 * The union below is asserted equal to `Granularity` at compile time by {@link TimeGrain}.
 */
export const PANEL_TIME_GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;

/** A servable time grain. Structurally identical to `@tabs/metrics/lib/explorer`'s `Granularity`. */
export type TimeGrain = (typeof PANEL_TIME_GRAINS)[number];

/** Compile-time proof that the runtime list and the metrics `Granularity` union are the same set.
 *  If `Granularity` grows a member, this stops compiling until the list grows with it. */
const _grainsCoverGranularity: Granularity extends TimeGrain ? (TimeGrain extends Granularity ? true : never) : never = true;
void _grainsCoverGranularity;

/** Is this a time grain the governed query path can serve? */
export function isServableTimeGrain(grain: unknown): grain is TimeGrain {
  return typeof grain === 'string' && (PANEL_TIME_GRAINS as readonly string[]).includes(grain);
}

/**
 * The typed refusal for a time grain the governed path cannot serve. `status: 400`, and the
 * message does NOT echo the offending value back verbatim beyond quoting it, so a refusal can
 * never itself carry a payload into a log line that something else parses.
 */
export function unservableTimeGrainError(panel: Panel): (Error & { status: number }) | null {
  const grain = panel.timeGrain as unknown;
  if (grain === undefined || grain === null || grain === '') return null;
  if (isServableTimeGrain(grain)) return null;
  const e = new Error(
    `Panel “${panel.name}”: time grain “${String(grain).slice(0, 40)}” is not one the governed query ` +
      `path can serve. It must be one of ${PANEL_TIME_GRAINS.map((g) => `\`${g}\``).join(', ')}. ` +
      'The grain becomes part of the compiled SQL, so it is checked against a closed allow-list ' +
      'rather than escaped, and an unknown value is REFUSED.',
  ) as Error & { status: number };
  e.status = 400;
  return e;
}

/** Throw {@link unservableTimeGrainError} when the panel carries an unservable time grain. */
export function assertServableTimeGrain(panel: Panel): void {
  const e = unservableTimeGrainError(panel);
  if (e) throw e;
}

/**
 * The filter operators the GOVERNED query path can actually serve. The explorer compiles a
 * panel filter to `column IN (<parameterised values>)`, so an equality — of one value or many —
 * is servable and nothing else is.
 *
 * D10/D-R4.1: anything else used to be dropped on the floor in `lib/build/panel-query.ts`
 * (`.filter((f) => f.operator === 'equals')`) with no report, so a panel authored with
 * `amount >= 1000` silently rendered the UNFILTERED number. A silent under-filter is a wrong
 * number presented as a right one, which is the single thing this product may never do. It is now
 * a typed `bad_request` at write time AND at query time.
 */
export const SERVABLE_FILTER_OPERATORS = ['equals', 'in'] as const;

/** A servable filter operator. */
export type ServableFilterOperator = (typeof SERVABLE_FILTER_OPERATORS)[number];

/** Is this operator one the governed path can serve? */
export function isServableOperator(operator: string): operator is ServableFilterOperator {
  return (SERVABLE_FILTER_OPERATORS as readonly string[]).includes(operator);
}

/** The panel filters whose operator the governed path cannot serve (empty ⇒ all servable). */
export function unservableFilters(panel: Panel): PanelFilter[] {
  return (panel.filters ?? []).filter((f) => !isServableOperator(f.operator));
}

/**
 * The typed refusal for a filter the governed path cannot serve: `status: 400`, naming the member,
 * the operator and what IS servable, so the message is actionable rather than a shrug.
 */
export function unservableFilterError(panel: Panel): (Error & { status: number }) | null {
  const bad = unservableFilters(panel);
  if (bad.length === 0) return null;
  const list = bad.map((f) => `“${f.member} ${f.operator}”`).join(', ');
  const e = new Error(
    `Panel “${panel.name}”: filter ${list} cannot be served by the governed query path, which ` +
      `compiles a panel filter to an IN list — only ${SERVABLE_FILTER_OPERATORS.map((o) => `\`${o}\``).join(' and ')} ` +
      'are servable. The panel is REFUSED rather than rendered with the filter silently dropped, ' +
      'because that would show an unfiltered number as if it were filtered. Express the range as a ' +
      'governed metric (Metrics tab → define a filtered metric) and chart that instead.',
  ) as Error & { status: number };
  e.status = 400;
  return e;
}

/**
 * Throw when the panel carries anything the governed path cannot serve: an unservable filter
 * operator (D10) or an unservable time grain (H-1). ONE call per door, so a new door cannot
 * remember one check and forget the other.
 */
export function assertServableFilters(panel: Panel): void {
  const grain = unservableTimeGrainError(panel);
  if (grain) throw grain;
  const e = unservableFilterError(panel);
  if (e) throw e;
}

/** A panel's position on the dashboard grid (12-column units). Optional —
 *  the native grid falls back to a flow layout when absent. */
export type GridPos = { x: number; y: number; w: number; h: number };

/**
 * A native dashboard panel: one Apache-ECharts tile on a governed view. A panel charts
 * one-or-more governed metric MEMBERS, optionally grouped by dimensions and/or a time
 * dimension at a chosen grain, optionally pre-filtered — all resolved live as governed
 * Trino SQL under the viewer's RLS.
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
  /** Optional filters pushed into the governed query's WHERE clause. */
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
  /** The governed view (one dataset's view) the dashboard binds to. */
  view: string;
  charts: ChartSpec[];
  /** The OS domain the dashboard's data belongs to — scopes the governed read and the
   *  external BI (Power BI / Tableau) connection export. Optional for legacy specs. */
  domain?: string;
  /** Default cross-filter chips saved WITH the dashboard: View opens narrowed to these
   *  (the same equality shape every panel pushes into its governed WHERE), Edit shows them
   *  as the authored defaults. Optional + verbatim — absent means today's behaviour (no
   *  default filter), so legacy specs are unchanged. */
  filters?: PanelFilter[];
};

/** The governed view a dashboard is built on (one per gold dataset). */
export function viewFor(dataset: Dataset): string {
  return viewName(dataset);
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

/** The full member set a panel REQUESTS from the served model (measures + group-by
 *  dimensions + the time dimension). The governed query must be able to resolve every one
 *  of these; a member the served model lacks means the panel would render wrong (silently). */
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
 * The members a panel requests that the SERVED model does NOT expose — the Northpeak
 * silent-degradation guard. When a promoted dataset's domain table is missing/stale, its
 * view can't be served with those dimensions, so a group-by would vanish and the chart collapse
 * to a single bar. This returns exactly which members are absent so the caller can WARN loudly
 * instead of silently dropping the group-by. Empty result ⇒ every requested member resolves.
 * A served model with NO members at all (view entirely unserved) returns every requested member.
 */
export function missingPanelMembers(panel: Panel, served: ServedModel): string[] {
  const have = new Set<string>([...served.measures, ...served.dimensions, ...served.timeDimensions]);
  return panelRequestedMembers(panel).filter((m) => !have.has(m));
}
