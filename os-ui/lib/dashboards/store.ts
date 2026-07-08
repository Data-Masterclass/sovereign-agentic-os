/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Role } from '../session.ts';
import { type DashTier, type DashboardRecord, dashboardRecord, governDashboard } from './governance.ts';
import { type DashboardSpec } from './model.ts';
import { osMirror } from '../os-mirror.ts';
import { type ArtifactVersion, versionLog } from '../versioning.ts';

/**
 * A small in-memory dashboard registry (mirrors lib/data/store's shape + discipline:
 * pure, principal-scoped, seeded with a teaching example). Dashboards are tiles the
 * Dashboards tab lists Mine / Domain / Marketplace and the user opens (double-click →
 * embed). Persistence is process-local — the same honest in-memory pattern the rest of
 * the OS uses pre-deploy; the real store is wired at deploy.
 */

export type Principal = { id: string; domains: string[]; role: Role };

type Stored = DashboardRecord & { domain: string; archived?: boolean };

// A fresh tenant starts EMPTY. Dashboards are created only through the
// platform's own governed flows (e.g. the Northpeak e-commerce seed).
const SEED: Stored[] = [];

type DashState = { dashboards: Stored[]; hydration: Promise<void> | null };
const DASH_KEY = Symbol.for('soa.dashboards.store');
function dashState(): DashState {
  const g = globalThis as unknown as Record<symbol, DashState | undefined>;
  if (!g[DASH_KEY]) g[DASH_KEY] = { dashboards: SEED.map((d) => ({ ...d, spec: { ...d.spec, charts: [...d.spec.charts] } })), hydration: null };
  return g[DASH_KEY]!;
}

// ---------------------------------------------------- durable mirror (best-effort) --
const mirror = osMirror({
  index: 'os-dashboards',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        owner: { type: 'keyword' },
        domain: { type: 'keyword' },
        tier: { type: 'keyword' },
        updatedAt: { type: 'date' },
        archived: { type: 'boolean' },
        spec: { type: 'object', enabled: false },
      },
    },
  },
});

// Durable, per-dashboard version history (the reusable OS helper): the spec is
// snapshotted on every save + on restore, so any prior version is restorable.
const versions = versionLog('dashboard');
function snapshotState(rec: Stored): { spec: DashboardSpec } {
  return { spec: rec.spec };
}

function writeThrough(rec: Stored): void {
  mirror.writeThrough(rec.id, rec);
}

export async function ensureHydrated(): Promise<void> {
  const s = dashState();
  if (!s.hydration) s.hydration = Promise.all([hydrate(), versions.ensureHydrated()]).then(() => {});
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = dashState();
  const docs = (await mirror.hydrate(1000)) ?? [];
  for (const rec of docs as Stored[]) {
    if (rec && rec.id && !s.dashboards.find((d) => d.id === rec.id)) {
      s.dashboards.push(rec);
    }
  }
}

export function __resetDashboards(): void {
  const s = dashState();
  s.dashboards = SEED.map((d) => ({ ...d, spec: { ...d.spec, charts: [...d.spec.charts] } }));
  s.hydration = null;
  mirror.__reset();
  versions.__reset();
}

export type DashboardSummary = { id: string; name: string; view: string; tier: DashTier; owner: string; charts: number; archived?: boolean };

function summarise(d: Stored): DashboardSummary {
  return { id: d.id, name: d.spec.name, view: d.spec.view, tier: d.tier, owner: d.owner, charts: d.spec.charts.length, archived: d.archived ?? false };
}

export type DashboardGroups = { mine: DashboardSummary[]; domain: DashboardSummary[]; marketplace: DashboardSummary[] };

/** List dashboards visible to the user, grouped like every other governed surface.
 *  Archived dashboards are soft-hidden by default (reversible). */
