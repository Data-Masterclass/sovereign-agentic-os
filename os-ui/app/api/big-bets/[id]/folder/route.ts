/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { principal } from '@/lib/bigbets/server';
import { moveBet, ensureHydrated } from '@/lib/bigbets/store';

export const dynamic = 'force-dynamic';

/**
 * Move a Big Bet into a folder. Runs AS the signed-in user; `moveBet` is edit-scoped
 * in the store (owner, in-domain domain_admin, or admin), so a viewer is rejected 403
 * and nothing is written. The move also upserts an explicit folder row in the governed
 * registry, so the destination folder persists even when empty. Mirrors the Data tab's
 * `/api/data/datasets/:id/folder`.
 *
 *   POST /api/big-bets/:id/folder  { folder }  → move the bet
 */
export const POST = withRoute<{ id: string }, { folder?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.folder !== 'string') {
    return NextResponse.json({ error: 'a folder path is required' }, { status: 400 });
  }
  const bet = moveBet(id, principal(user), body.folder); // 403 → nothing written
  return NextResponse.json({ bet });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });
