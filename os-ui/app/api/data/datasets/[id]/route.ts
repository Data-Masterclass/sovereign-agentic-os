/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset, archiveDataset, unarchiveDataset, deleteDataset } from '@/lib/data/store';
import { dropPhysicalTables } from '@/lib/data/physical-delete';
import { executeRun } from '@/lib/governed';
import { stepperStages } from '@/lib/data/panels';

export const dynamic = 'force-dynamic';

/** One logical dataset, opened as its Bronze→Silver→Gold stepper. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const dataset = getDataset(id, user);
    return NextResponse.json({ dataset, stages: stepperStages(dataset) });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST → dataset lifecycle: `archive` (reversible soft-hide) or `unarchive`.
 * Edit-scoped in the store (owner or in-domain Admin), so a mere viewer is
 * rejected 403 — restoring/archiving obeys the same authz as editing.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    switch (body.action) {
      case 'archive':
        return NextResponse.json({ dataset: archiveDataset(id, user) });
      case 'unarchive':
        return NextResponse.json({ dataset: unarchiveDataset(id, user) });
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * DELETE → permanently remove a dataset (edit-scoped; confirmed in the UI) —
 * registry record AND its physical Iceberg tables. The record delete runs first
 * (it re-checks canEdit + the import guard, so nothing is dropped for a caller
 * who couldn't delete); the governed `DROP TABLE IF EXISTS` drops then run
 * best-effort AS the caller. A table the engine couldn't drop is reported as
 * `physical.orphaned` — the delete stands, the leftover is never silent.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const dataset = deleteDataset(id, user); // throws 403/409 → nothing is dropped
    const physical = await dropPhysicalTables(dataset, user, executeRun);
    return NextResponse.json({ ok: true, physical });
  } catch (e) {
    return errorResponse(e);
  }
}
