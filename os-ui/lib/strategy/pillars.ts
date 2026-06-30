/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import type { CurrentUser } from '@/lib/auth';
import {
  type Pillar,
  type PillarScope,
  type MetricLink,
  type TargetSet,
  canCreatePillar,
  canEditPillar,
  canViewPillar,
} from '@/lib/strategy/model';
import { auditStrategy } from '@/lib/strategy/audit';
import {
  linkBetStub,
  unlinkBetStub,
  STUB_BET_CATALOGUE,
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
 */

let cache: Map<string, Pillar> | null = null;
let osHealthy = false;

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

const INDEX = 'os-strategy-pillars';

async function osFetch(path: string, init?: RequestInit): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    return await fetch(`${config.opensearchUrl}${path}`, {
      ...init,
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function writeThrough(p: Pillar): void {
  if (!osHealthy) return;
  void osFetch(`/${INDEX}/_doc/${p.id}?refresh=true`, { method: 'PUT', body: JSON.stringify(p) });
}
function deleteThrough(pid: string): void {
  if (!osHealthy) return;
  void osFetch(`/${INDEX}/_doc/${pid}?refresh=true`, { method: 'DELETE' });
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

function seed(): Pillar[] {
  const t = now();
  return [
    {
      id: 'seed_pillar_retention',
      name: 'Retention',
      description:
        'Keep more of the revenue we win: reduce churn and win lapsed customers back, ' +
        'so net revenue retention climbs across the company.',
      scope: 'tenant',
      domain: 'tenant',
      owner: 'admin',
      metrics: [NRR_METRIC],
      betIds: ['seed_bet_reduce_churn', 'seed_bet_winback'],
      targets: undefined,
      createdAt: t,
      updatedAt: t,
    },
  ];
}

async function getCache(): Promise<Map<string, Pillar>> {
  if (cache) return cache;
  const map = new Map<string, Pillar>();
  const ping = await osFetch(`/${INDEX}/_count`);
  if (ping && ping.ok) {
    osHealthy = true;
    const res = await osFetch(`/${INDEX}/_search?size=1000`, {
      method: 'POST',
      body: JSON.stringify({ query: { match_all: {} } }),
    });
    if (res && res.ok) {
      const data = (await res.json()) as { hits?: { hits?: { _source: Pillar }[] } };
      for (const h of data?.hits?.hits ?? []) map.set(h._source.id, h._source);
    }
    if (map.size === 0) for (const p of seed()) { map.set(p.id, p); writeThrough(p); }
  } else {
    osHealthy = false;
    for (const p of seed()) map.set(p.id, p);
  }
  cache = map;
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
 * Link a Big Bet to a pillar. The bet reference is stored on the pillar; the
 * bet's value distribution is registered with the bets-bridge stub (the seam the
 * real Big Bets registry will replace). Re-normalises shares so they reconcile.
 */
export async function linkBet(user: CurrentUser, pid: string, betId: string): Promise<Pillar> {
  const { map, p } = await requireEditable(user, pid);
  const bet: BetShare | undefined = STUB_BET_CATALOGUE.find((b) => b.id === betId);
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
  cache = null;
  osHealthy = false;
}
