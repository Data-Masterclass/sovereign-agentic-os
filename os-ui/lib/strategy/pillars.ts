/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { osMirror } from '@/lib/infra/os-mirror';
import type { CurrentUser } from '@/lib/core/auth';
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
  nextPillarScope,
  PILLAR_SCOPE_LABEL,
} from '@/lib/strategy/model';
import { auditStrategy } from '@/lib/strategy/audit';
import { type ArtifactVersion, versionLog } from '@/lib/core/versioning';
import {
  linkBetStub,
  unlinkBetStub,
  betCatalogue,
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

// --------------------------------------------------------------- Read paths ----

/**
 * Pillars a user may view: their own personal (My) pillars + their domain
 * pillars + all tenant (Company) pillars. Archived pillars are hidden from the
 * default working list; `includeArchived` opts them back in for the owner/editor
 * to restore or delete.
 */
const SCOPE_ORDER: Record<PillarScope, number> = { tenant: 0, domain: 1, personal: 2 };

export async function listPillars(
  user: CurrentUser,
  opts: { includeArchived?: boolean } = {},
): Promise<Pillar[]> {
  const map = await getCache();
  return [...map.values()]
    .filter((p) => canViewPillar(user, p) && (opts.includeArchived || !p.archived))
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
  if (p.betIds.length > 0) {
    throw withStatus(
      new Error(
        `This pillar still has ${p.betIds.length} linked big bet${p.betIds.length === 1 ? '' : 's'}. Unlink them first — they stay in the Big Bets tab.`,
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
