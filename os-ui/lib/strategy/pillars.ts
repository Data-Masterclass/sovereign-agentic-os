/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { osMirror } from '@/lib/infra/os-mirror';
import type { CurrentUser } from '@/lib/core/auth';
import type { Role } from '@/lib/core/session';
import {
  type Pillar,
  type PillarScope,
  type MetricLink,
  type TargetSet,
  type ValueMetric,
  type ValueMode,
  type MetricType,
  type Horizon,
  type HorizonTarget,
  monthKey,
  computeEndDate,
  emptyValueMetric,
  canCreatePillar,
  canEditPillar,
  canViewPillar,
  canPromotePillar,
  canDemotePillar,
  nextPillarScope,
  prevPillarScope,
  PILLAR_SCOPE_LABEL,
} from '@/lib/strategy/model';
import { auditStrategy } from '@/lib/strategy/audit';
import { type ArtifactVersion, versionLog } from '@/lib/core/versioning';
import { normaliseFolderPath } from '@/lib/core/folders';
// The GOVERNED folder registry — a moved-into folder is upserted as an explicit row
// so it persists even when empty. Reused, never forked (mirrors Data/Metrics).
import { createFolder, type FolderScope, type Principal as FolderPrincipal } from '@/lib/folders/index';
import {
  linkBetStub,
  unlinkBetStub,
  betCatalogue,
  defaultBetShareSource,
  type BetShare,
} from '@/lib/strategy/bets-bridge';
import { _setPillarId } from '@/lib/bigbets/store';

/**
 * Pillar/target adapter — the registry seam for the Strategy tab. CRUD on
 * pillars (tenant/domain scope · governed-metric links · contributing bets ·
 * annual+quarterly targets), role-gated per `strategy-golden-path.md` §Roles and
 * audited via Langfuse. Persistence mirrors `lib/artifacts.ts`: an authoritative
 * in-process cache (so the whole flow runs with NO cluster) plus a best-effort
 * OpenSearch write-through ("os-strategy-pillars") for durability on a real
 * deploy. The governance rules below are the security boundary regardless of
 * backing store.
 *
 * State is pinned to `globalThis` via Symbol.for so it is a TRUE singleton across
 * all Next.js route-handler module instances — a pillar created via
 * `POST /api/strategy/pillars` is immediately visible to `GET /api/strategy/pillars`
 * (or any Big Bet route that reads pillars). Same pattern as `lib/marketplace/store.ts`
 * and `lib/agents/store.ts`.
 */

type PillarsState = { cache: Map<string, Pillar> | null };
const STATE_KEY = Symbol.for('soa.strategy.pillars');
function state(): PillarsState {
  const g = globalThis as unknown as Record<symbol, PillarsState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { cache: null };
  return g[STATE_KEY]!;
}

function now(): string {
  return new Date().toISOString();
}
function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
function withStatus(err: Error, status: number): Error {
  (err as Error & { status?: number }).status = status;
  return err;
}

// ---------------------------------------------------------------- OpenSearch ---
// Shared durable-mirror core (probe → bootstrap-on-404 → hydrate/write-through):
// lib/os-mirror.ts. A missing index is CREATED, never mistaken for a dead mirror.

const INDEX = 'os-strategy-pillars';
const mirror = osMirror({ index: INDEX });

function writeThrough(p: Pillar): void {
  mirror.writeThrough(p.id, p);
}
function deleteThrough(pid: string): void {
  mirror.deleteThrough(pid);
}

// Durable, per-pillar version history — the SAME shared helper Big Bets/Data/etc.
// use. A pillar's editable content is snapshotted on every meaningful mutation +
// on restore, and surfaced through the shared <VersionHistory> panel.
const versions = versionLog('pillar');

/** The versioned slice of a pillar — the fields a user edits. */
function snapshotState(p: Pillar): {
  name: string; description: string; scope: PillarScope; metrics: MetricLink[];
  valueMetric?: ValueMetric; targets?: TargetSet; headlineTarget?: HorizonTarget;
  betIds: string[]; archived: boolean;
} {
  return {
    name: p.name,
    description: p.description,
    scope: p.scope,
    metrics: p.metrics,
    valueMetric: p.valueMetric,
    targets: p.targets,
    headlineTarget: p.headlineTarget,
    betIds: [...p.betIds],
    archived: !!p.archived,
  };
}

// ------------------------------------------------------------------- Seeding ---

/** The governed Net Revenue Retention metric (Metrics tab → Cube). */
const NRR_METRIC: MetricLink = {
  cube: 'daily_revenue',
  measure: 'daily_revenue.total_revenue',
  title: 'Net Revenue Retention',
  basis: 'uplift',
  baseline: 1_800_000,
  seedTotal: 2_400_000, // €2.4M total → €600k uplift over the captured baseline
};

