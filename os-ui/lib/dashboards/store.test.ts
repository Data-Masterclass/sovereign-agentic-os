/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetDashboards, listDashboards, getDashboard, saveDashboard, setDashboardArchived, deleteDashboard, listDashboardVersions, restoreDashboardVersion, transitionDashboard, demoteDashboard, renameDashboard, moveDashboard, type Principal } from './store.ts';
import { __resetStore as resetFolders, listFolders as folderList } from '../folders/folder-store.ts';
import { dashboardsAdapter } from './folder-adapter.ts';
import type { DashboardSpec } from './model.ts';

const admin: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };
const builder: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };

function spec(name = 'My Dash'): DashboardSpec {
  return { name, view: 'mine', charts: [] };
}

beforeEach(() => { __resetDashboards(); resetFolders(); });

test('fresh store starts empty (SEED is empty)', () => {
  const { mine, domain, marketplace } = listDashboards(admin);
  assert.equal(mine.length + domain.length + marketplace.length, 0);
});

test('saveDashboard creates a record owned by the user', () => {
  saveDashboard(builder, 'dash_1', spec('Sales KPIs'));
  const { mine } = listDashboards(builder);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].name, 'Sales KPIs');
});

test('getDashboard returns the record for the owner', () => {
  saveDashboard(builder, 'dash_2', spec('Revenue'));
  const d = getDashboard('dash_2', builder);
  assert.equal(d.id, 'dash_2');
});

test('getDashboard throws 403 for a non-owner without domain access', () => {
  saveDashboard(builder, 'dash_3', spec('Private'));
  const other: Principal = { id: 'other', domains: [], role: 'creator' };
  assert.throws(() => getDashboard('dash_3', other), (e: { status?: number }) => e.status === 403);
});

test('globalThis pin: dashState is shared under soa.dashboards.store', () => {
  saveDashboard(builder, 'dash_g', spec('Pinned'));
  const pinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.dashboards.store')] as { dashboards: unknown[] };
  assert.ok(pinned, 'state must be present on globalThis');
  assert.equal(pinned.dashboards.length, 1, 'saved dashboard must appear in globalThis state');
});

// ------------------------------------------------ archive / delete / versions --

test('saveDashboard snapshots the prior spec; restore reverts + is itself versioned', () => {
  saveDashboard(builder, 'dash_v', spec('v0'));
  assert.equal(listDashboardVersions('dash_v', builder).length, 0);

  saveDashboard(builder, 'dash_v', spec('v1'));
  saveDashboard(builder, 'dash_v', spec('v2'));
  const history = listDashboardVersions('dash_v', builder);
  assert.equal(history.length, 2);
  assert.equal(history[0].version, 2, 'newest first');
  assert.equal((history[1].state as { spec: DashboardSpec }).spec.name, 'v0');

  restoreDashboardVersion('dash_v', builder, 1); // v1 holds the original spec
  assert.equal(getDashboard('dash_v', builder).spec.name, 'v0');
  const after = listDashboardVersions('dash_v', builder);
  assert.equal(after.length, 3);
  assert.match(after[0].summary, /restore of v1/);
});

test('archive soft-hides a dashboard; unarchive restores it; delete purges history', () => {
  saveDashboard(builder, 'dash_a', spec('Archivable'));
  saveDashboard(builder, 'dash_a', spec('edited')); // creates a version
  setDashboardArchived('dash_a', builder, true);
  assert.ok(!listDashboards(builder).mine.some((d) => d.id === 'dash_a'));
  assert.ok(listDashboards(builder, { includeArchived: true }).mine.some((d) => d.id === 'dash_a'));

  setDashboardArchived('dash_a', builder, false);
  assert.ok(listDashboards(builder).mine.some((d) => d.id === 'dash_a'));

  deleteDashboard('dash_a', builder);
  assert.throws(() => getDashboard('dash_a', builder), (e: { status?: number }) => e.status === 404);
  // fresh dashboard reusing the id has clean history (purge worked).
  saveDashboard(builder, 'dash_a', spec('Fresh'));
  assert.equal(listDashboardVersions('dash_a', builder).length, 0);
});

test('archive / delete / restore obey edit-scope (a non-owner without manage rights is rejected 403)', () => {
  saveDashboard(builder, 'dash_o', spec('Owned'));
  saveDashboard(builder, 'dash_o', spec('e'));
  // A non-owner plain creator (no manage rights) is rejected.
  const intruder: Principal = { id: 'mallory', domains: ['sales'], role: 'creator' };
  assert.throws(() => setDashboardArchived('dash_o', intruder, true), (e: { status?: number }) => e.status === 403);
  assert.throws(() => deleteDashboard('dash_o', intruder), (e: { status?: number }) => e.status === 403);
  assert.throws(() => restoreDashboardVersion('dash_o', intruder, 1), (e: { status?: number }) => e.status === 403);
});

