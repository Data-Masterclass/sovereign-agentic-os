/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Role } from '../session.ts';
import { type DashTier, type DashboardRecord, dashboardRecord, governDashboard } from './governance.ts';
import { type DashboardSpec } from './model.ts';

/**
 * A small in-memory dashboard registry (mirrors lib/data/store's shape + discipline:
 * pure, principal-scoped, seeded with a teaching example). Dashboards are tiles the
 * Dashboards tab lists Mine / Domain / Marketplace and the user opens (double-click →
 * embed). Persistence is process-local — the same honest in-memory pattern the rest of
 * the OS uses pre-deploy; the real store is wired at deploy.
 */

export type Principal = { id: string; domains: string[]; role: Role };

type Stored = DashboardRecord & { domain: string };

const SEED: Stored[] = [
  {
    id: 'sales-overview',
    owner: 'amir',
    domain: 'sales',
    tier: 'domain',
    spec: {
      name: 'Sales Overview',
      view: 'Sales',
      charts: [
        { name: 'Revenue', vizType: 'big_number_total', metric: 'Sales.revenue' },
        { name: 'Revenue by region', vizType: 'bar', metric: 'Sales.revenue', dimensions: ['Sales.region'] },
      ],
    },
  },
];

let dashboards: Stored[] = [];

export function __resetDashboards(): void {
  dashboards = SEED.map((d) => ({ ...d, spec: { ...d.spec, charts: [...d.spec.charts] } }));
}
__resetDashboards();

export type DashboardSummary = { id: string; name: string; view: string; tier: DashTier; owner: string; charts: number };

function summarise(d: Stored): DashboardSummary {
  return { id: d.id, name: d.spec.name, view: d.spec.view, tier: d.tier, owner: d.owner, charts: d.spec.charts.length };
}

export type DashboardGroups = { mine: DashboardSummary[]; domain: DashboardSummary[]; marketplace: DashboardSummary[] };

/** List dashboards visible to the user, grouped like every other governed surface. */
export function listDashboards(user: Principal): DashboardGroups {
  const mine: DashboardSummary[] = [];
  const domain: DashboardSummary[] = [];
  const marketplace: DashboardSummary[] = [];
  for (const d of dashboards) {
    if (d.tier === 'marketplace') marketplace.push(summarise(d));
    else if (d.owner === user.id) mine.push(summarise(d));
    else if (d.tier === 'domain' && user.domains.includes(d.domain)) domain.push(summarise(d));
  }
  return { mine, domain, marketplace };
}

export function getDashboard(id: string, user: Principal): Stored {
  const d = dashboards.find((x) => x.id === id);
  if (!d) throw status(`dashboard '${id}' not found`, 404);
  const visible = d.tier === 'marketplace' || d.owner === user.id || (d.tier === 'domain' && user.domains.includes(d.domain));
  if (!visible) throw status('not authorized to view this dashboard', 403);
  return d;
}

/** Create (or replace) a dashboard the user owns — both build modes land here. */
export function saveDashboard(user: Principal, id: string, spec: DashboardSpec): Stored {
  const existing = dashboards.find((x) => x.id === id);
  if (existing) {
    if (existing.owner !== user.id) throw status('only the owner can edit this dashboard', 403);
    existing.spec = spec;
    return existing;
  }
  const rec = { ...dashboardRecord(id, spec, user.id, 'personal'), domain: user.domains[0] ?? 'sales' };
  dashboards.push(rec);
  return rec;
}

/** Promote/certify a dashboard (role-gated, reused from governance). */
export function transitionDashboard(id: string, approver: Principal, transition: 'promote' | 'certify'): Stored {
  const d = getDashboard(id, approver);
  const res = governDashboard(d, transition, { id: approver.id, role: approver.role });
  if (!res.ok) throw status(res.reason ?? 'transition denied', 403);
  d.tier = res.record.tier;
  return d;
}

function status(message: string, code: number): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = code;
  return e;
}