/**
 * Catalogue of governed business-value metrics a pillar can link (Metrics tab →
 * Cube). Referenced by id, never copied. `seedTotal` is the deterministic offline
 * value used when Cube is unreachable (local `kind`).
 */
export const METRIC_CATALOGUE: MetricLink[] = [
  NRR_METRIC,
  {
    cube: 'daily_revenue',
    measure: 'daily_revenue.total_revenue',
    title: 'Total revenue',
    basis: 'absolute',
    seedTotal: 2_400_000,
  },
  {
    cube: 'mart_sales',
    measure: 'mart_sales.revenue',
    title: 'Sales revenue (mart)',
    basis: 'absolute',
    seedTotal: 1_250_000,
  },
  {
    cube: 'finance',
    measure: 'finance.grossMargin',
    title: 'Gross margin',
    basis: 'uplift',
    baseline: 400_000,
    seedTotal: 760_000,
  },
];

// Pin the governed metric catalogue to globalThis so the Big Bets value spine
// (lib/bigbets/sources.ts) can resolve a bet's linked metric to its REAL current
// value without importing this server module — the same globalThis seam the
// pillars cache already uses. Loaded whenever any strategy/big-bets route runs.
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for('soa.strategy.metric-catalogue')] = METRIC_CATALOGUE;

function seed(): Pillar[] {
  // A fresh tenant starts EMPTY. Strategy pillars are created only through the
  // platform's own governed flows (e.g. the Northpeak e-commerce seed).
  return [];
}

async function getCache(): Promise<Map<string, Pillar>> {
  const s = state();
  if (s.cache) return s.cache;
  const map = new Map<string, Pillar>();
  const docs = await mirror.hydrate(1000);
  if (docs !== null) {
    for (const p of docs as Pillar[]) map.set(p.id, p);
    if (map.size === 0) for (const p of seed()) { map.set(p.id, p); writeThrough(p); }
  } else {
    // Mirror unreachable → in-memory only.
    for (const p of seed()) map.set(p.id, p);
  }
  s.cache = map;
  return map;
}

/**
 * Cross-domain governance move (admin-only, gated in lib/platform-admin/domain-move.ts).
 * Scoping reads the pillar's `domain` field, so we set it and write through.
 * `sel.id` moves one; `sel.onlyUnassigned` sweeps only empty-domain records
 * (a tenant pillar carries domain='tenant', so the sweep never touches it).
 * Returns the ids moved.
 */
export async function movePillarsDomain(sel: { id?: string; onlyUnassigned?: boolean }, target: string): Promise<string[]> {
  const map = await getCache();
  const moved: string[] = [];
  for (const p of map.values()) {
    if (sel.id !== undefined && p.id !== sel.id) continue;
    if (sel.onlyUnassigned && p.domain) continue;
    if (p.domain === target) continue;
    p.domain = target;
    p.updatedAt = new Date().toISOString();
    writeThrough(p);
    moved.push(p.id);
  }
  return moved;
}

// --------------------------------------------------------------- Read paths ----

/**
 * Pillars a user may view: their own personal (My) pillars + their domain
 * pillars + all tenant (Company) pillars. Archived pillars are hidden from the
 * default working list; `includeArchived` opts them back in for the owner/editor
 * to restore or delete.
 *
 * ACTIVE-DOMAIN scope: a personal (My) pillar shows only when its domain is in
 * the caller's live scope — with an active domain chosen, user.domains is
 * narrowed to [active], so "My" filters to that domain too. "All domains" shows
 * every personal pillar the owner holds across their memberships. Domain-scope
 * pillars already narrow via canViewPillar → entitledToDomain → user.domains.
 * Tenant (Company) pillars are never narrowed.
 */
const SCOPE_ORDER: Record<PillarScope, number> = { tenant: 0, domain: 1, personal: 2 };

export async function listPillars(
  user: CurrentUser,
  opts: { includeArchived?: boolean } = {},
): Promise<Pillar[]> {
  const map = await getCache();
  return [...map.values()]
    .filter((p) => {
      if (!canViewPillar(user, p)) return false;
      if (!opts.includeArchived && p.archived) return false;
      // ACTIVE-DOMAIN scope for the personal ("My") tier: a personal pillar is
      // owner-only but must also be scoped to the active domain so a user acting
      // in domain A does not see personal pillars they created in domain B.
      // Domain + tenant pillars are already narrowed by canViewPillar's domain check.
      if (p.scope === 'personal') return !p.domain || user.domains.includes(p.domain);
      return true;
    })
    .sort((a, b) => {
      // Company → Domain → My, then by recency within a tier.
      if (a.scope !== b.scope) return SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
      return b.updatedAt.localeCompare(a.updatedAt);
    });
}

