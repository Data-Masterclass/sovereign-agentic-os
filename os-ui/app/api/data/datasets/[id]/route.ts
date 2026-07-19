/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { requireUser } from '@/lib/core/auth';
import { getDataset, isDatasetArchived, archiveDataset, unarchiveDataset, deleteDataset } from '@/lib/data/store';
import { dropPhysicalTables } from '@/lib/data/physical-delete';
import { executeRun } from '@/lib/infra/governed';
import { stepperStages } from '@/lib/data/panels';
import { firstOmCatalogFor, omSoftDeleteForConnection, omReactivateForConnection } from '@/lib/connections/openmetadata';

export const dynamic = 'force-dynamic';

/** One logical dataset, opened as its Bronze→Silver→Gold stepper. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const dataset = getDataset(id, user);
    // `archived` is a record-level flag (not in the yaml-derived Dataset), so fold it
    // in here — the detail view needs it to offer Restore instead of Archive.
    const archived = isDatasetArchived(id, user);
    return NextResponse.json({ dataset: { ...dataset, archived }, stages: stepperStages(dataset) });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST → dataset lifecycle: `archive` (reversible soft-hide) or `unarchive`.
 * Edit-scoped in the store (owner or in-domain Admin), so a mere viewer is
 * rejected 403 — restoring/archiving obeys the same authz as editing.
 *
 * Best-effort OM soft-delete / reactivation fires AFTER the OS archive succeeds.
 * An unreachable OM or an untested OM version is silently swallowed — the OS
 * archive/restore is authoritative and NEVER blocked by an OM error.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    // requireUser for OM connection lookup (needs CurrentUser); requirePrincipal for
    // the store (needs Principal). Both share the same session; the cost is negligible.
    const [user, principal] = await Promise.all([requireUser(), requirePrincipal()]);
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    switch (body.action) {
      case 'archive': {
        const summary = archiveDataset(id, principal);
        // Best-effort OM soft-delete — fire-and-forget; the archive already succeeded.
        void firstOmCatalogFor(user).then((c) => {
          if (c) void omSoftDeleteForConnection(c, summary);
        });
        return NextResponse.json({ dataset: summary });
      }
      case 'unarchive': {
        const summary = unarchiveDataset(id, principal);
        // Best-effort OM reactivation.
        void firstOmCatalogFor(user).then((c) => {
          if (c) void omReactivateForConnection(c, summary);
        });
        return NextResponse.json({ dataset: summary });
      }
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