test('P1-1: getDashboard resolves spec.name before deleteDashboard removes the record (live-cleanup prerequisite)', () => {
  // The DELETE route must resolve the dashboard name BEFORE deleting the OS record so the
  // live Superset cleanup can find it by title. This test verifies the ordering contract:
  // getDashboard succeeds while the record exists, and throws 404 after deleteDashboard.
  saveDashboard(builder, 'dash_del', { name: 'Deletion Target', view: 'v', charts: [] });
  const before = getDashboard('dash_del', builder);
  assert.equal(before.spec.name, 'Deletion Target', 'name resolvable before delete');
  deleteDashboard('dash_del', builder);
  assert.throws(() => getDashboard('dash_del', builder), (e: { status?: number }) => e.status === 404, 'record gone after delete');
});

test('archive: a PERSONAL dashboard is owner-only; a SHARED one admits domain_admin + admin', () => {
  const ownerBuilder: Principal = { id: 'ivy', domains: ['sales'], role: 'builder' };
  saveDashboard(ownerBuilder, 'dash_da', spec('Owned')); // Personal tier, owned by ivy
  const domainAdmin: Principal = { id: 'dana', domains: ['sales'], role: 'domain_admin' };
  const platformAdmin: Principal = { id: 'sara', domains: ['ops'], role: 'admin' };
  // A PERSONAL dashboard is owner-only — not even a domain_admin/admin may manage it.
  assert.throws(() => setDashboardArchived('dash_da', domainAdmin, true), (e: { status?: number }) => e.status === 403);
  assert.throws(() => setDashboardArchived('dash_da', platformAdmin, true), (e: { status?: number }) => e.status === 403);
  // The owner (a Builder) promotes their own dashboard Personal→Domain (shared).
  transitionDashboard('dash_da', ownerBuilder, 'promote');
  // Now the in-domain domain_admin + platform admin manage the shared dashboard.
  assert.equal(setDashboardArchived('dash_da', domainAdmin, true).archived, true);
  assert.equal(setDashboardArchived('dash_da', platformAdmin, false).archived, false);
  // A domain_admin of ANOTHER domain is denied.
  const otherDomainAdmin: Principal = { id: 'omar', domains: ['ops'], role: 'domain_admin' };
  assert.throws(() => setDashboardArchived('dash_da', otherDomainAdmin, true), (e: { status?: number }) => e.status === 403);
});

// ------------------------------------------------- active-domain scoping (0.6.x) --

test('active-domain: personal dashboard in domain A does NOT appear when domain B is active', () => {
  const userA: Principal = { id: 'zoe', domains: ['sales'], role: 'creator' };
  saveDashboard(userA, 'dash_scope_a', spec('Sales Dash'));
  // Simulate "domain B active": user.domains narrowed to ['ops']
  const userB: Principal = { id: 'zoe', domains: ['ops'], role: 'creator' };
  const { mine } = listDashboards(userB);
  assert.ok(!mine.some((d) => d.id === 'dash_scope_a'), 'domain-A dashboard must not appear when domain B is active');
});

test('active-domain: personal dashboard in domain A DOES appear when domain A is active', () => {
  const userA: Principal = { id: 'zoe', domains: ['sales'], role: 'creator' };
  saveDashboard(userA, 'dash_scope_b', spec('Sales Dash'));
  const { mine } = listDashboards(userA);
  assert.ok(mine.some((d) => d.id === 'dash_scope_b'), 'domain-A dashboard must appear when domain A is active');
});

test('active-domain: personal dashboard appears when "All Domains" is active (user.domains = all)', () => {
  const userA: Principal = { id: 'zoe', domains: ['sales'], role: 'creator' };
  saveDashboard(userA, 'dash_scope_c', spec('Sales Dash'));
  // Simulate "All Domains": user.domains = all memberships
  const userAll: Principal = { id: 'zoe', domains: ['sales', 'ops'], role: 'creator' };
  const { mine } = listDashboards(userAll);
  assert.ok(mine.some((d) => d.id === 'dash_scope_c'), 'domain-A dashboard must appear when All Domains is active');
});