export async function getPillar(user: CurrentUser, pid: string): Promise<Pillar> {
  const map = await getCache();
  const p = map.get(pid);
  if (!p) throw withStatus(new Error('Pillar not found'), 404);
  if (!canViewPillar(user, p)) throw withStatus(new Error('Not permitted to view this pillar'), 403);
  return p;
}

// --------------------------------------------------------------- Mutations -----

export async function createPillar(
  user: CurrentUser,
  input: {
    name: string;
    description?: string;
    scope: PillarScope;
    domain?: string;
    metrics?: MetricLink[];
    /** Describe the value metric up front (name + one-liner); mode starts 'describe'. */
    valueMetric?: { name: string; description: string };
  },
): Promise<Pillar> {
  const scope: PillarScope =
    input.scope === 'tenant' ? 'tenant' : input.scope === 'personal' ? 'personal' : 'domain';
  // tenant → literal 'tenant'; personal/domain → a real home domain (personal
  // retains it so a later My→Domain promote has a target). Falls back to the
  // user's first domain.
  const domain = scope === 'tenant' ? 'tenant' : (input.domain || user.domains[0] || 'personal');
  if (!canCreatePillar(user, scope, domain)) {
    throw withStatus(
      new Error(
        scope === 'tenant'
          ? 'Defining a Company pillar requires an Administrator'
          : scope === 'domain'
            ? 'Defining a Domain pillar requires a Builder or Admin in that domain'
            : 'Defining a My pillar requires a domain you belong to',
      ),
      403,
    );
  }
  if (!input.name?.trim()) throw withStatus(new Error('A pillar name is required'), 400);
  const map = await getCache();
  const t = now();
  const p: Pillar = {
    id: id('pillar'),
    name: input.name.trim(),
    description: input.description?.trim() ?? '',
    scope,
    domain,
    owner: user.id,
    metrics: input.metrics ?? [],
    valueMetric: input.valueMetric
      ? emptyValueMetric(input.valueMetric.name?.trim(), input.valueMetric.description?.trim())
      : undefined,
    betIds: [],
    targets: undefined,
    folder: '/',
    archived: false,
    createdAt: t,
    updatedAt: t,
  };
  map.set(p.id, p);
  writeThrough(p);
  versions.record(p.id, user.id, snapshotState(p), 'create');
  await auditStrategy({
    action: 'pillar.create',
    actor: user.id,
    domain,
    pillarId: p.id,
    pillarName: p.name,
    detail: { scope, metrics: p.metrics.map((m) => m.title) },
  });
  return p;
}

async function requireEditable(user: CurrentUser, pid: string): Promise<{ map: Map<string, Pillar>; p: Pillar }> {
  const map = await getCache();
  const p = map.get(pid);
  if (!p) throw withStatus(new Error('Pillar not found'), 404);
  if (!canEditPillar(user, p)) {
    throw withStatus(new Error('Only a Builder (domain) or Admin (tenant) can edit this pillar'), 403);
  }
  return { map, p };
}

export async function updatePillar(
  user: CurrentUser,
  pid: string,
  patch: { name?: string; description?: string; metrics?: MetricLink[] },
): Promise<Pillar> {
  const { map, p } = await requireEditable(user, pid);
  // Snapshot the PRIOR state before overwriting so every edit is restorable.
  versions.record(pid, user.id, snapshotState(p), 'edit');
  if (patch.name !== undefined) p.name = patch.name.trim() || p.name;
  if (patch.description !== undefined) p.description = patch.description.trim();
  if (patch.metrics !== undefined) p.metrics = patch.metrics;
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  await auditStrategy({ action: 'pillar.update', actor: user.id, domain: p.domain, pillarId: p.id, pillarName: p.name });
  return p;
}

/**
 * Rename a pillar — change its DISPLAY `name` ONLY. Edit-scoped exactly like every
 * other mutation ({@link requireEditable} → `canEditPillar`, roleAtLeast semantics).
 *
 * CRITICAL — the pillar `id` is the FROZEN identity every reference (a Big Bet's
 * `pillarId`, the value roll-up, the folder row) is keyed by, so a rename NEVER
 * touches `id`; only the human-facing `name` moves. Snapshots the PRIOR state to the
 * version log so the rename is itself reversible. Trim + reject-empty (400) + no-op
 * short-circuit (no version churn). No name-uniqueness rule exists on create
 * ({@link createPillar} only rejects empty), so none is invented here.
 */
