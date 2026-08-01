/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { moveWorkflow, ensureHydrated } from '@/lib/knowledge/store';

export const dynamic = 'force-dynamic';

/**
 * Move a workflow (business process) into a folder. Runs AS the signed-in user;
 * `moveWorkflow` is edit-scoped in the store (owner, in-domain domain_admin, or admin),
 * so a viewer is rejected 403 and nothing is written. The move also upserts an explicit
 * folder row in the governed registry, so the destination folder persists even when empty.
 *
 *   POST /api/knowledge/workflows/:id/folder  { folder }  → move the workflow
 */
export const POST = withRoute<{ id: string }, { folder?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.folder !== 'string') {
    return NextResponse.json({ error: 'a folder path is required' }, { status: 400 });
  }
  const rec = moveWorkflow(id, user, body.folder); // 403 → nothing written
  return NextResponse.json({ workflow: { id: rec.id, title: rec.title, folder: rec.folder, updatedAt: rec.updatedAt } });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });
