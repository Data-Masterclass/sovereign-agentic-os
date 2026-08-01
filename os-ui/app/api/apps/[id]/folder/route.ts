/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { moveApp } from '@/lib/software/apps';

export const dynamic = 'force-dynamic';

/**
 * Move a software app into a folder. Runs AS the signed-in user; `moveApp` is
 * edit-scoped in the store (owner, in-domain domain_admin, or admin), so a viewer
 * is rejected 403 and nothing is written. The move also upserts an explicit folder
 * row in the governed registry, so the destination folder persists even when empty.
 * The Software rail's single- and multi-select "Move to folder…" both hit this route.
 * Mirrors /api/data/datasets/:id/folder (parity rollout).
 *
 *   POST /api/apps/:id/folder  { folder }  → move the app
 */
export const POST = withRoute<{ id: string }, { folder?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.folder !== 'string') {
    return NextResponse.json({ error: 'a folder path is required' }, { status: 400 });
  }
  const app = await moveApp(id, user, body.folder); // 403 → nothing written
  return NextResponse.json({ app });
}, { parse: true, defaultStatus: 500 });
