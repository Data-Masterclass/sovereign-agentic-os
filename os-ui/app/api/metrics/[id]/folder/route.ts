/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { ensureHydrated, moveMetric } from '@/lib/metrics/lifecycle';

export const dynamic = 'force-dynamic';

/**
 * Move a metric into a folder. Runs AS the signed-in user; `moveMetric` is edit-scoped
 * (owner or domain admin of the metric's dataset), so a viewer is rejected 403 and
 * nothing is written. A metric has no store row of its own — the folder path rides the
 * metric lifecycle overlay. Mirrors the item-move routes on Files / Data / Knowledge.
 *
 *   POST /api/metrics/:id/folder  { folder }  → move the metric
 */
export const POST = withRoute<{ id: string }, { folder?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.folder !== 'string') {
    return NextResponse.json({ error: 'a folder path is required' }, { status: 400 });
  }
  const metric = moveMetric(id, user, body.folder); // 403 → nothing written
  return NextResponse.json({ metric });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, hydrate: ensureHydrated, parse: true });
