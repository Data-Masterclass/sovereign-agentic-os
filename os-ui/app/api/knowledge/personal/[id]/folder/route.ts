/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { moveKnowledge, ensureHydrated } from '@/lib/knowledge/personal-store';

export const dynamic = 'force-dynamic';

/**
 * Move a personal knowledge entry into a folder. Runs AS the signed-in user;
 * `moveKnowledge` is edit-scoped (owner, in-domain domain_admin, or admin).
 *
 *   POST /api/knowledge/personal/:id/folder  { folder }  → move the entry
 */
export const POST = withRoute<{ id: string }, { folder?: string }>(async ({ user, params, body }) => {
    const { id } = params;
    if (typeof body.folder !== 'string') {
      return NextResponse.json({ error: 'a folder path is required' }, { status: 400 });
    }
    const entry = moveKnowledge(id, user, body.folder);
    return NextResponse.json({ entry });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });
