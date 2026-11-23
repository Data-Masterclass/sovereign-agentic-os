/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { isCompanyScope, inLiveDomainScope } from '@core/kernel/company-scope';
import type { Role } from '@core/kernel/session';
import { type DashTier, type DashboardRecord, dashboardRecord, governDashboard } from '@tabs/dashboards/lib/governance';
import { assertServableFilters, type DashboardSpec } from '@tabs/dashboards/lib/model';
import { osMirror } from '@core/infra/os-mirror';
import { mirrorRefresher, newMirrorRefresh, type MirrorRefreshState } from '@core/infra/mirror-refresh';
import { newSeenFields, noteSeen, writeDeleted, writeChanged, writeNew, refreshRecord, type SeenFields } from '@core/infra/field-writes';
import { type ArtifactVersion, versionLog } from '@core/kernel/versioning';
import { canManageArtifact, type ArtifactScope } from '@core/policy/edit-scope';
// The GOVERNED folder registry (Wave-2 parity rollout) — a moved-into folder is upserted
// as an explicit row so it persists even when empty. Reused, never forked (mirrors Data).
import { ensureFolderRow, type FolderScope, type Principal as FolderPrincipal } from '@core/folders/index';
import { normaliseFolderPath } from '@core/kernel/folders';
// Every dashboard mutation announces itself ONCE here; the server-only git commit hook
// (lib/git/commit.ts) subscribes at boot. This module is reachable from the CLIENT bundle through
// lib/index.ts, so it must not import node:fs or isomorphic-git — hence the event seam (D8).
import { emitDashboardChange } from '@tabs/dashboards/lib/dashboard-events';
import { snapshotDashboard, type SnapshotDashboard, type SnapshotResolvers } from '@tabs/dashboards/lib/git/snapshot';
import { dashboardLifecycle } from '@tabs/dashboards/lib/lifecycle-port';

/**
 * A small in-memory dashboard registry (mirrors lib/data/store's shape + discipline:
 * pure, principal-scoped, seeded with a teaching example). Dashboards are tiles the
 * Dashboards tab lists Mine / Domain / Marketplace and the user opens (double-click →
 * embed). Persistence is process-local — the same honest in-memory pattern the rest of
 * the OS uses pre-deploy; the real store is wired at deploy.
 */

export type Principal = { id: string; domains: string[]; role: Role };

/** `updatedAt` is stamped on every write (absent on a dashboard not written since it was added):
 *  the worker's mirror refresh takes the mirror copy only when it is newer. */
type Stored = DashboardRecord & { domain: string; archived?: boolean; folder?: string; updatedAt?: string };

/** The edit-scope arg for a dashboard. A `personal`-tier dashboard is owner-only
 *  (no admin/domain_admin reaches another user's private dashboard). */
function manageArg(d: Stored): { owner: string; domain: string; scope: ArtifactScope } {
  const scope: ArtifactScope = d.tier === 'personal' ? 'personal' : d.tier === 'marketplace' ? 'certified' : 'shared';
  return { owner: d.owner, domain: d.domain, scope };
}

// A fresh tenant starts EMPTY. Dashboards are created only through the
// platform's own governed flows (e.g. the Northpeak e-commerce seed).
const SEED: Stored[] = [];

