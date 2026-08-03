/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Client-side contract types + tiny helpers for the Dashboards tab. These MIRROR the
 * documented route shapes (lib/dashboards/*) — the UI never imports server modules, it
 * only consumes the JSON those routes return.
 */

import { TIER_BADGE_CLASS } from '@/lib/core/scopes';

export type DashTier = 'personal' | 'domain' | 'marketplace';

export type DashboardSummary = {
  id: string;
  name: string;
  view: string;
  tier: DashTier;
  owner: string;
  domain?: string;
  charts: number;
  /** The folder this dashboard lives in (normalised path; `'/'` = root). */
  folder: string;
  /** Soft-archived (retained, reversible). Absent/false = live. */
  archived?: boolean;
};
export type DashboardGroups = {
  mine: DashboardSummary[];
  domain: DashboardSummary[];
  marketplace: DashboardSummary[];
};

export type MetricSummary = {
  id: string;
  name: string;
  datasetId: string;
  datasetName: string;
  member: string;
  tier: DashTier;
  owner: string;
  type: string;
};
export type MetricGroups = { mine: MetricSummary[]; domain: MetricSummary[]; marketplace: MetricSummary[] };

export type VizType = 'big_number_total' | 'big_number' | 'line' | 'area' | 'bar' | 'pie' | 'table';
export type PanelFilter = { member: string; operator: string; values: string[] };
/** A panel's position on the 12-col grid (Superset-style units). Mirrors lib model GridPos. */
export type GridPos = { x: number; y: number; w: number; h: number };
/** A native dashboard panel (Tier 1 — ECharts on the governed Cube layer). `metric` is the
 *  legacy single-member alias; `metrics` is authoritative. */
export type Panel = {
  name: string;
  vizType: VizType;
  metrics: string[];
  metric?: string;
  dimensions?: string[];
  timeDimension?: string;
  timeGrain?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  filters?: PanelFilter[];
  /** Optional grid position — drives the panel's column span in View (P1-2). Absent = ½. */
  gridPos?: GridPos;
};
/** Back-compat alias — many call-sites still say `ChartSpec`. */
export type ChartSpec = Panel;

/** The members a panel charts, folding the legacy `metric` alias into `metrics`. */
export function panelMetrics(p: Panel): string[] {
  if (p.metrics && p.metrics.length) return p.metrics;
  return p.metric ? [p.metric] : [];
}

/** A view's palette from GET /api/dashboards/cube-meta (narrowed to governed views).
 *  `served:false` ⇒ Cube does not currently serve this view (registry-fallback palette) —
 *  the builder warns loudly; charts still bind their real members and are flagged at render. */
export type PanelViewMeta = { view: string; measures: string[]; dimensions: string[]; timeDimensions: string[]; served?: boolean };
export type CubeMetaResponse = { views: PanelViewMeta[] };

/** GET /api/dashboards/[id] — the panels + binding for an existing dashboard. `filters` are
 *  the default cross-filter chips saved with it (P1-3); absent on legacy specs. */
export type DashboardDetail = { id: string; name: string; view: string; tier: DashTier; panels: Panel[]; filters?: PanelFilter[] };

/** POST /api/dashboards/panel-query — one panel's governed rows, resolved as the viewer. */
export type PanelQueryResponse = {
  rows: Record<string, unknown>[];
  mode: EmbedMode;
  pending?: boolean;
  /** LOUD degradation notice: a requested member isn't in the served Cube model (the
   *  dataset's domain table may need re-promotion). Rendered inline, never swallowed. */
  warning?: string;
  missingMembers?: string[];
  securityContext: Record<string, unknown>;
  sql: string;
};

/** Whether a panel resolved against live Cube or the honest offline-mock. */
export type EmbedMode = 'live' | 'offline-mock';

/** POST /api/dashboards/build — persist-only (Tier-1 native dashboards render at VIEW time,
 *  there is no Superset build/import step). Returns the saved spec. */
export type BuildResponse = { id: string; spec: { name: string; view: string; charts: Panel[] } };

export type Comparator = 'lt' | 'lte' | 'gt' | 'gte';
/** In-app is the only delivery channel for alerts and reports (email/Slack were UI fiction). */
export type Channel = 'in_app';
export type AlertRule = {
  id: string;
  member: string;
  comparator: Comparator;
  threshold: number;
  notify: Channel[];
  triggerAgent?: { systemId: string; agent: string; preset: string };
};
export type Notification = { channel: Channel; message: string };
export type AgentRun = { systemId: string; agent: string; preset: string; reason: string; traced: true };
export type AlertResponse = {
  breached: boolean;
  value: number;
  notifications: Notification[];
  agentRun: AgentRun | null;
  traced: boolean;
};

export type Cadence = 'daily' | 'weekly' | 'monthly';
export type ScheduledReport = { id: string; dashboardId: string; cadence: Cadence; channel: Channel; lastSentAt: number };
export type ReportResponse = {
  ok: boolean;
  report: ScheduledReport;
  send: { reportId: string; dashboardId: string; channel: Channel; sentAt: number };
};

export type GovernResponse = { ok: boolean; dashboardId: string; tier: DashTier };

/** POST JSON and surface the route's `error` field as a thrown Error. */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function flatMetrics(g: MetricGroups | null): MetricSummary[] {
  if (!g) return [];
  return [...g.mine, ...g.domain, ...g.marketplace];
}

// Dropdown order: pie + bar first (the most-reached-for panel shapes), then the rest.
export const VIZ_TYPES: VizType[] = ['pie', 'bar', 'table', 'big_number', 'line', 'area'];
export const CHANNELS: Channel[] = ['in_app'];
export const TIER_LABEL: Record<DashTier, string> = { personal: 'Personal', domain: 'Domain', marketplace: 'Company' };
// Badge CLASS per tier is OS-wide (lib/core/scopes); map this tab's vocabulary onto it.
export const TIER_BADGE: Record<DashTier, string> = {
  personal: TIER_BADGE_CLASS.personal,
  domain: TIER_BADGE_CLASS.shared,
  marketplace: TIER_BADGE_CLASS.certified,
};