export async function renamePillar(user: CurrentUser, pid: string, newName: string): Promise<Pillar> {
  const { map, p } = await requireEditable(user, pid);
  const name = newName.trim();
  if (!name) throw withStatus(new Error('A pillar name is required'), 400);
  if (name === p.name) return p; // no-op → no version churn
  // Snapshot the PRIOR state before overwriting so the rename is restorable. The id
  // is frozen and NEVER part of the mutation.
  versions.record(pid, user.id, snapshotState(p), 'rename');
  p.name = name;
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  await auditStrategy({ action: 'pillar.rename', actor: user.id, domain: p.domain, pillarId: p.id, pillarName: p.name });
  return p;
}

// -------------------------------------------------------------------- folders --
//
// PillarScope → FolderScope mapping (folders are personal|domain only; a pillar has
// a THREE-tier scope). A personal (My) pillar's folders are the owner's PERSONAL
// tree; a domain OR tenant (Company) pillar's folders are the owning DOMAIN's tree —
// a tenant pillar is org-wide, so it belongs in the domain tree keyed to the literal
// 'tenant' domain value it carries. The pillar's `domain` field is passed on the
// folder row so same-named folders across domains stay distinct.

/** Map a pillar's tier to the two-lane folder scope. */
export function folderScopeOfPillar(p: Pick<Pillar, 'scope'>): FolderScope {
  return p.scope === 'personal' ? 'personal' : 'domain';
}

/** Best-effort: mirror a pillar's folder path into the governed folder registry so an
 *  empty folder still shows in the rail. The root is implicit (never a row). The move
 *  already passed the pillar's edit-scope gate, so this same-owner folder create can
 *  only mirror an authorised move; any gate failure is swallowed so a successful move
 *  is never rolled back (mirrors Data's `upsertFolderRow`). */
function upsertPillarFolderRow(p: Pillar, user: { id: string; role: Role; domains: string[] }): void {
  const path = normaliseFolderPath(p.folder ?? '/');
  if (path === '/') return;
  const principal: FolderPrincipal = { id: user.id, role: user.role, domains: user.domains };
  try {
    createFolder(principal, { tab: 'pillars', scope: folderScopeOfPillar(p), path, domain: p.domain });
  } catch {
    /* folder-registry mirror is best-effort; the pillar move already succeeded */
  }
}

/**
 * Move a pillar into a folder (edit-scoped, write-through like every other mutation).
 * Mirrors `moveDataset`/`moveMetric`: the folder is a normalised path on the pillar;
 * the folder ROOT (personal vs domain tree) is decided by tier via
 * {@link folderScopeOfPillar}. On move we also upsert an EXPLICIT folder row so the
 * destination persists even when empty. A viewer who cannot edit is rejected 403 and
 * nothing is written. Folder is a structural placement (not versioned content), so it
 * is NOT snapshotted — same treatment as `domain`/`scope`.
 */
export async function movePillar(user: CurrentUser, pid: string, folder: string): Promise<Pillar> {
  const { map, p } = await requireEditable(user, pid);
  // Snapshot the PRIOR placement (mirrors moveDataset's 'edit folder' version) so a
  // move is auditable + reversible.
  versions.record(pid, user.id, snapshotState(p), 'edit folder');
  p.folder = normaliseFolderPath(folder);
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  // Best-effort folder-row upsert (already edit-authorised above).
  upsertPillarFolderRow(p, user);
  await auditStrategy({ action: 'pillar.move', actor: user.id, domain: p.domain, pillarId: p.id, pillarName: p.name, detail: { folder: p.folder } });
  return p;
}

/**
 * SYNC read of the ALREADY-HYDRATED in-memory pillar cache — the seam the folder
 * adapter needs. The `ArtifactAdapter` contract is synchronous (itemsUnderFolder
 * returns an array, not a Promise), but this store is async (getCache awaits the
 * durable mirror on first read). The folder API route hydrates the pillar store
 * FIRST (`ensureHydrated`) and only THEN runs the cascade, so by the time the adapter
 * reads, the cache is populated. This helper exposes that cache with NO await — it
 * never triggers a hydration itself (returns [] if somehow un-hydrated, fail-closed:
 * an empty snapshot can only ever touch fewer items, never more). Server-only.
 */
export function listPillarsSync(): Pillar[] {
  const s = state();
  return s.cache ? [...s.cache.values()] : [];
}

