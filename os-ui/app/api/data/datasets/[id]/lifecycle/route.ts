/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/experimental/data/server';
import { getDataset, transition, listAllDatasets } from '@/lib/experimental/data/store';
import { stepperStages } from '@/lib/experimental/data/panels';
import { retireDomainTables, sharedFootprintFqns } from '@/lib/experimental/data/physical-delete';
import { dependentsOf } from '@/lib/core/dependents';
import { executeRun } from '@/lib/infra/governed';

export const dynamic = 'force-dynamic';

/**
 * Reverse lifecycle moves (data-architecture-model.md §Reverse), role-gated +
 * lineage-aware in the store: `decertify` (product→asset) is blocked while domains
 * import it; `unshare` (asset→dataset) is blocked while named individuals are granted.
 */
const REVERSE = new Set(['decertify', 'unshare']);

export const POST = withRoute<{ id: string }, { action?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  // Read the PRE-demote dataset (view-scoped) — needed for the default action AND, on an
  // `unshare`, to retire the domain-schema copies + warn dependents with its built layers.
  const before = getDataset(id, user);
  // Bodyless POST (the shared DemoteButton) = "one rung down from wherever it is":
  // product → decertify, asset → unshare. An explicit action still wins; anything
  // else is rejected. The store re-enforces the role + lineage gates either way.
  let action = body.action;
  if (!action) action = before.tier === 'product' ? 'decertify' : 'unshare';
  if (!REVERSE.has(action)) {
    return NextResponse.json({ error: 'action must be decertify or unshare' }, { status: 400 });
  }
  const dataset = transition(id, user, action as 'decertify' | 'unshare');

  // ROOT-CAUSE PREVENTION (zombie-asset fix): an `unshare` moves the dataset OUT of the
  // domain tier — `listGovernedDatasets` (Cube) and the tier-gated `assetTarget` already
  // stop serving it, but the PHYSICAL domain copy lingers as an orphan that a warehouse
  // event + a later re-promote could resurrect as a served table with no data. RETIRE the
  // domain tables now so a demoted dataset can NEVER be read as a served domain asset, and
  // WARN on dependents ([[dataset-lifecycle-cascade]]) so a broken dashboard is not a
  // silent surprise. Best-effort + honestly reported — a drop the engine refuses is an
  // orphan in the report, never a blocked demote. `decertify` (product→asset) stays served.
  let physical: Awaited<ReturnType<typeof retireDomainTables>> | undefined;
  let dependents: Awaited<ReturnType<typeof dependentsOf>> | undefined;
  if (action === 'unshare') {
    // COLLISION SAFETY: never retire a domain table another LIVE dataset still occupies via a
    // name/slug collision — that would orphan the still-served sibling (metadata says served,
    // table gone). Protect the footprint of every OTHER live dataset (`before` is excluded).
    const protectedFqns = sharedFootprintFqns(before, listAllDatasets());
    physical = await retireDomainTables(before, user, executeRun, protectedFqns);
    dependents = await dependentsOf(id).catch(() => []);
  }
  return NextResponse.json({ dataset, stages: stepperStages(dataset), ...(physical ? { physical } : {}), ...(dependents ? { dependents } : {}) });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