export function listDashboards(user: Principal, opts: { includeArchived?: boolean } = {}): DashboardGroups {
  const mine: DashboardSummary[] = [];
  const domain: DashboardSummary[] = [];
  const marketplace: DashboardSummary[] = [];
  for (const d of dashState().dashboards) {
    if (d.archived && !opts.includeArchived) continue;
    if (d.tier === 'marketplace') marketplace.push(summarise(d));
    else if (d.owner === user.id) mine.push(summarise(d));
    else if (d.tier === 'domain' && user.domains.includes(d.domain)) domain.push(summarise(d));
  }
  return { mine, domain, marketplace };
}

export function getDashboard(id: string, user: Principal): Stored {
  const d = dashState().dashboards.find((x) => x.id === id);
  if (!d) throw status(`dashboard '${id}' not found`, 404);
  const visible = d.tier === 'marketplace' || d.owner === user.id || (d.tier === 'domain' && user.domains.includes(d.domain));
  if (!visible) throw status('not authorized to view this dashboard', 403);
  return d;
}

/** Create (or replace) a dashboard the user owns — both build modes land here. */
export function saveDashboard(user: Principal, id: string, spec: DashboardSpec): Stored {
  const existing = dashState().dashboards.find((x) => x.id === id);
  if (existing) {
    if (existing.owner !== user.id) throw status('only the owner can edit this dashboard', 403);
    // Snapshot the PRIOR spec before overwriting so the edit is restorable.
    versions.record(existing.id, user.id, snapshotState(existing), 'edit');
    existing.spec = spec;
    writeThrough(existing);
    return existing;
  }
  const rec = { ...dashboardRecord(id, spec, user.id, 'personal'), domain: user.domains[0] ?? 'sales' };
  dashState().dashboards.push(rec);
  writeThrough(rec);
  return rec;
}

/** Promote/certify a dashboard (role-gated, reused from governance). */
export function transitionDashboard(id: string, approver: Principal, transition: 'promote' | 'certify'): Stored {
  const d = getDashboard(id, approver);
  const res = governDashboard(d, transition, { id: approver.id, role: approver.role });
  if (!res.ok) throw status(res.reason ?? 'transition denied', 403);
  d.tier = res.record.tier;
  writeThrough(d);
  return d;
}

/** The store's edit authority: only the owner may archive/delete/restore. */
function requireOwned(id: string, user: Principal): Stored {
  const d = dashState().dashboards.find((x) => x.id === id);
  if (!d) throw status(`dashboard '${id}' not found`, 404);
  if (d.owner !== user.id) throw status('only the owner can modify this dashboard', 403);
  return d;
}

/** Archive / unarchive a dashboard: a reversible soft-hide (owner-scoped). */
export function setDashboardArchived(id: string, user: Principal, archived: boolean): Stored {
  const d = requireOwned(id, user);
  d.archived = archived;
  writeThrough(d);
  return d;
}

/** Permanently delete a dashboard + its version history (owner-scoped). */
export function deleteDashboard(id: string, user: Principal): void {
  const d = requireOwned(id, user);
  const arr = dashState().dashboards;
  arr.splice(arr.indexOf(d), 1);
  mirror.deleteThrough(d.id);
  versions.purge(d.id);
}

/** Version history for a dashboard, newest first (view-scoped). */
export function listDashboardVersions(id: string, user: Principal): ArtifactVersion[] {
  getDashboard(id, user); // view-scope check
  return versions.list(id);
}

/**
 * Restore a prior version of a dashboard's spec. Restore is itself auditable +
 * reversible: the current spec is snapshotted first, THEN the chosen version is
 * applied. Owner-scoped.
 */
export function restoreDashboardVersion(id: string, user: Principal, version: number): Stored {
  const d = requireOwned(id, user);
  const snap = versions.get(id, version);
  if (!snap) throw status(`version ${version} not found`, 404);
  versions.record(id, user.id, snapshotState(d), `restore of v${version}`);
  d.spec = (snap.state as { spec: DashboardSpec }).spec;
  writeThrough(d);
  return d;
}

function status(message: string, code: number): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = code;
  return e;
}
