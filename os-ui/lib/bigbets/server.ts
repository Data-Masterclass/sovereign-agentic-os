/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { authorize } from '@/lib/governed';
import { config } from '@/lib/config';
// Type-only ON PURPOSE: a value-import of lib/auth would drag next/headers into
// every consumer (and break the node --test runner). Nothing here needs it at runtime.
import type { CurrentUser } from '@/lib/auth';
import {
  type Actor,
  type BigBet,
  type Principal,
} from './model.ts';
import { type PlannerHooks } from './planner.ts';
import { canViewComponentDetail, getBet, auditLog } from './store.ts';
import { deriveBet, completion, type ComponentStatus } from './status.ts';
import { rollup } from './roadmap.ts';
import { buildComposition } from './composition.ts';
import { realizedValue, distribute } from './value.ts';
import { resolveArtifact, getPillar, getMetric, sourceMode, READY_VERB } from './sources.ts';
import { listPillars as listStrategyPillars } from '@/lib/strategy/pillars';

/**
 * The server boundary for Big Bets: turns the authenticated CurrentUser into a
 * Principal/Actor, composes the full "bet view" the UI renders (derived status +
 * roadmap + value + composition, RLS-redacted), and wires the planner's OPA +
 * Langfuse hooks to the live decision API + ingestion endpoint (best-effort).
 */

export function principal(user: CurrentUser): Principal {
  return { id: user.id, domains: user.domains, role: user.role };
}
export function actor(user: CurrentUser): Actor {
  return { ...principal(user), kind: 'human' };
}

/** Best-effort Langfuse trace of a planner scaffolding step (never throws). */
async function tracePlanner(event: { step: string; tab: string; mode: string; principal: string }): Promise<void> {
  try {
    const id = `os-bigbet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const auth = 'Basic ' + Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    await fetch(`${config.langfuseUrl}/api/public/ingestion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      signal: ctrl.signal,
      cache: 'no-store',
      body: JSON.stringify({
        batch: [{
          id, type: 'trace-create', timestamp: new Date().toISOString(),
          body: { id, name: `bigbet.planner.scaffold`, input: event, tags: ['big-bets', `tab:${event.tab}`, `mode:${event.mode}`] },
        }],
      }),
    }).catch(() => {});
    clearTimeout(t);
  } catch {
    /* tracing is best-effort */
  }
}

/** Planner hooks for a request: OPA-gated (fail-open + marked when OPA is off) + Langfuse-traced. */
export function plannerHooks(): PlannerHooks {
  return {
    authorize: async (p, action) => (await authorize(p, action)).allowed,
    trace: tracePlanner,
  };
}

export type ComponentView = {
  ref: BigBet['components'][number];
  status: ComponentStatus;
  /** Redacted to nulls for a user who may not see a not-yet-shared component. */
  artifact: { id: string; tab: string; title: string; lifecycle: string; visibility: string; omFqn?: string; readyVerb: string } | null;
  visible: boolean;
};

export type BetView = {
  bet: BigBet;
  pillar: { id: string; name: string } | null;
  metric: { id: string; name: string } | null;
  components: ComponentView[];
  completion: { done: number; total: number; pct: number };
  roadmap: ReturnType<typeof rollup>;
  value: {
    realized: ReturnType<typeof realizedValue>;
    distribution: ReturnType<typeof distribute>;
  };
  composition: ReturnType<typeof buildComposition>;
  sourceMode: 'live' | 'mock';
  audit: ReturnType<typeof auditLog>;
  canEdit: boolean;
};

/**
 * Compose the full bet view for a viewer. `basis`/`allocation` override the bet's
 * stored knobs so the UI can preview "what if uplift→absolute / manual→usage".
 *
 * Async so it can look up the pillar name from the real strategy store (avoids
 * the globalThis-timing issue where the cache may not yet be warm).
 */
export async function buildBetView(
  betId: string,
  user: CurrentUser,
  opts: { basis?: BigBet['valueBasis']; allocation?: BigBet['allocation']; today?: string } = {},
): Promise<BetView> {
  const p = principal(user);
  const bet = getBet(betId, p);
  const effective: BigBet = {
    ...bet,
    valueBasis: opts.basis ?? bet.valueBasis,
    allocation: opts.allocation ?? bet.allocation,
  };

  const statuses = deriveBet(bet.components);
  const statusByRef = new Map(statuses.map((s) => [s.refId, s]));

  const components: ComponentView[] = bet.components.map((ref) => {
    const visible = canViewComponentDetail(bet, ref, p);
    const art = resolveArtifact(ref.artifactId);
    return {
      ref,
      status: statusByRef.get(ref.id)!,
      visible,
      artifact:
        visible && art
          ? {
              id: art.id,
              tab: art.tab,
              title: art.title,
              lifecycle: art.lifecycle,
              visibility: art.visibility,
              omFqn: art.omFqn,
              readyVerb: READY_VERB[art.tab],
            }
          : null,
    };
  });

  const road = rollup(bet.components, statuses, bet.goLive, opts.today);
  const composition = buildComposition(bet.components.map((c) => c.artifactId));
  const realized = realizedValue(effective, user.id);
  const refs = bet.components.map((c) => ({ refId: c.id, artifactId: c.artifactId }));
  const weights = new Map(bet.components.map((c) => [c.id, c.weight]));
  const distribution = distribute(realized.realized, refs, weights, effective.allocation, composition);

  // Resolve pillar from the real strategy store (async, avoids phantom gap);
  // fall back to sources.ts adapter for unit-test / warm-cache path.
  const strategyPillars = await listStrategyPillars(user).catch(() => null);
  const stratPillar = strategyPillars?.find((p) => p.id === bet.pillarId) ?? null;
  const pillar = stratPillar ?? getPillar(bet.pillarId);
  const metric = getMetric(bet.metricId);

  return {
    bet,
    pillar: pillar ? { id: pillar.id, name: pillar.name } : null,
    metric: metric ? { id: metric.id, name: metric.name } : null,
    components,
    completion: completion(statuses),
    roadmap: road,
    value: { realized, distribution },
    composition,
    sourceMode: sourceMode(),
    audit: auditLog(betId).slice(0, 50),
    canEdit: canEditFor(bet, p),
  };
}

function canEditFor(bet: BigBet, p: Principal): boolean {
  if (p.role === 'admin') return true;
  if (bet.crossDomain) return false;
  return bet.owner === p.id && (p.role === 'builder' || p.role === 'creator');
}
