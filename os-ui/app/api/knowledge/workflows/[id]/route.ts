/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getWorkflow, updateWorkflow, deleteWorkflow, archiveWorkflow, unarchiveWorkflow, renameKnowledge, ensureHydrated } from '@/lib/knowledge/store';
import { purgeKnowledgeUnits } from '@/lib/knowledge/index-pipeline';
import { findGaps } from '@/lib/knowledge/gaps';
import { resolveEntityIndex } from '@/lib/knowledge/mock-entities';
import { roleAtLeast } from '@/lib/core/session';

export const dynamic = 'force-dynamic';

/** GET → full workflow view (meta + parsed steps). */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const view = getWorkflow(id, user);
    const index = await resolveEntityIndex(view.domain);
    const gaps = findGaps(view.workflow, index);
    return NextResponse.json({
      ...view,
      gaps,
      canEdit: view.owner === user.id || roleAtLeast(user.role, 'builder'),
      canPublish: roleAtLeast(user.role, 'builder'),
    });
}, { defaultStatus: 500 });

/** PATCH → update the raw markdown source (with sha for optimistic concurrency). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PATCH = withRoute<{ id: string }, any>(async ({ user, params, body }) => {
    const { id } = params;
    const md = typeof body.md === 'string' ? body.md : undefined;
    if (!md) return NextResponse.json({ error: 'md is required' }, { status: 400 });
    const rec = updateWorkflow(id, user, { md, sha: body.sha });
    return NextResponse.json({ id: rec.id, title: rec.title, updatedAt: rec.updatedAt });
}, { parse: true, defaultStatus: 500 });

/**
 * POST → workflow lifecycle: `archive` (reversible soft-hide) or `unarchive`.
 * Edit-scoped in the store (owner or same-domain Builder+).
 */
export const POST = withRoute<{ id: string }, { action?: string; title?: string }>(async ({ user, params, body }) => {
    const { id } = params;
    switch (body.action) {
      case 'archive':
        return NextResponse.json({ workflow: archiveWorkflow(id, user) });
      case 'unarchive':
        return NextResponse.json({ workflow: unarchiveWorkflow(id, user) });
      case 'rename': {
        const rec = renameKnowledge(id, user, body.title ?? '');
        return NextResponse.json({ id: rec.id, title: rec.title, updatedAt: rec.updatedAt });
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });

/** DELETE → permanently remove a draft workflow + its version history (edit-scoped). */
export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    deleteWorkflow(id, user); // record + version history (edit-gated)
    // PHYSICAL purge: remove the workflow's indexed vectors from OpenSearch + the
    // offline mirror so a deleted workflow stops being retrievable. Best-effort +
    // honest — the record is already gone; report if the index purge couldn't run.
    const indexPurged = await purgeKnowledgeUnits(id);
    return NextResponse.json({ ok: true, indexPurged });
}, { hydrate: ensureHydrated, defaultStatus: 500 });
