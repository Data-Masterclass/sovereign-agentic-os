/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Client-side contract types + tiny helpers for the Dashboards tab. These MIRROR the
 * documented route shapes (lib/dashboards/*) — the UI never imports server modules, it
 * only consumes the JSON those routes return.
 */

export type DashTier = 'personal' | 'domain' | 'marketplace';

export type DashboardSummary = {
  id: string;
  name: string;
  view: string;
  tier: DashTier;
  owner: string;
  domain?: string;
  charts: number;
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

export type VizType = 'big_number_total' | 'line' | 'bar' | 'table';
export type ChartSpec = { name: string; vizType: VizType; metric: string; dimensions?: string[] };

export type RlsRule = { clause: string; dataset?: string };
export type GuestTokenRequest = {
  resourceId: string;
  resourceType: 'dashboard';
  user: { username: string };
  rls: RlsRule[];
  ttlSeconds: number;
};
export type EmbedMode = 'live' | 'offline-mock';
export type EmbedResponse = {
  dashboardId: string;
  request: GuestTokenRequest;
  token: string;
  expiresInSeconds: number;
  mode: EmbedMode;
};

export type BuildRow = {
  tool: string;
  applied: boolean;
  verified: boolean;
  status: 'ok' | 'fail';
  detail: string;
  error?: string;
};
export type BuildReport = { rows: BuildRow[]; ok: boolean; mode: EmbedMode };
export type BuildResponse = { id: string; spec: { name: string; view: string; charts: ChartSpec[] }; build: BuildReport };

export type Comparator = 'lt' | 'lte' | 'gt' | 'gte';
export type Channel = 'email' | 'slack' | 'in_app';
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

export const VIZ_TYPES: VizType[] = ['big_number_total', 'line', 'bar', 'table'];
export const CHANNELS: Channel[] = ['email', 'slack', 'in_app'];
export const TIER_LABEL: Record<DashTier, string> = { personal: 'Personal', domain: 'Shared', marketplace: 'Certified' };
export const TIER_BADGE: Record<DashTier, string> = {
  personal: 'vis-personal',
  domain: 'vis-shared',
  marketplace: 'vis-certified',
};
