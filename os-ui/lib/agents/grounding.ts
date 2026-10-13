/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { getDataset, ensureHydrated as ensureDataHydrated, type Principal } from '@/lib/experimental/data/store';
import { getWorkflow, ensureHydrated as ensureWorkflowsHydrated } from '@/lib/experimental/knowledge/store';
import { getPersonalKnowledge, ensureHydrated as ensurePersonalHydrated } from '@/lib/experimental/knowledge/personal-store';
import { getMetric } from '@/lib/experimental/metrics/store';
import { getConnectionForUser } from '@/lib/experimental/connections/store';
import { resolveManual } from '@/lib/experimental/knowledge/manual';
import { getPillar } from '@/lib/experimental/strategy/pillars';
import { getBet, ensureHydrated as ensureBetsHydrated } from '@/lib/experimental/bigbets/store';
import {
  manualScopeOfPlanId,
  manualLabel,
  pillarIdOfPlanId,
  bigBetIdOfPlanId,
} from '@/lib/agents/plan-grants';
import type { System } from '@/lib/agents/system-schema';
import type { CurrentUser } from '@/lib/core/auth';
import type { GroundingContext, GroundedResource } from '@/lib/agents/propose-team';

/**
 * GRANTED-CONTEXT NAME RESOLVER for the Agents assistant.
 *
 * The proposer + the Grant-stage assistant must reference ONLY what the SYSTEM WAS
 * GRANTED — never the caller's whole catalog (the just-shipped scoping fix). This module
 * resolves each of the system's OWN grant ids (`system.grants.<kind>`) to its display
 * NAME, through the SAME governed, DLS/RLS-scoped getters the grants picker's feed uses,
 * read AS the acting user — so it can never surface anything the caller could not already
 * see. A grant the caller can no longer view (revoked / archived / moved) is OMITTED, not
 * errored: the grounding degrades honestly.
 *
 * Only the resource NAME (+ id) is resolved — no content — because grounding the proposer
 * needs the roles to name real assets, not read them.
 */

function principalOf(user: CurrentUser): Principal {
  return { id: user.id, domains: user.domains, role: user.role };
}

/** Resolve a list of granted ids to `{ id, name }`, omitting any the caller can't view. */
function resolveNames(ids: string[], resolve: (id: string) => string | null): GroundedResource[] {
  const out: GroundedResource[] = [];
  for (const id of ids) {
    if (!id) continue; // folder grants carry an empty id — no single name to resolve
    try {
      const name = resolve(id);
      if (name) out.push({ id, name });
    } catch {
      // DLS-denied / archived / missing → omit, never fabricate.
    }
  }
  return out;
}

/** Resolve one plan-grant id (`manual:*` / `pillar:*` / `bigbet:*`) to a display name. */
async function resolvePlanName(id: string, user: CurrentUser): Promise<string | null> {
  const manualScope = manualScopeOfPlanId(id);
  if (manualScope) {
    const res = resolveManual(manualScope, user);
    return res.canView ? manualLabel(manualScope) : null;
  }
  const pillarId = pillarIdOfPlanId(id);
  if (pillarId) {
    try {
      const p = await getPillar(user, pillarId);
      return p.name;
    } catch {
      return null;
    }
  }
  const betId = bigBetIdOfPlanId(id);
  if (betId) {
    try {
      const b = getBet(betId, principalOf(user));
      return b.name;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve a system's OWN grants (+ declared outputs + description) into a
 * {@link GroundingContext} of granted NAMES for the proposer / Grant-stage assistant.
 * Read AS `user`; anything not viewable is omitted. The granted TOOL POOL is the system's
 * `grants.tools` verbatim (already role-floor bounded when it was written).
 */
export async function resolveSystemGrounding(system: System, user: CurrentUser): Promise<GroundingContext> {
  const g = system.grants;
  // Hydrate the mock stores the grant getters read from (best-effort).
  await Promise.all([
    ensureDataHydrated().catch(() => {}),
    ensureWorkflowsHydrated().catch(() => {}),
    ensurePersonalHydrated().catch(() => {}),
    ensureBetsHydrated().catch(() => {}),
  ]);
  const p = principalOf(user);

  const data = resolveNames(g.data.map((x) => x.id), (id) => getDataset(id, p).name);
  const knowledge = resolveNames(g.knowledge.map((x) => x.id), (id) => {
    // Knowledge grants may be a workflow (wf_) or a personal-knowledge note (pk_).
    try {
      return id.startsWith('wf') ? getWorkflow(id, p).title : getPersonalKnowledge(id, p).title;
    } catch {
      // Mis-prefixed legacy id — try the other store.
      return id.startsWith('wf') ? getPersonalKnowledge(id, p).title : getWorkflow(id, p).title;
    }
  });
  const metrics = resolveNames(g.metrics.map((x) => x.id), (id) => {
    const m = getMetric(id, p);
    return m.measure.label ?? m.measure.name;
  });

  // Connections use an async, canView-scoped getter — resolve them separately.
  const connections: GroundedResource[] = [];
  for (const c of g.connections) {
    if (!c.id) continue;
    try {
      const conn = await getConnectionForUser(c.id, user);
      connections.push({ id: c.id, name: conn.name });
    } catch {
      /* not viewable → omit */
    }
  }

  // Plan items (Operating Model / Pillars / Big Bets) — resolved by encoded id.
  const plan: GroundedResource[] = [];
  for (const item of g.plan) {
    if (!item.id) continue;
    const name = await resolvePlanName(item.id, user);
    if (name) plan.push({ id: item.id, name });
  }

  const outputs = (system.outputs ?? []).map((o) => ({ kind: o.kind, name: o.name }));

  return {
    description: system.system.description,
    outputs: outputs.length ? outputs : undefined,
    data: data.length ? data : undefined,
    knowledge: knowledge.length ? knowledge : undefined,
    connections: connections.length ? connections : undefined,
    metrics: metrics.length ? metrics : undefined,
    plan: plan.length ? plan : undefined,
    tools: g.tools.length ? g.tools : undefined,
  };
}