/**
 * SYNC edit-scoped mutators the folder adapter drives. The shared folder CASCADE
 * (`lib/folders/folder-lifecycle.ts`) calls each `ArtifactAdapter` op SYNCHRONOUSLY
 * and relies on a governance throw to surface (fail-closed) — but this store's public
 * mutators are ASYNC (they await the durable mirror + Langfuse audit). Rather than
 * fire-and-forget the async ones (which would drop a 403 into an unhandled rejection
 * and let a denied cascade proceed), these tiny helpers run the SAME `canEditPillar`
 * gate synchronously against the already-hydrated in-memory cache, mutate the Map, and
 * ride the store's own fire-and-forget mirror write-through. The version log + audit
 * are best-effort side effects fired without await. The folder route hydrates the
 * pillar store (`ensureHydrated`) BEFORE the cascade runs, so the cache is populated.
 */
/** The narrow principal the SYNC adapter helpers read (all `canEditPillar` needs).
 *  Kept looser than `CurrentUser` so the adapter can pass an `AdapterPrincipal`
 *  straight through — no synthetic `name`/`activeDomain` fields. */
type EditPrincipal = { id: string; role: Role; domains: string[] };

function requireEditableSync(user: EditPrincipal, pid: string): { map: Map<string, Pillar>; p: Pillar } {
  const s = state();
  const map = s.cache;
  if (!map) throw withStatus(new Error('Pillar store not hydrated'), 500);
  const p = map.get(pid);
  if (!p) throw withStatus(new Error('Pillar not found'), 404);
  if (!canEditPillar(user, p)) {
    throw withStatus(new Error('Only a Builder (domain) or Admin (tenant) can edit this pillar'), 403);
  }
  return { map, p };
}

/** SYNC folder move — the adapter's `moveItem` (edit-scoped, throws 403 when denied). */
export function movePillarSync(pid: string, user: EditPrincipal, folder: string): void {
  const { p } = requireEditableSync(user, pid);
  p.folder = normaliseFolderPath(folder);
  p.updatedAt = now();
  writeThrough(p);
  versions.record(pid, user.id, snapshotState(p), 'edit folder');
  upsertPillarFolderRow(p, user);
}

/** SYNC archive — the adapter's `archiveItem` (edit-scoped, throws 403 when denied). */
export function archivePillarSync(pid: string, user: EditPrincipal): void {
  const { p } = requireEditableSync(user, pid);
  versions.record(pid, user.id, snapshotState(p), 'archive');
  p.archived = true;
  p.updatedAt = now();
  writeThrough(p);
}

/** SYNC restore — the adapter's `restoreItem` (edit-scoped, throws 403 when denied). */
export function unarchivePillarSync(pid: string, user: EditPrincipal): void {
  const { p } = requireEditableSync(user, pid);
  versions.record(pid, user.id, snapshotState(p), 'restore');
  p.archived = false;
  p.updatedAt = now();
  writeThrough(p);
}

/** SYNC physical delete — the adapter's `deleteItem` (edit-scoped, throws 403 when denied).
 *  NOTE: the folder cascade only deletes an ALREADY-ARCHIVED folder's members, so a
 *  pillar reaching here has been soft-archived first. The linked-bets guard the async
 *  `deletePillar` enforces is a UI-initiated safety; the cascade path is the folder-
 *  delete discipline and removes the member row + its version history. */
export function deletePillarSync(pid: string, user: EditPrincipal): void {
  const { map, p } = requireEditableSync(user, pid);
  map.delete(pid);
  deleteThrough(pid);
  versions.purge(pid);
  void p;
}

// ------------------------------------------------ archive / restore / delete ---
//
// The SAME reversible-soft-hide → restore-or-physical-delete lifecycle every OS
// tab uses, wired through the shared lifecycle helpers on the UI. All three are
// edit-scoped (canEditPillar) and version-logged.

/** Ensure the version log is hydrated (mirrors Big Bets' ensureHydrated). */
export async function ensureHydrated(): Promise<void> {
  await Promise.all([getCache(), versions.ensureHydrated()]);
}

/** Archive a pillar: reversible soft-hide (leaves the working list). Edit-scoped. */
export async function archivePillar(user: CurrentUser, pid: string): Promise<Pillar> {
  const { map, p } = await requireEditable(user, pid);
  versions.record(pid, user.id, snapshotState(p), 'archive');
  p.archived = true;
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  await auditStrategy({ action: 'pillar.archive', actor: user.id, domain: p.domain, pillarId: pid, pillarName: p.name });
  return p;
}