type DashState = {
  dashboards: Stored[];
  hydration: Promise<void> | null;
  hydratedAt?: number;
  hydrateFailedAt?: number;
  /** What this process last knew the mirror held per dashboard (see `core/infra/field-writes.ts`). */
  seen: SeenFields;
  /** The run worker re-reads the mirror before serving (`core/infra/mirror-refresh.ts`). */
  refresh: MirrorRefreshState;
};
const DASH_KEY = Symbol.for('soa.dashboards.store');
function dashState(): DashState {
  const g = globalThis as unknown as Record<symbol, DashState | undefined>;
  if (!g[DASH_KEY]) g[DASH_KEY] = { dashboards: SEED.map((d) => ({ ...d, spec: { ...d.spec, charts: [...d.spec.charts] } })), hydration: null, seen: newSeenFields(), refresh: newMirrorRefresh() };
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
        folder: { type: 'keyword' },
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

/**
 * The ONE write path for an existing dashboard: only the fields this process changed reach the
 * mirror (an agent replacing the charts in the worker never puts back its stale copy of the
 * folder, tier or archive flag the owner set in os-ui), and the worker never re-creates a
 * dashboard deleted elsewhere. A NEW dashboard is stored whole (`writeNew`).
 */
function writeThrough(rec: Stored): void {
  rec.updatedAt = new Date().toISOString();
  writeChanged(mirror, dashState().seen, rec.id, rec as unknown as Record<string, unknown>);
}

/**
 * Refresh-before-write for a write addressed BY ID from outside this process's knowledge (the
 * `create_dashboard` tool and the build route accept a caller-chosen id). The newest mirrored
 * copy replaces this process's copy, so `saveDashboard`'s edit-scope check runs against the
 * dashboard as it really is — a dashboard created by someone else after this process booted can
 * no longer be overwritten as if it were new. Returns the mirror's answer.
 */
export async function refreshDashboardFromMirror(id: string): Promise<'found' | 'absent' | 'unreachable'> {
  const s = dashState();
  return refreshRecord(mirror, s.seen, id, {
    put: (doc) => {
      const at = s.dashboards.findIndex((d) => d.id === id);
      if (at >= 0) s.dashboards[at] = doc as unknown as Stored;
      else s.dashboards.push(doc as unknown as Stored);
    },
    drop: () => {
      s.dashboards = s.dashboards.filter((d) => d.id !== id);
    },
  });
}

/** Is a dashboard with this id held by this process? */
export function hasDashboard(id: string): boolean {
  return dashState().dashboards.some((d) => d.id === id);
}

export async function ensureHydrated(): Promise<void> {
  const s = dashState();
  if (!s.hydration) s.hydration = Promise.all([hydrate(), versions.ensureHydrated()]).then(() => {});
  await s.hydration;
  // Re-read what the other process wrote since (throttled; worker: full, os-ui: changes — mirror-refresh.ts).
  if (s.hydratedAt !== undefined) await refresher.beforeRead();
}

/** The shared worker refresh (`core/infra/mirror-refresh.ts`), applied to the dashboards. */
const refresher = mirrorRefresher<Stored>(mirror, () => dashState().refresh, {
  label: 'dashboards',
  size: 1000,
  held: (id) => dashState().dashboards.find((d) => d.id === id),
  put: (rec) => {
    const s = dashState();
    const at = s.dashboards.findIndex((d) => d.id === rec.id);
    if (at >= 0) s.dashboards[at] = rec;
    else s.dashboards.push(rec);
    noteSeen(s.seen, rec.id, rec as unknown as Record<string, unknown>);
  },
  drop: (id) => {
    const s = dashState();
    const before = s.dashboards.length;
    s.dashboards = s.dashboards.filter((d) => d.id !== id);
    return s.dashboards.length < before;
  },
});

/** Declare THIS process a reader of the dashboards the other process writes (worker: 'full', os-ui: 'changes' — mirror-refresh.ts). */
export function enableMirrorRefresh(on = true): boolean {
  return refresher.enable(on);
}

async function hydrate(): Promise<void> {
  const s = dashState();
  const docs = await mirror.hydrate(1000);
  if (docs === null) {
    // The mirror was unreachable. Stay UN-hydrated and record the failure, so a later read
    // retries and so `hydrationState()` can tell the boot reconcile not to run. A FAILED
    // hydration must never be cached as done — the data store's rule, for the same reason.
    s.hydrateFailedAt = Date.now();
    return;
  }
  refresher.noteHydrated((docs as Stored[]).filter((r) => r && r.id).map((r) => r.id));
  for (const rec of docs as Stored[]) {
    if (rec && rec.id && !s.dashboards.find((d) => d.id === rec.id)) {
      s.dashboards.push(rec);
      noteSeen(s.seen, rec.id, rec as unknown as Record<string, unknown>);
    }
  }
  s.hydratedAt = Date.now();
}

export function __resetDashboards(): void {
  const s = dashState();
  s.dashboards = SEED.map((d) => ({ ...d, spec: { ...d.spec, charts: [...d.spec.charts] } }));
  s.hydration = null;
  delete s.hydratedAt;
  delete s.hydrateFailedAt;
  s.seen.clear();
  s.refresh = newMirrorRefresh();
  mirror.__reset();
  versions.__reset();
}

/**
 * Cross-domain governance move (admin-only, gated in lib/platform-admin/domain-move.ts).
 * Reassigns the stored `domain` on matching dashboards and writes each through
 * the durable mirror. `sel.id` moves one; `sel.onlyUnassigned` sweeps only
 * empty-domain records. Returns the ids moved.
 */
export function moveDashboardsDomain(
  sel: { id?: string; onlyUnassigned?: boolean },
  target: string,
  // M-8: the acting admin's principal id. It used to be hard-coded `system` in the emitted event,
  // so a cross-domain move — which rewrites TWO repositories — was authored by nobody. The
  // parameter is optional ONLY so the pre-existing callers keep compiling; an absent actor is
  // recorded as `system` AND logged as the attribution gap it is, never silently.
  actorId?: string,
): string[] {
  if (!actorId) {
    console.warn(
      '[dashboards] moveDashboardsDomain called with no actorId — the commit will be authored `system`. ' +
        'Pass the acting admin\'s principal id so a cross-domain move names its author.',
    );
  }
  const moved: string[] = [];
  for (const d of dashState().dashboards) {
    if (sel.id !== undefined && d.id !== sel.id) continue;
    if (sel.onlyUnassigned && d.domain) continue;
    if (d.domain === target) continue;
    const previousDomain = d.domain;
    d.domain = target;
    writeThrough(d);
    // A cross-domain move changes TWO repositories: the old one loses the dashboard, the new one
    // gains it. The hook commits both, each from its own captured state.
    announce(d, actorId ?? 'system', 'move dashboard between domains', previousDomain);
    moved.push(d.id);
  }
  return moved;
}

/**
 * UNSCOPED enumeration of every live dashboard with its full spec — for the OS-wide
 * `dependentsOf` dependency walk (lib/core/dependents.ts), which must see EVERY dependent
 * regardless of the actor's visibility (a warn-before-break preflight). Server-side only;
 * never expose through a user-facing route.
 */
export function listAllDashboardsInternal(): { id: string; name: string; spec: DashboardSpec }[] {
  return dashState().dashboards
    .filter((d) => !d.archived)
    .map((d) => ({ id: d.id, name: d.spec.name, spec: d.spec }));
}

/**
 * Announce a dashboard write. Called by EVERY mutator in this module — the enumeration test in
 * `lib/git/commit.test.ts` fails when a new writer is added without one, which is what makes
 * "every mutation is a git commit" non-optional rather than a convention (D8, G1).
 *
 * `previousDomain` is set only for a cross-domain move, where TWO repositories change.
 */
function announce(rec: Stored, actorId: string, action: string, previousDomain?: string): void {
  emitDashboardChange({
    domain: rec.domain ?? '',
    dashboardId: rec.id,
    name: rec.spec.name,
    action,
    actorId,
    ...(previousDomain && previousDomain !== rec.domain ? { previousDomain } : {}),
  });
}

/**
 * UNSCOPED per-domain read, flattened for the git generator — the dashboards of ONE domain as the
 * `dashboards/**` subtree should hold them. Server-side only (the commit hook): it deliberately
 * ignores the caller's visibility, because the repository must contain the domain's dashboards
 * regardless of who happened to trigger the write. No secrets and no principal ids leave: the
 * snapshot hashes the owner (see `lib/git/snapshot.ts`).
 */
export async function dashboardsForProject(domain: string, resolvers: SnapshotResolvers = {}): Promise<SnapshotDashboard[]> {
  if (!domain) return [];
  const rows = dashState().dashboards.filter((d) => d.domain === domain && !d.archived);
  // Stream V owns lifecycle; this tab only RECORDS the pin it is given. H-5: V's `livePin` is
  // ASYNC (the pins live in a durable mirror), so the pins are resolved HERE, before the pure
  // generator runs — `lib/git/generate.ts` must stay synchronous and store-free.
  const pins = new Map<string, NonNullable<SnapshotDashboard['lifecycle']>>();
  if (!resolvers.lifecycle) {
    await Promise.all(
      rows.map(async (d) => {
        const pin = await dashboardLifecycle(d.id);
        if (pin) pins.set(d.id, pin);
      }),
    );
  }
  const withLifecycle: SnapshotResolvers = {
    ...resolvers,
    lifecycle: resolvers.lifecycle ?? ((id: string) => pins.get(id) ?? null),
  };
  return rows.map((d) => snapshotDashboard(d, withLifecycle));
}

/**
 * Did the registry really LOAD? The boot reconcile must never run on an unverified store: an
 * empty registry whose mirror was unreachable is indistinguishable from a tenant that owns no
 * dashboards, and committing the former would DELETE every dashboard directory in every domain
 * and push that to the mirror. Mirrors `tabs/agents/lib/store.ts` `hydrationState` exactly.
 */
export function hydrationState(): 'hydrated' | 'failed' | 'pending' {
  const s = dashState();
  if (s.hydratedAt !== undefined) return 'hydrated';
  return s.hydrateFailedAt !== undefined ? 'failed' : 'pending';
}

/** Every domain that currently holds a live dashboard — the reconcile's target set. */
export function dashboardDomains(): string[] {
  const out = new Set<string>();
  for (const d of dashState().dashboards) if (d.domain && !d.archived) out.add(d.domain);
  return [...out].sort();
}

export type DashboardSummary = { id: string; name: string; view: string; tier: DashTier; owner: string; domain?: string; charts: number; folder: string; archived?: boolean };

function summarise(d: Stored): DashboardSummary {
  return { id: d.id, name: d.spec.name, view: d.spec.view, tier: d.tier, owner: d.owner, domain: d.domain || undefined, charts: d.spec.charts.length, folder: d.folder ?? '/', archived: d.archived ?? false };
}

export type DashboardGroups = { mine: DashboardSummary[]; domain: DashboardSummary[]; marketplace: DashboardSummary[] };

/** List dashboards visible to the user, grouped like every other governed surface.
 *  Archived dashboards are soft-hidden by default (reversible).
 *
 *  GROUP BY VISIBILITY (tier), not ownership; ACTIVE-DOMAIN NARROWING for My and Domain
 *  (a Company dashboard is visible in EVERY domain — core/kernel/company-scope). auth.ts narrows
 *  user.domains to [active] when a domain is chosen, so each tier filters to it; "All
 *  Domains" keeps every membership so all show; a domainless dashboard always shows.
 *  This closes the leak where an owner's domain-A dashboard showed while acting in
 *  domain B (the old `else if owner ===` fallthrough put an out-of-scope owned domain
 *  dashboard into "My"). Cross-domain discovery is the dedicated Marketplace's job. */
export function listDashboards(user: Principal, opts: { includeArchived?: boolean } = {}): DashboardGroups {
  const mine: DashboardSummary[] = [];
  const domain: DashboardSummary[] = [];
  const marketplace: DashboardSummary[] = [];
  for (const d of dashState().dashboards) {
    if (d.archived && !opts.includeArchived) continue;
    // Visibility gate first (a Personal dashboard is owner-only), THEN group by tier.
    const visible = isCompanyScope(d.tier) || d.tier === 'domain' || d.owner === user.id;
    if (!visible) continue;
    // Active-domain narrowing for My + Domain; a COMPANY dashboard shows in every domain
    // (owner decision 2026-11-23 — core/kernel/company-scope).
    if (!inLiveDomainScope({ company: isCompanyScope(d.tier), domain: d.domain }, user.domains)) continue;
    if (d.tier === 'marketplace') marketplace.push(summarise(d));
    else if (d.tier === 'domain') domain.push(summarise(d));
    else mine.push(summarise(d)); // personal
  }
  return { mine, domain, marketplace };
}

/** Dashboards the user can see that are bound to a given governed view — the reverse
 *  lookup the Data tab's Publish stage uses to list "dashboards on this dataset".
 *  Pure over {@link listDashboards} (so it stays RLS-filtered); no new store read. */
export function getDashboardsForView(view: string, user: Principal): DashboardSummary[] {
  const { mine, domain, marketplace } = listDashboards(user);
  return [...mine, ...domain, ...marketplace].filter((d) => d.view === view);
}

export function getDashboard(id: string, user: Principal): Stored {
  const d = dashState().dashboards.find((x) => x.id === id);
  if (!d) throw status(`dashboard '${id}' not found`, 404);
  const visible = isCompanyScope(d.tier) || d.owner === user.id || (d.tier === 'domain' && user.domains.includes(d.domain));
  if (!visible) throw status('not authorized to view this dashboard', 403);
  return d;
}

/**
 * Read a dashboard for a GOVERNANCE act on the AUDIENCE ladder (promote · certify · revoke)
 * — the normal view gate UNIONED with the ladder's appointed approvers for the owning
 * domain (an in-domain `domain_admin`, or a platform `admin`).
 *
 * WHY THIS IS A SEPARATE FUNCTION, AND WHY IT IS NOT A PRIVACY HOLE.
 *
 * `getDashboard` makes a Personal dashboard visible to its OWNER alone, and
 * `canManageArtifact` closes the `personal` scope absolutely — deliberately, because an
 * admin has no business reading a colleague's private draft. But `transitionDashboard` read
 * the record through that same gate, so the domain admin who must approve a filed
 * `artifact_promote` could not read it either: every dashboard promotion was fileable and
 * then permanently unapprovable, dying with "not authorized to view this dashboard" on the
 * approver's click. The owner could not approve it themself either, because `canApprove`
 * refuses the requester (four-eyes). A dashboard could not leave My at all.
 *
 * The resolution is not to weaken `canManageArtifact` — it is that THE OWNER'S FILED REQUEST
 * IS THE CONSENT. A Personal dashboard only ever reaches this function because its owner
 * asked for it to be published (`fileArtifactPromotion` is owner-only, and
 * `promoteThroughSeam` admits a non-owner only as the approve-half of a request that
 * already exists). What is exposed is the record the owner is asking the domain admin to
 * decide on, to exactly the person appointed to decide it.
 *
 * It is NEVER narrower than `getDashboard`, so no existing consumer loses a read; and the
 * general list/read surfaces still go through `getDashboard`, unchanged.
 */
export function getDashboardForGovernance(id: string, user: Principal): Stored {
  const d = dashState().dashboards.find((x) => x.id === id);
  if (!d) throw status(`dashboard '${id}' not found`, 404);
  const visible = isCompanyScope(d.tier) || d.owner === user.id || (d.tier === 'domain' && user.domains.includes(d.domain));
  const isLadderApprover =
    user.role === 'admin' || (user.role === 'domain_admin' && user.domains.includes(d.domain));
  if (visible || isLadderApprover || canManageArtifact(user, manageArg(d))) return d;
  throw status('not authorized to view this dashboard', 403);
}

/** The pseudo-domain of platform-wide configuration. It has a repository, but never a dashboard. */
export const PLATFORM_DOMAIN = 'platform';

/**
 * The domain a NEW dashboard belongs to. `requested` must be one of the caller's own domains
 * (403 otherwise) and never `platform` (400); with none requested it is the caller's HOME domain —
 * the first of their domains that is not `platform`. A caller with no such domain is refused (400)
 * rather than defaulted into the platform repository.
 */
export function dashboardDomainFor(user: Principal, requested?: string): string {
  const want = (requested ?? '').trim();
  if (want === PLATFORM_DOMAIN) throw status(`a dashboard cannot belong to '${PLATFORM_DOMAIN}' — choose one of your domains: ${user.domains.filter((d) => d !== PLATFORM_DOMAIN).join(', ') || '(none)'}`, 400);
  if (want) {
    if (!user.domains.includes(want)) throw status(`you are not a member of domain '${want}' — choose one of your domains: ${user.domains.filter((d) => d !== PLATFORM_DOMAIN).join(', ') || '(none)'}`, 403);
    return want;
  }
  const home = user.domains.find((d) => d && d !== PLATFORM_DOMAIN);
  if (!home) throw status(`you belong to no domain a dashboard can live in (only '${PLATFORM_DOMAIN}') — ask an admin to add you to a domain`, 400);
  return home;
}

/** Create (or replace) a dashboard the user owns — both build modes land here. */
export function saveDashboard(user: Principal, id: string, spec: DashboardSpec, opts: { domain?: string } = {}): Stored {
  // M-7: the STORE is the boundary, so the servability gate lives here and not only in the MCP
  // tool. Every door — the tab's save route, `create_dashboard`, a `git push` ingest — lands in
  // this function, and a panel whose filter operator or time grain the governed path cannot serve
  // is refused once, here, rather than three times unevenly.
  for (const chart of spec.charts) assertServableFilters(chart);
  const existing = dashState().dashboards.find((x) => x.id === id);
  if (existing) {
    // Fail-closed edit-scope: owner, domain_admin of the owning domain, or admin.
    if (!canManageArtifact(user, manageArg(existing))) throw status('only the owner, an in-domain domain admin, or an admin can edit this dashboard', 403);
    // A replace never MOVES a dashboard: that is the governed cross-domain move, not a save.
    if (opts.domain && opts.domain.trim() && opts.domain.trim() !== existing.domain) {
      throw status(`dashboard '${id}' belongs to domain '${existing.domain}'; a save does not move it to '${opts.domain.trim()}' (use the governed domain move)`, 400);
    }
    if (existing.domain) spec = { ...spec, domain: existing.domain };
    // Snapshot the PRIOR spec before overwriting so the edit is restorable.
    versions.record(existing.id, user.id, snapshotState(existing), 'edit');
    existing.spec = spec;
    writeThrough(existing);
    announce(existing, user.id, 'edit dashboard');
    return existing;
  }
  const domain = dashboardDomainFor(user, opts.domain);
  const rec: Stored = { ...dashboardRecord(id, { ...spec, domain }, user.id, 'personal'), domain, updatedAt: new Date().toISOString() };
  dashState().dashboards.push(rec);
  writeNew(mirror, dashState().seen, rec.id, rec as unknown as Record<string, unknown>);
  announce(rec, user.id, 'create dashboard');
  return rec;
}

/**
 * Rename a dashboard — change its DISPLAY name ONLY. Edit-scoped exactly like every
 * other mutation (owner always; an in-domain domain_admin / platform admin on a
 * shared/certified dashboard — the reused {@link canManageArtifact} gate via requireOwned).
 *
 * CRITICAL — the physical identity NEVER moves: `spec.view` is the FROZEN governed view the
 * dashboard binds to (every panel resolves against it). A rename touches ONLY `spec.name`
 * and NEVER `spec.view`, so no live panel binding is ever orphaned. The prior spec is
 * snapshotted to the version log first (restorable), then the name is set + persisted.
 * Trim; reject empty (400); no-op (no version churn) when unchanged.
 */
export function renameDashboard(id: string, user: Principal, newName: string): Stored {
  const d = requireOwned(id, user);
  const name = newName.trim();
  if (!name) throw status('a dashboard needs a name', 400);
  if (name === d.spec.name) return d; // no-op → no version churn
  // Snapshot the PRIOR spec before overwriting so the rename is restorable.
  versions.record(d.id, user.id, snapshotState(d), 'rename');
  // DISPLAY name only — spec.view (the frozen view identity) is deliberately untouched.
  d.spec = { ...d.spec, name };
  writeThrough(d);
  announce(d, user.id, 'rename dashboard');
  return d;
}

/** Promote/certify a dashboard (role-gated, reused from governance). */
export function transitionDashboard(id: string, approver: Principal, transition: 'promote' | 'certify'): Stored {
  // The APPROVER need not own the dashboard (see getDashboardForGovernance) — a Personal
  // dashboard is owner-visible only, so reading it through the plain view gate made every
  // filed promotion unapprovable. The role gate below is still the authority.
  const d = getDashboardForGovernance(id, approver);
  const res = governDashboard(d, transition, { id: approver.id, role: approver.role });
  if (!res.ok) throw status(res.reason ?? 'transition denied', 403);
  d.tier = res.record.tier;
  writeThrough(d);
  // A tier change MOVES the directory between the personal lane and the domain tree, so the
  // commit is a real content change, not only a metadata one.
  announce(d, approver.id, `${transition} to ${d.tier}`);
  return d;
}

/**
 * Demotion (revoke sharing) — the reverse of `transitionDashboard`, one step down:
 *   marketplace ──(Admin)──▶ domain ──(owner | in-domain Domain admin | Admin)──▶ personal
 * Mirrors `demoteSystem` (agents): Marketplace→Domain is Admin-only (only an Admin
 * certified it); Domain→Personal is the manage scope. Never deletes — only lowers
 * the tier. The gate lives here (the store is the boundary) so it holds regardless
 * of the client.
 */
export function demoteDashboard(id: string, user: Principal): Stored {
  const d = getDashboard(id, user);
  if (!user.domains.includes(d.domain)) throw status('you can only revoke sharing on dashboards in a domain you belong to', 403);
  if (d.tier === 'marketplace') {
    if (user.role !== 'admin') throw status('revoking a dashboard from the Marketplace requires an Admin', 403);
    d.tier = 'domain';
  } else if (d.tier === 'domain') {
    if (!canManageArtifact(user, manageArg(d))) throw status('unsharing requires the owner, an in-domain Domain admin, or an Admin', 403);
    d.tier = 'personal';
  } else {
    throw status('this dashboard is already personal — nothing to revoke', 400);
  }
  writeThrough(d);
  announce(d, user.id, `revoke sharing to ${d.tier}`);
  return d;
}

/** The store's edit authority: only the owner may archive/delete/restore. */
function requireOwned(id: string, user: Principal): Stored {
  const d = dashState().dashboards.find((x) => x.id === id);
  if (!d) throw status(`dashboard '${id}' not found`, 404);
  // Fail-closed edit-scope: owner, domain_admin of the owning domain, or admin.
  if (!canManageArtifact(user, manageArg(d))) throw status('only the owner, an in-domain domain admin, or an admin can modify this dashboard', 403);
  return d;
}

/** Archive / unarchive a dashboard: a reversible soft-hide (owner-scoped). */
export function setDashboardArchived(id: string, user: Principal, archived: boolean): Stored {
  const d = requireOwned(id, user);
  d.archived = archived;
  writeThrough(d);
  // An archived dashboard leaves the subtree (it is a reversible soft-hide, so unarchiving brings
  // it back) — either way the commit records what the domain's repository should now contain.
  announce(d, user.id, archived ? 'archive dashboard' : 'unarchive dashboard');
  return d;
}

/**
 * Move a dashboard into a folder (edit-scoped, write-through like every other mutation).
 * Mirrors `lib/data/store.moveDataset`: the folder is a normalised path; the folder ROOT
 * (personal vs domain tree) is decided by tier. On move we also upsert an EXPLICIT folder
 * row in the governed registry so the destination folder persists even when it holds no
 * dashboards. A viewer who cannot edit is rejected 403 and nothing is written.
 */
export function moveDashboard(id: string, user: Principal, folder: string): Stored {
  const d = requireOwned(id, user);
  d.folder = normaliseFolderPath(folder);
  writeThrough(d);
  announce(d, user.id, 'move dashboard to a folder');
  // The move already passed the dashboard's edit-scope gate above, so this same-owner
  // folder create can only mirror an authorised move (best-effort; never rolls it back).
  upsertFolderRow(d, user);
  return d;
}

/** The folder scope a dashboard lives in: a personal-tier tile's folders are the owner's
 *  PERSONAL tree; a domain/marketplace tile's folders are the owning DOMAIN's tree.
 *  Mirrors how `listDashboards` groups by tier. */
function folderScopeOf(d: Stored): FolderScope {
  return d.tier === 'personal' ? 'personal' : 'domain';
}

/** Best-effort: mirror a dashboard's folder path into the governed folder registry so an
 *  empty folder still shows in the rail. The root is implicit (never a row). createFolder
 *  is idempotent and edit-scoped; any gate failure is swallowed so a successful move is
 *  never rolled back by a folder-registry hiccup (mirrors Data's upsertFolderRow). */
function upsertFolderRow(d: Stored, user: Principal): void {
  // The shared door: root is a no-op, a refusal is logged by `ensureFolderRow` (never swallowed),
  // and the move is never rolled back by it.
  const principal: FolderPrincipal = { id: user.id, role: user.role, domains: user.domains };
  ensureFolderRow(principal, { tab: 'dashboards', scope: folderScopeOf(d), path: d.folder ?? '/', domain: d.domain });
}

/** Permanently delete a dashboard + its version history (owner-scoped). */
export function deleteDashboard(id: string, user: Principal): void {
  const d = requireOwned(id, user);
  const arr = dashState().dashboards;
  arr.splice(arr.indexOf(d), 1);
  writeDeleted(mirror, dashState().seen, d.id);
  refresher.noteDeleted(d.id);
  versions.purge(d.id);
  // Announced AFTER removal, so the hook's capture of the domain no longer holds it and the
  // commit IS the deletion.
  announce(d, user.id, 'delete dashboard');
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
  announce(d, user.id, `restore dashboard to v${version}`);
  return d;
}

function status(message: string, code: number): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = code;
  return e;
}

// ------------------------------------------------------------------ delete domain (admin) --
/** Delete-domain: every dashboard of a domain, archived included (`core/kernel/domain-delete.ts`). */
export function listDashboardsForDomain(domain: string): { id: string; name: string; owner: string; archived: boolean }[] {
  return dashState().dashboards.filter((d) => d.domain === domain).map((d) => ({ id: d.id, name: d.spec.name, owner: d.owner, archived: !!d.archived }));
}