test('active-domain: the per-tab Company (Marketplace) tier IS narrowed by active domain', () => {
  // Strict-isolation model: a certified dashboard homed in sales does NOT show in an
  // ops user's tab. Cross-domain discovery is the dedicated Marketplace catalog's job.
  const userA: Principal = { id: 'ada', domains: ['sales'], role: 'admin' };
  saveDashboard(userA, 'dash_scope_mkt', spec('Public Dash')); // stamped domain = sales
  transitionDashboard('dash_scope_mkt', userA, 'promote');
  transitionDashboard('dash_scope_mkt', userA, 'certify');
  const userOps: Principal = { id: 'bob', domains: ['ops'], role: 'creator' };
  assert.ok(!listDashboards(userOps).marketplace.some((d) => d.id === 'dash_scope_mkt'),
    'a sales-homed certified dashboard must NOT show in an ops user\'s Company tier');
  assert.ok(listDashboards(userA).marketplace.some((d) => d.id === 'dash_scope_mkt'),
    'it shows under Company for a sales user');
});

// ------------------------------------------------- rename: display name + FROZEN view --

test('renameDashboard: changes spec.name but spec.view stays FROZEN', () => {
  saveDashboard(builder, 'dash_rn', { name: 'Sales Overview', view: 'sales__orders', charts: [] });
  const renamed = renameDashboard('dash_rn', builder, 'Revenue Overview');
  assert.equal(renamed.spec.name, 'Revenue Overview', 'display name changed');
  assert.equal(renamed.spec.view, 'sales__orders', 'the Cube view is FROZEN across a rename');
  // The tile summary carries the new name; the view (physical identity) is unchanged.
  const d = getDashboard('dash_rn', builder);
  assert.equal(d.spec.name, 'Revenue Overview');
  assert.equal(d.spec.view, 'sales__orders');
});

test('renameDashboard: snapshots the prior name to the version log (restorable); a no-op does not churn', () => {
  saveDashboard(builder, 'dash_rn2', spec('Before'));
  const beforeVersions = listDashboardVersions('dash_rn2', builder).length;
  renameDashboard('dash_rn2', builder, 'After');
  assert.equal(listDashboardVersions('dash_rn2', builder).length, beforeVersions + 1, 'rename snapshots the prior spec');
  // A rename to the SAME name is a no-op — no extra version churn.
  const n = listDashboardVersions('dash_rn2', builder).length;
  renameDashboard('dash_rn2', builder, 'After');
  assert.equal(listDashboardVersions('dash_rn2', builder).length, n, 'a no-op rename does not churn the version log');
});

test('renameDashboard: rejects an empty name (400)', () => {
  saveDashboard(builder, 'dash_rn3', spec('Named'));
  assert.throws(() => renameDashboard('dash_rn3', builder, '   '), (e: { status?: number }) => e.status === 400);
});

test('renameDashboard: owner allowed; a non-owner non-admin denied 403; a SHARED one admits in-domain domain_admin', () => {
  const ownerBuilder: Principal = { id: 'ivy', domains: ['sales'], role: 'builder' };
  saveDashboard(ownerBuilder, 'dash_rn4', spec('Owned')); // Personal, owner-only
  // A non-owner plain creator (no manage rights) is rejected.
  const intruder: Principal = { id: 'mallory', domains: ['sales'], role: 'creator' };
  assert.throws(() => renameDashboard('dash_rn4', intruder, 'Hijack'), (e: { status?: number }) => e.status === 403);
  // A PERSONAL dashboard is owner-only — not even a domain_admin may rename it.
  const domainAdmin: Principal = { id: 'dana', domains: ['sales'], role: 'domain_admin' };
  assert.throws(() => renameDashboard('dash_rn4', domainAdmin, 'Nope'), (e: { status?: number }) => e.status === 403);
  // Promote to Domain (shared) → an in-domain domain_admin may rename it.
  transitionDashboard('dash_rn4', ownerBuilder, 'promote');
  assert.equal(renameDashboard('dash_rn4', domainAdmin, 'Shared Renamed').spec.name, 'Shared Renamed');
});

// ------------------------------------------------------------- folder: move + adapter --

test('FOLDER: moveDashboard sets folder, normalises, and survives on the summary; edit-scoped', () => {
  saveDashboard(builder, 'dash_fld', spec('Foldered'));
  const moved = moveDashboard('dash_fld', builder, 'reports/');
  assert.equal(moved.folder, '/reports');
  // The tile summary carries the new folder for the rail/grid filter.
  assert.equal(listDashboards(builder).mine.find((d) => d.id === 'dash_fld')?.folder, '/reports');
  // A non-owner non-admin cannot move it (fail-closed 403).
  const intruder: Principal = { id: 'mallory', domains: ['sales'], role: 'creator' };
  assert.throws(() => moveDashboard('dash_fld', intruder, '/elsewhere'), (e: { status?: number }) => e.status === 403);
  // Moving back to root yields folder '/'.
  assert.equal(moveDashboard('dash_fld', builder, '/').folder, '/');
});