/** Restore an archived pillar back into the working list. Edit-scoped. */
export async function unarchivePillar(user: CurrentUser, pid: string): Promise<Pillar> {
  const { map, p } = await requireEditable(user, pid);
  versions.record(pid, user.id, snapshotState(p), 'restore');
  p.archived = false;
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  await auditStrategy({ action: 'pillar.unarchive', actor: user.id, domain: p.domain, pillarId: pid, pillarName: p.name });
  return p;
}

/**
 * Physically delete a pillar + its version history (edit-scoped, irreversible).
 *
 * SAFE-BY-DEFAULT rule for a pillar-with-bets: a pillar that still has LINKED
 * bets is BLOCKED from deletion (409) — the non-destructive option — so a delete
 * never silently strands or destroys the bets that deliver it. Unlink the bets
 * (they live on in the Big Bets tab) first, then delete. Bets themselves are
 * never touched here.
 */
export async function deletePillar(user: CurrentUser, pid: string): Promise<void> {
  const { map, p } = await requireEditable(user, pid);
  // The authoritative "does this pillar still own bets" is the LIVE set (bets whose
  // bet.pillarId points here), NOT the denormalised p.betIds cache: deleting a big
  // bet never pruned p.betIds, so a stale id — a bet the user already deleted — used
  // to block the pillar delete forever. Count only bets that still exist.
  const liveBets = await defaultBetShareSource.forPillar(p.id);
  if (liveBets.length > 0) {
    throw withStatus(
      new Error(
        `This pillar still has ${liveBets.length} linked big bet${liveBets.length === 1 ? '' : 's'}. Unlink or delete them in the Big Bets tab first.`,
      ),
      409,
    );
  }
  map.delete(pid);
  deleteThrough(pid);
  versions.purge(pid);
  await auditStrategy({ action: 'pillar.delete', actor: user.id, domain: p.domain, pillarId: pid, pillarName: p.name });
}

// ------------------------------------------------------------------- promote ---

/**
 * Promote a pillar ONE tier up: My (personal) → Domain → Company (tenant),
 * mirroring the OS promote ladder (`promoteConnection`). Builder+ gate to Domain,
 * Admin gate to Company (enforced by `canPromotePillar`). Version-logged.
 */
export async function promotePillar(user: CurrentUser, pid: string): Promise<Pillar> {
  const map = await getCache();
  const p = map.get(pid);
  if (!p) throw withStatus(new Error('Pillar not found'), 404);
  const next = nextPillarScope(p.scope);
  if (!next) throw withStatus(new Error('This pillar is already at the Company tier'), 400);
  if (!canPromotePillar(user, p)) {
    throw withStatus(
      new Error(
        next === 'domain'
          ? 'Promoting to Domain requires a Builder or Admin in the owning domain'
          : 'Promoting to Company requires an Administrator',
      ),
      403,
    );
  }
  versions.record(pid, user.id, snapshotState(p), `promote to ${PILLAR_SCOPE_LABEL[next]}`);
  p.scope = next;
  if (next === 'tenant') p.domain = 'tenant';
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  await auditStrategy({
    action: 'pillar.promote',
    actor: user.id,
    domain: p.domain,
    pillarId: pid,
    pillarName: p.name,
    detail: { to: next },
  });
  return p;
}

/**
 * Demote (revoke sharing on) a pillar ONE tier down: Company (tenant) → Domain →
 * My (personal). The mirror of {@link promotePillar}, with the SAME role gates the
 * OS artifact ladder uses (`lib/core/artifacts.ts#demoteArtifact`, enforced by
 * `canDemotePillar`): Admin to revoke from Company, owner/in-domain Builder+ (or
 * Admin) to unshare from Domain. Never deletes the pillar — only lowers its tier.
 *
 * When a Company pillar (whose `domain` is the literal 'tenant') is demoted to
 * Domain it needs a real owning domain: the acting Admin's first domain becomes
 * the new home (they are choosing to bring it into a domain they belong to).
 * Version-logged, exactly like promote.
 */
export async function demotePillar(user: CurrentUser, pid: string): Promise<Pillar> {
  const map = await getCache();
  const p = map.get(pid);
  if (!p) throw withStatus(new Error('Pillar not found'), 404);
  const prev = prevPillarScope(p.scope);
  if (!prev) throw withStatus(new Error('This pillar is already at the My tier — nothing to revoke'), 400);
  if (!canDemotePillar(user, p)) {
    throw withStatus(
      new Error(
        p.scope === 'tenant'
          ? 'Revoking from Company requires an Administrator'
          : 'Unsharing from Domain requires the owner, an in-domain Builder, or an Admin',
      ),
      403,
    );
  }
  versions.record(pid, user.id, snapshotState(p), `revoke to ${PILLAR_SCOPE_LABEL[prev]}`);
  // Company → Domain: give it a real owning domain (the acting Admin's first).
  if (p.scope === 'tenant' && prev === 'domain') {
    p.domain = user.domains[0] || p.domain;
  }
  p.scope = prev;
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  await auditStrategy({
    action: 'pillar.demote',
    actor: user.id,
    domain: p.domain,
    pillarId: pid,
    pillarName: p.name,
    detail: { to: prev },
  });
  return p;
}

