/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { apiError, withRoute } from '@core/kernel/route-server';
import {
  getPersonalKnowledge,
  updatePersonalKnowledge,
  deletePersonalKnowledge,
  archivePersonalKnowledge,
  unarchivePersonalKnowledge,
  ensureHydrated,
} from '@tabs/knowledge/lib/personal-store';

export const dynamic = 'force-dynamic';

/** GET → one personal knowledge entry (view-scoped). */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    return NextResponse.json(getPersonalKnowledge(id, user));
}, { hydrate: ensureHydrated, defaultStatus: 500 });

/** PATCH → edit title and/or markdown body (edit-scoped, versioned). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PATCH = withRoute<{ id: string }, any>(async ({ user, params, body }) => {
    const { id } = params;
    const rec = updatePersonalKnowledge(id, user, {
      title: typeof body.title === 'string' ? body.title : undefined,
      md: typeof body.md === 'string' ? body.md : undefined,
    });
    // A note that is in the search index (one an agent run saved) is re-indexed with its new text.
    try {
      const { hasWorkflowUnits } = await import('@tabs/knowledge/lib/index-store');
      if (hasWorkflowUnits(rec.id)) {
        const { indexNote } = await import('@tabs/knowledge/lib/index-pipeline');
        await indexNote(rec, { userId: user.id, domain: user.domains[0], tab: 'knowledge' });
      }
    } catch { /* the edit stands; the search index catches up on the next save */ }
    return NextResponse.json({ id: rec.id, title: rec.title, updatedAt: rec.updatedAt });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });

/** POST → lifecycle: archive (reversible soft-hide) / unarchive. */
export const POST = withRoute<{ id: string }, { action?: string }>(async ({ user, params, body }) => {
    const { id } = params;
    switch (body.action) {
      case 'archive':
        return NextResponse.json({ entry: archivePersonalKnowledge(id, user) });
      case 'unarchive':
        return NextResponse.json({ entry: unarchivePersonalKnowledge(id, user) });
      default:
        return apiError(400, 'Unknown action', 'knowledge.unknownAction');
    }
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });

/** DELETE → permanently remove a personal entry + its version history (edit-scoped). */
export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    deletePersonalKnowledge(id, user);
    // A deleted note stops being findable by search_knowledge too.
    try {
      const { purgeKnowledgeUnits } = await import('@tabs/knowledge/lib/index-pipeline');
      await purgeKnowledgeUnits(id);
    } catch { /* the delete stands */ }
    return NextResponse.json({ ok: true });
}, { hydrate: ensureHydrated, defaultStatus: 500 });
