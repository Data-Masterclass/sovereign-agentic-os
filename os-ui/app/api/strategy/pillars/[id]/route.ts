/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import {
  getPillar,
  updatePillar,
  deletePillar,
  archivePillar,
  unarchivePillar,
  promotePillar,
} from '@/lib/strategy/pillars';
import { rollupForPillar } from '@/lib/strategy/value-rollup';
import { targetsVsActuals } from '@/lib/strategy/snapshots';
import { recentStrategyAudit } from '@/lib/strategy/audit';
import { canEditPillar, canPromotePillar, canDemotePillar, nextPillarScope, prevPillarScope } from '@/lib/strategy';

export const dynamic = 'force-dynamic';

/**
 * Pillar detail — the RLS-scoped value roll-up (as seen by THIS caller), the
 * annual+quarterly target-vs-actual view, the audit feed, and the caller's edit
 * capability. The roll-up's per-bet/component values are masked to the caller's
 * entitled domains; the reconcile flag is computed on the full decomposition.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const pillar = await getPillar(user, id);
  const [rollup, progress] = await Promise.all([
    rollupForPillar(pillar, user),
    targetsVsActuals(pillar),
  ]);
  return NextResponse.json({
    pillar,
    rollup,
    progress,
    audit: recentStrategyAudit(id, 25),
    canEdit: canEditPillar(user, pillar),
    canPromote: canPromotePillar(user, pillar),
    promoteTo: nextPillarScope(pillar.scope),
    canDemote: canDemotePillar(user, pillar),
    demoteTo: prevPillarScope(pillar.scope),
  });
}, { defaultStatus: 500 });

/**
 * POST → pillar lifecycle actions (mirrors the Big Bets [id] route so the shared
 * <LifecycleActions> component drives it identically):
 *   { action: 'archive' | 'unarchive' | 'promote' }
 * Edit-scoped in the store (promote additionally role-gated per tier).
 */
export const POST = withRoute<{ id: string }, { action?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  switch (body.action) {
    case 'archive':
      return NextResponse.json({ item: await archivePillar(user, id) });
    case 'unarchive':
      return NextResponse.json({ item: await unarchivePillar(user, id) });
    case 'promote':
      return NextResponse.json({ item: await promotePillar(user, id) });
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
}, { parse: true, defaultStatus: 500 });

/** Edit a pillar's name/description/metric links (Builder domain / Admin tenant). */
export const PATCH = withRoute<{ id: string }, Record<string, unknown>>(async ({ user, params, body }) => {
  const { id } = params;
  const item = await updatePillar(user, id, {
    name: body?.name !== undefined ? String(body.name) : undefined,
    description: body?.description !== undefined ? String(body.description) : undefined,
    metrics: Array.isArray(body?.metrics) ? body.metrics : undefined,
  });
  return NextResponse.json({ item });
}, { parse: true, defaultStatus: 500 });

export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  await deletePillar(user, id);
  return NextResponse.json({ ok: true });
}, { defaultStatus: 500 });
