/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { listPillars, createPillar } from '@/lib/strategy/pillars';
import { rollupForPillar, valueHistory } from '@/lib/strategy/value-rollup';
import { snapshotHistory, ensureHydrated } from '@/lib/strategy/snapshots';
import { recentStrategyAudit } from '@/lib/strategy/audit';
import { canCreatePillar, canEditPillar, canPromotePillar, canDemotePillar, nextPillarScope, prevPillarScope, type PillarScope } from '@/lib/strategy';
import { getSettings } from '@/lib/platform-admin/settings';

export const dynamic = 'force-dynamic';

/**
 * RLS-scoped pillar list: tenant pillars + the caller's domain pillars. Each
 * pillar is returned as a CARD enriched with its RLS-scoped value roll-up (total
 * + bets + components, masked to the caller's entitled domains) and its value
 * history, so the pillars-centric page renders everything from one fetch.
 */
export const GET = withRoute(async ({ user, req }) => {
  // Archived pillars are hidden by default; the UI opts them in via ?archived=1.
  const includeArchived = new URL(req.url).searchParams.get('archived') === '1';
  const pillars = await listPillars(user, { includeArchived });
  const items = await Promise.all(
    pillars.map(async (pillar) => {
      const rollup = await rollupForPillar(pillar, user);
      return {
        pillar,
        rollup,
        history: valueHistory(pillar, snapshotHistory(pillar.id)),
        audit: recentStrategyAudit(pillar.id, 6),
        canEdit: canEditPillar(user, pillar),
        canPromote: canPromotePillar(user, pillar),
        promoteTo: nextPillarScope(pillar.scope),
        canDemote: canDemotePillar(user, pillar),
        demoteTo: prevPillarScope(pillar.scope),
      };
    }),
  );
  return NextResponse.json({
    user,
    items,
    // The tenant currency (set in Admin) the card uses to format monetary metrics.
    currency: getSettings().currency,
    // Surface what the caller may create per tier so the UI can gate the buttons.
    canCreatePersonal: user.domains.some((d) => canCreatePillar(user, 'personal', d)),
    canCreateTenant: canCreatePillar(user, 'tenant', 'tenant'),
    canCreateDomain: user.domains.some((d) => canCreatePillar(user, 'domain', d)),
  });
}, { hydrate: ensureHydrated, defaultStatus: 500 });

/** Define a pillar (tenant = Admin; domain = Builder/Admin in that domain). */
export const POST = withRoute<Record<string, string>, Record<string, unknown>>(async ({ user, body }) => {
  const scope = (
    body?.scope === 'tenant' ? 'tenant' : body?.scope === 'personal' ? 'personal' : 'domain'
  ) as PillarScope;
  const vm = body?.valueMetric as { name?: unknown; description?: unknown } | undefined;
  const item = await createPillar(user, {
    name: String(body?.name ?? ''),
    description: body?.description ? String(body.description) : '',
    scope,
    domain: body?.domain ? String(body.domain) : undefined,
    metrics: Array.isArray(body?.metrics) ? body.metrics : [],
    valueMetric: vm && (vm.name || vm.description)
      ? { name: String(vm.name ?? ''), description: String(vm.description ?? '') }
      : undefined,
  });
  return NextResponse.json({ item }, { status: 201 });
}, { parse: true, defaultStatus: 500 });