// --------------------------------------------------------------- versions ------

/** Version history for a pillar, newest first (view-scoped). */
export async function listPillarVersions(user: CurrentUser, pid: string): Promise<ArtifactVersion[]> {
  await getPillar(user, pid); // view-scope check (throws 404/403)
  return versions.list(pid);
}

/**
 * Restore a prior version of a pillar's editable content. The CURRENT state is
 * snapshotted first (so restore is itself reversible), then the chosen version's
 * fields are applied. Edit-scoped. Scope/tier is NOT changed by a restore (a
 * demotion via restore would bypass the promote gate); only content fields move.
 */
export async function restorePillarVersion(user: CurrentUser, pid: string, version: number): Promise<Pillar> {
  const { map, p } = await requireEditable(user, pid);
  const snap = versions.get(pid, version);
  if (!snap) throw withStatus(new Error(`Version ${version} not found`), 404);
  const s = snap.state as ReturnType<typeof snapshotState> | null;
  if (!s || typeof s.name !== 'string') throw withStatus(new Error(`Version ${version} has no restorable state`), 422);
  versions.record(pid, user.id, snapshotState(p), `restore of v${version}`);
  p.name = s.name;
  p.description = s.description;
  p.metrics = s.metrics;
  p.valueMetric = s.valueMetric;
  p.targets = s.targets;
  p.headlineTarget = s.headlineTarget;
  p.archived = !!s.archived;
  // scope/domain/betIds are governed relationships, not restored here.
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  await auditStrategy({ action: 'pillar.restore', actor: user.id, domain: p.domain, pillarId: pid, pillarName: p.name, detail: { version } });
  return p;
}

export async function setTargets(user: CurrentUser, pid: string, targets: TargetSet): Promise<Pillar> {
  const { map, p } = await requireEditable(user, pid);
  p.targets = targets;
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  await auditStrategy({
    action: 'targets.set',
    actor: user.id,
    domain: p.domain,
    pillarId: p.id,
    pillarName: p.name,
    detail: { annualValue: targets.valueGenerated.annual, activeBuilders: targets.activeBuilders.annual },
  });
  return p;
}

/**
 * Set (or update) the pillar's HEADLINE target — the card's big number. Ties a
 * target `value` to a `metricType` and a `horizon`, deriving the end date
 * (year-end = Dec 31 this year; N-month = today + N months). Also stamps the
 * chosen metricType onto the pillar's value metric so the total formats to match.
 */
export async function setHeadlineTarget(
  user: CurrentUser,
  pid: string,
  input: { value: number; metricType: MetricType; horizon: Horizon },
): Promise<Pillar> {
  const { map, p } = await requireEditable(user, pid);
  if (!Number.isFinite(input.value)) throw withStatus(new Error('A numeric target value is required'), 400);
  const setAt = new Date();
  const target: HorizonTarget = {
    value: input.value,
    metricType: input.metricType,
    horizon: input.horizon,
    endDate: computeEndDate(input.horizon, setAt),
    setAt: setAt.toISOString(),
  };
  p.headlineTarget = target;
  // Keep the value metric's formatting type in lockstep with the target's type.
  const vm: ValueMetric = p.valueMetric ?? emptyValueMetric();
  p.valueMetric = { ...vm, metricType: input.metricType };
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  await auditStrategy({
    action: 'headline-target.set',
    actor: user.id,
    domain: p.domain,
    pillarId: p.id,
    pillarName: p.name,
    detail: { value: input.value, metricType: input.metricType, horizon: input.horizon, endDate: target.endDate },
  });
  return p;
}

/**
 * Set (or update) the pillar's value metric: its name, one-line description, and
 * how its number is kept — described-only, a governed Cube metric (Metrics tab),
 * or manual monthly entries. Switching to/from manual preserves existing entries.
 */
