/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { osMirror } from '@/lib/os-mirror';
import type { CurrentUser } from '@/lib/auth';
import {
  type Pillar,
  type PillarScope,
  type MetricLink,
  type TargetSet,
  type ValueMetric,
  type ValueMode,
  monthKey,
  emptyValueMetric,
  canCreatePillar,
  canEditPillar,
  canViewPillar,
} from '@/lib/strategy/model';
import { auditStrategy } from '@/lib/strategy/audit';
import {
  linkBetStub,
  unlinkBetStub,
  betCatalogue,
  type BetShare,
} from '@/lib/strategy/bets-bridge';

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

/** Pillars a user may view: tenant pillars + the user's domain pillars. */
export async function listPillars(user: CurrentUser): Promise<Pillar[]> {
  const map = await getCache();
  return [...map.values()]
    .filter((p) => canViewPillar(user, p))
    .sort((a, b) => {
      // Tenant pillars first, then by recency.
      if (a.scope !== b.scope) return a.scope === 'tenant' ? -1 : 1;
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
  const scope = input.scope === 'tenant' ? 'tenant' : 'domain';
  const domain = scope === 'tenant' ? 'tenant' : (input.domain || user.domains[0]);
  if (!canCreatePillar(user, scope, domain)) {
    throw withStatus(
      new Error(
        scope === 'tenant'
          ? 'Defining a shared tenant pillar requires an Administrator'
          : 'Defining a domain pillar requires a Builder or Admin in that domain',
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
    createdAt: t,
    updatedAt: t,
  };
  map.set(p.id, p);
  writeThrough(p);
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
  if (patch.name !== undefined) p.name = patch.name.trim() || p.name;
  if (patch.description !== undefined) p.description = patch.description.trim();
  if (patch.metrics !== undefined) p.metrics = patch.metrics;
  p.updatedAt = now();
  map.set(p.id, p);
  writeThrough(p);
  await auditStrategy({ action: 'pillar.update', actor: user.id, domain: p.domain, pillarId: p.id, pillarName: p.name });
  return p;
}

export async function deletePillar(user: CurrentUser, pid: string): Promise<void> {
  const { map, p } = await requireEditable(user, pid);
  map.delete(pid);
  deleteThrough(pid);
  await auditStrategy({ action: 'pillar.delete', actor: user.id, domain: p.domain, pillarId: pid, pillarName: p.name });
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
 * Set (or update) the pillar's value metric: its name, one-line description, and
 * how its number is kept — described-only, a governed Cube metric (Metrics tab),
 * or manual monthly entries. Switching to/from manual preserves existing entries.
 */
export async function setValueMetric(
  user: CurrentUser,
  pid: string,
  patch: { name?: string; description?: string; mode?: ValueMode },
): Promise<Pillar> {
  const { map, p } = await requireEditable(user, pid);
  const current: ValueMetric = p.valueMetric ?? emptyValueMetric();
  p.valueMetric = {
    name: patch.name !== undefined ? patch.name.trim() : current.name,
    description: patch.description !== undefined ? patch.description.trim() : current.description,
    mode: patch.mode ?? current.mode,
    entries: current.entries,
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
}
