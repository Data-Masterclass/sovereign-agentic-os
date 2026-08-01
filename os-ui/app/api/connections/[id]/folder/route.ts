/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getConnectionForUser, moveConnection } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * Move a connection into a folder. Runs AS the signed-in user; `moveConnection` is
 * edit-scoped in the store (owner, in-domain domain_admin, or admin), so a viewer is
 * rejected 403 and nothing is written. The move also upserts an explicit folder row in
 * the governed registry, so the destination folder persists even when empty. Mirrors
 * `/api/data/datasets/:id/folder`. Purely organisational — the FROZEN physical identity
 * (principal / Trino catalog / K8s secret) is never touched.
 *
 * `moveConnection` is SYNC and reads the in-process cache, so we first
 * `getConnectionForUser` (async) to warm the cache + apply the 404/view gate, then move.
 *
 *   POST /api/connections/:id/folder  { folder }  → move the connection
 */
export const POST = withRoute<{ id: string }, { folder?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.folder !== 'string') {
    return NextResponse.json({ error: 'a folder path is required' }, { status: 400 });
  }
  await getConnectionForUser(id, user); // warm cache + 404/view gate
  const connection = moveConnection(id, user, body.folder); // 403 → nothing written
  return NextResponse.json({ connection });
}, { parse: true, defaultStatus: 500 });
