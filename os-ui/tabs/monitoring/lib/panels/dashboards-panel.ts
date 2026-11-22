/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Dashboards panels — per dashboard: broken references (a panel asks for a member the
 *             served model does not expose)
 * USER STORY: As a dashboard owner I want to know which of my dashboards would render with a missing measure or
 *             dimension, before a viewer finds a collapsed chart.
 * ARCHITECTURE:
 *   - Server-only, READ-ONLY. Dashboards = the Dashboards tab's own scoped list, each panel's members checked by that
 *     tab (`missingPanelMembers` against the served model — the same check dashboard creation warns with), injected
 *     through `sources.ts`.
 *   - Not available upstream (said in the payload): render errors and query latency/errors. Nothing records a panel
 *     query's outcome, and Trino’s system.runtime.queries has no governed read path yet — so none is shown, not even 0.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { monitoringSources, SOURCES_MISSING, type DashboardRow } from '@tabs/monitoring/lib/panels/sources';
import { live, unavailable, type NotUpstream, type SourceState } from '@tabs/monitoring/lib/panels/panels-core';

export type DashboardPanel = {
  id: string;
  name: string;
  domain: string;
  scope: 'mine' | 'domain' | 'marketplace';
  view: string;
  viewServed: boolean;
  dashboardsUrl: string;
  panels: number;
  /** Panels with at least one member the served model does not expose. */
  broken: { panel: string; missing: string[] }[];
};

export type DashboardsView = {
  view: 'dashboards';
  generatedAt: string;
  sources: { inventory: SourceState };
  summary: { dashboards: number; withBrokenReferences: number; brokenPanels: number } | null;
  dashboards: DashboardPanel[];
  notUpstream: NotUpstream[];
};

const NOT_UPSTREAM: NotUpstream[] = [
  { panel: 'Render errors', reason: 'A dashboard panel renders in the viewer’s browser and its query outcome is not recorded anywhere, so no render error history exists to show.' },
  { panel: 'Query latency and query errors', reason: 'Trino documents system.runtime.queries, but the OS has no governed read path to it yet, and per-user visibility needs Trino query rules. Not in this release.' },
];

export async function dashboardsView(user: CurrentUser, nowMs = Date.now()): Promise<DashboardsView> {
  const src = monitoringSources();
  const listed = src?.dashboards
    ? await src.dashboards({ id: user.id, domains: user.domains, role: user.role }).then((rows) => ({ ok: true as const, rows }), (e: Error) => ({ ok: false as const, error: e.message }))
    : { ok: false as const, error: src ? 'the Dashboards reader is not registered in this process (monitoring-sources.ts at boot)' : SOURCES_MISSING };
  const rows: DashboardRow[] = listed.ok ? listed.rows : [];
  const dashboards: DashboardPanel[] = rows.map((r) => ({
    id: r.id, name: r.name, domain: r.domain, scope: r.scope, view: r.view, viewServed: r.viewServed,
    dashboardsUrl: `/dashboards?focus=${encodeURIComponent(r.id)}`,
    panels: r.panels.length,
    broken: r.panels.filter((p) => p.missing.length > 0).map((p) => ({ panel: p.name, missing: p.missing })),
  }));
  dashboards.sort((a, b) => b.broken.length - a.broken.length || Number(a.viewServed) - Number(b.viewServed) || a.name.localeCompare(b.name));
  return {
    view: 'dashboards',
    generatedAt: new Date(nowMs).toISOString(),
    sources: { inventory: listed.ok ? live : unavailable(`dashboards: ${listed.error}`) },
    summary: listed.ok ? { dashboards: dashboards.length, withBrokenReferences: dashboards.filter((d) => d.broken.length).length, brokenPanels: dashboards.reduce((n, d) => n + d.broken.length, 0) } : null,
    dashboards,
    notUpstream: NOT_UPSTREAM,
  };
}