test('FOLDER: moving into a folder upserts an explicit registry row (persists when empty)', () => {
  saveDashboard(builder, 'dash_fld2', spec('Foldered2'));
  moveDashboard('dash_fld2', builder, '/reports');
  const rows = folderList(builder, 'dashboards', 'personal');
  assert.ok(rows.some((r) => r.path === '/reports'), 'move must upsert the folder row');
});

const adapterUser = { id: 'amir', role: 'creator', domains: ['sales'] };

test('ADAPTER: a moved personal dashboard is found under its new folder in the PERSONAL scope only', () => {
  saveDashboard(builder, 'dash_ad1', spec('Adapted'));
  dashboardsAdapter.moveItem('dash_ad1', adapterUser, '/finance');
  assert.deepEqual(
    dashboardsAdapter.itemsUnderFolder(adapterUser, 'personal', '/finance').map((i) => i.id),
    ['dash_ad1'],
  );
  assert.deepEqual(dashboardsAdapter.itemsUnderFolder(adapterUser, 'domain', '/finance').map((i) => i.id), []);
});

test('ADAPTER: itemsUnderFolder includes ARCHIVED members for the cascade; archive/restore/delete are edit-scoped', () => {
  saveDashboard(builder, 'dash_ad2', spec('Temp'));
  dashboardsAdapter.moveItem('dash_ad2', adapterUser, '/keep');
  dashboardsAdapter.archiveItem('dash_ad2', adapterUser);
  assert.deepEqual(dashboardsAdapter.itemsUnderFolder(adapterUser, 'personal', '/keep').map((i) => i.id), ['dash_ad2']);
  // Restore un-hides it; then a non-owner is fail-closed on every op.
  dashboardsAdapter.restoreItem('dash_ad2', adapterUser);
  const intruder = { id: 'mallory', role: 'creator', domains: ['sales'] };
  assert.throws(() => dashboardsAdapter.archiveItem('dash_ad2', intruder), (e: { status?: number }) => e.status === 403);
  assert.throws(() => dashboardsAdapter.deleteItem('dash_ad2', intruder), (e: { status?: number }) => e.status === 403);
  // The owner deletes it (archive→delete allowed; adapter delete is physical).
  dashboardsAdapter.deleteItem('dash_ad2', adapterUser);
  assert.ok(!listDashboards(builder, { includeArchived: true }).mine.some((d) => d.id === 'dash_ad2'));
});

// ------------------------------------------------- demote (revoke sharing) --

test('demoteDashboard: domain -> personal by the owner; marketplace -> domain is Admin-only', () => {
  const ownerBuilder: Principal = { id: 'ivy', domains: ['sales'], role: 'builder' };
  saveDashboard(ownerBuilder, 'dash_dem1', spec('Shared KPIs'));
  transitionDashboard('dash_dem1', ownerBuilder, 'promote');
  assert.equal(getDashboard('dash_dem1', ownerBuilder).tier, 'domain');
  // The owner unshares their own domain dashboard back to personal.
  assert.equal(demoteDashboard('dash_dem1', ownerBuilder).tier, 'personal');

  // Certified: only an Admin may revoke from the marketplace.
  const salesAdmin: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };
  saveDashboard(salesAdmin, 'dash_dem2', spec('Company KPIs'));
  transitionDashboard('dash_dem2', salesAdmin, 'promote');
  transitionDashboard('dash_dem2', salesAdmin, 'certify');
  const domainAdmin: Principal = { id: 'dana', domains: ['sales'], role: 'domain_admin' };
  assert.throws(() => demoteDashboard('dash_dem2', domainAdmin), (e: { status?: number }) => e.status === 403);
  assert.equal(demoteDashboard('dash_dem2', salesAdmin).tier, 'domain');
});

test('demoteDashboard: a non-owner creator cannot unshare; personal is a 400 no-op', () => {
  const ownerBuilder: Principal = { id: 'ivy', domains: ['sales'], role: 'builder' };
  saveDashboard(ownerBuilder, 'dash_dem3', spec('Shared KPIs'));
  transitionDashboard('dash_dem3', ownerBuilder, 'promote');
  const stranger: Principal = { id: 'sam', domains: ['sales'], role: 'creator' };
  assert.throws(() => demoteDashboard('dash_dem3', stranger), (e: { status?: number }) => e.status === 403);
  // An in-domain domain_admin MAY unshare (manage scope), same rule as archive.
  const domainAdmin: Principal = { id: 'dana', domains: ['sales'], role: 'domain_admin' };
  assert.equal(demoteDashboard('dash_dem3', domainAdmin).tier, 'personal');
  // Already personal -> nothing to revoke.
  assert.throws(() => demoteDashboard('dash_dem3', ownerBuilder), (e: { status?: number }) => e.status === 400);
});
