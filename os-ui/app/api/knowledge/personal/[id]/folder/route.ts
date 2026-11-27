/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { apiError, withRoute } from '@core/kernel/route-server';
import { moveKnowledgeFiled, ensureHydrated } from '@tabs/knowledge/lib/personal-store';
import { folderRowWarning } from '@core/folders/index';

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
      return apiError(400, 'a folder path is required', 'knowledge.folderPathRequired');
    }
    const { record: entry, folderRow } = moveKnowledgeFiled(id, user, body.folder);
    // The move stands; a folder row the registry refused is reported, not hidden.
    const folderWarning = folderRowWarning(folderRow);
    return NextResponse.json({ entry, ...(folderWarning ? { folderWarning } : {}) });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });
