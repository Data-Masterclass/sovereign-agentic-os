/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset } from '../data/dataset-schema.ts';
import { cubeViewName } from '../data/metrics.ts';

/**
 * The Dashboards tab CONSUMES governed metrics (it never defines them — that's the
 * Metrics tab). A dashboard is a Superset spec — a dataset on a Cube view + charts —
 * buildable two ways at once (DUAL-MODE) that MUST land the same artifact:
 *
 *   • drag-and-drop (the user assembles tiles in Superset), or
 *   • the dashboard AGENT ("build me a Sales overview") drives Superset MCP/REST.
 *
 * Both edit the SAME dashboard. {@link fromTiles} and {@link fromAgent} both produce a
 * {@link DashboardSpec}, normalized + deduped, so the kind-gate "build a Sales Overview
 * both ways" yields one identical bundle. Charts reference governed metric MEMBERS
 * (from the Metrics tab) so the dashboard's numbers match the explorer + the agent.
 *
 * Pure + tested; the Superset bundle shape mirrors the Data scaffold (read-only reuse).
 */

export type VizType = 'big_number_total' | 'line' | 'bar' | 'table';

export type ChartSpec = {
  name: string;
  vizType: VizType;
  /** The governed metric member this chart resolves (View.measure). */
  metric: string;
  /** Optional dimension members to group by. */
  dimensions?: string[];
};

export type DashboardSpec = {
  name: string;
  /** The Cube view (one dataset's view) the dataset binds to. */
  view: string;
  charts: ChartSpec[];
};

/** The Cube view a dashboard is built on (one per gold dataset). */
export function viewFor(dataset: Dataset): string {
  return cubeViewName(dataset);
}

function normalize(name: string, view: string, charts: ChartSpec[]): DashboardSpec {
  // Dedupe charts by (vizType, metric) so the two build modes can't double-add a tile.
  const seen = new Set<string>();
  const deduped: ChartSpec[] = [];
  for (const c of charts) {
    const key = `${c.vizType}:${c.metric}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  return { name: name.trim(), view, charts: deduped };
}

/** DRAG-AND-DROP → the spec (the user dropped these chart tiles). */
export function fromTiles(name: string, view: string, charts: ChartSpec[]): DashboardSpec {
  return normalize(name, view, charts);
}

/**
 * AGENT → the spec. The dashboard agent proposes the SAME chart list (a structured
 * plan), routed through the same normalizer, so agent + drag-drop converge on one spec.
 */
export type AgentDashboardPlan = { name: string; view: string; charts: ChartSpec[] };

export function fromAgent(plan: AgentDashboardPlan): DashboardSpec {
  return normalize(plan.name, plan.view, plan.charts);
}

/** Two specs are the same dashboard iff name+view+chart-set match (order-independent). */
export function sameDashboard(a: DashboardSpec, b: DashboardSpec): boolean {
  if (a.name !== b.name || a.view !== b.view || a.charts.length !== b.charts.length) return false;
  const key = (c: ChartSpec) => `${c.vizType}:${c.metric}`;
  const as = a.charts.map(key).sort();
  const bs = b.charts.map(key).sort();
  return as.every((k, i) => k === bs[i]);
}

/**
 * The Superset import bundle for the spec (dataset on the Cube view + charts). Same
 * shape as the Data scaffold so OM captures dashboard→mart lineage via the Superset
 * connector; `database_service_name` names the query service.
 */
export function supersetBundle(spec: DashboardSpec): string {
  return JSON.stringify(
    {
      dashboard: spec.name,
      database_service_name: 'trino',
      dataset: { name: spec.view, schema: 'cube', sql: `SELECT * FROM "${spec.view}"` },
      charts: spec.charts.map((c) => ({ name: c.name, viz_type: c.vizType, metric: c.metric, groupby: c.dimensions ?? [] })),
    },
    null,
    2,
  );
}
