/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { movePillar } from '@/lib/strategy/pillars';

export const dynamic = 'force-dynamic';

/**
 * Move a pillar into a folder. Runs AS the signed-in user; `movePillar` is edit-scoped
 * in the store (`canEditPillar` — owner, in-domain Builder+/domain_admin, or admin), so
 * a viewer is rejected 403 and nothing is written. The move also upserts an explicit
 * folder row in the governed registry, so the destination folder persists even when
 * empty. Mirrors `/api/data/datasets/:id/folder`.
 *
 *   POST /api/strategy/pillars/:id/folder  { folder }  → move the pillar
 */
export const POST = withRoute<{ id: string }, { folder?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.folder !== 'string') {
    return NextResponse.json({ error: 'a folder path is required' }, { status: 400 });
  }
  const item = await movePillar(user, id, body.folder); // 403 → nothing written
  return NextResponse.json({ item });
}, { parse: true, defaultStatus: 500 });