export async function setValueMetric(
  user: CurrentUser,
  pid: string,
  patch: {
    name?: string;
    description?: string;
    mode?: ValueMode;
    /** Headline value-metric TYPE (EBIT/Revenue/Time Back Hours/# Risks Mitigated/Custom). */
    metricType?: MetricType;
    /** For metricType='custom': the unit label + whether it is monetary. */
    customUnit?: string;
    customMonetary?: boolean;
  },
): Promise<Pillar> {
  const { map, p } = await requireEditable(user, pid);
  const current: ValueMetric = p.valueMetric ?? emptyValueMetric();
  p.valueMetric = {
    name: patch.name !== undefined ? patch.name.trim() : current.name,
    description: patch.description !== undefined ? patch.description.trim() : current.description,
    mode: patch.mode ?? current.mode,
    entries: current.entries,
    metricType: patch.metricType ?? current.metricType,
    customUnit: patch.customUnit !== undefined ? patch.customUnit.trim() : current.customUnit,
    customMonetary: patch.customMonetary !== undefined ? patch.customMonetary : current.customMonetary,
  };
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  await auditStrategy({
    action: 'value-metric.set',
    actor: user.id,
    domain: p.domain,
    pillarId: p.id,
    pillarName: p.name,
    detail: { name: p.valueMetric.name, mode: p.valueMetric.mode },
  });
  return p;
}

/**
 * Record a manual monthly value for the pillar (mode='manual'). The newest entry
 * is the headline total; the series feeds the value-history chart. Re-entering a
 * month replaces it. Switches the metric to manual mode if it was not already.
 */
export async function addValueEntry(
  user: CurrentUser,
  pid: string,
  input: { value: number; month?: string },
): Promise<Pillar> {
  const { map, p } = await requireEditable(user, pid);
  if (!Number.isFinite(input.value)) throw withStatus(new Error('A numeric value is required'), 400);
  const month = (input.month && /^\d{4}-\d{2}$/.test(input.month)) ? input.month : monthKey();
  const vm: ValueMetric = p.valueMetric ?? emptyValueMetric();
  const entries = vm.entries.filter((e) => e.month !== month);
  entries.push({ month, value: Math.round(input.value), at: now(), by: user.id });
  entries.sort((a, b) => a.month.localeCompare(b.month));
  p.valueMetric = { ...vm, mode: 'manual', entries };
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  await auditStrategy({
    action: 'value-entry.add',
    actor: user.id,
    domain: p.domain,
    pillarId: p.id,
    pillarName: p.name,
    detail: { month, value: Math.round(input.value) },
  });
  return p;
}

/**
 * Link a Big Bet to a pillar. The bet reference is stored on the pillar; the
 * bet's value distribution is registered with the bets-bridge stub (the seam the
 * real Big Bets registry will replace). Re-normalises shares so they reconcile.
 */
export async function linkBet(user: CurrentUser, pid: string, betId: string): Promise<Pillar> {
  const { map, p } = await requireEditable(user, pid);
  // Validate the betId against what the caller may actually link — REAL bets they
  // can see (canView) ∪ the worked-example stub — so student bets link, and an
  // unseen/forged id is a typed not_found (never linked).
  const bet: BetShare | undefined = betCatalogue(user).find((b) => b.id === betId);
  if (!bet) throw withStatus(new Error('Unknown Big Bet'), 404);
  if (!p.betIds.includes(betId)) p.betIds.push(betId);
  // Stamp the bet's pillarId so the two-way index stays consistent. Any previous
  // pillar the bet was linked to will no longer claim it via bet.pillarId (the old
  // pillar's betIds still contains it until explicitly unlinked — a builder action).
  _setPillarId(betId, pid);
  // Register a fresh share for the stub source (default share until Big Bets owns it).
  linkBetStub(pid, { ...bet, sharePct: bet.sharePct || 1 });
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  await auditStrategy({
    action: 'pillar.link-bet',
    actor: user.id,
    domain: p.domain,
    pillarId: p.id,
    pillarName: p.name,
    detail: { betId, betName: bet.name },
  });
  return p;
}

export async function unlinkBet(user: CurrentUser, pid: string, betId: string): Promise<Pillar> {
  const { map, p } = await requireEditable(user, pid);
  p.betIds = p.betIds.filter((b) => b !== betId);
  // Clear the bet's pillarId so the two-way index stays consistent (only when the
  // bet actually pointed to THIS pillar — a bet may have been re-linked elsewhere).
  _setPillarId(betId, undefined);
  unlinkBetStub(pid, betId);
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  await auditStrategy({ action: 'pillar.unlink-bet', actor: user.id, domain: p.domain, pillarId: p.id, pillarName: p.name, detail: { betId } });
  return p;
}

/** Test seam: drop the in-process cache so a fresh seed loads. */
export function __resetForTests(): void {
  const s = state();
  s.cache = null;
  mirror.__reset();
  versions.__reset();
}
