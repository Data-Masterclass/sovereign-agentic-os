/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { requireUser } from '@/lib/core/auth';
import { getDataset, isDatasetArchived, archiveDataset, unarchiveDataset, deleteDataset, renameDataset } from '@/lib/data/store';
import { dropPhysicalTables } from '@/lib/data/physical-delete';
import { executeRun } from '@/lib/infra/governed';
import { stepperStages } from '@/lib/data/panels';
import { goldOutputColumns } from '@/lib/data/metrics';
import { firstOmCatalogFor, omSoftDeleteForConnection, omReactivateForConnection } from '@/lib/connections/openmetadata';
import { appSlugFromRequest, checkAppGrant } from '@/lib/software/app-origin';

export const dynamic = 'force-dynamic';

/** One logical dataset, opened as its Bronze→Silver→Gold stepper. */
export const GET = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const { id } = params;
  // LEAST-PRIVILEGE for app origins: a deployed app may only read a dataset it was
  // granted, even though the user's own session could see more. Non-app requests
  // (the OS UI) skip this entirely (appSlugFromRequest returns null, no I/O).
  const slug = appSlugFromRequest(req);
  if (slug) {
    const check = await checkAppGrant(slug, 'data', id);
    if (!check.allowed) return NextResponse.json({ error: check.reason }, { status: 403 });
  }
  const dataset = getDataset(id, user);
  // `archived` is a record-level flag (not in the yaml-derived Dataset), so fold it
  // in here — the detail view needs it to offer Restore instead of Archive.
  // `goldColumns` = the ACTUAL columns of the built gold table (join output names),
  // which differ from `columns` (base docs) after a Gold join — the metric builder
  // and any gold-mart consumer must read these.
  const archived = isDatasetArchived(id, user);
  return NextResponse.json({
    dataset: { ...dataset, archived, goldColumns: goldOutputColumns(dataset) },
    stages: stepperStages(dataset),
  });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

/**
 * POST → dataset lifecycle: `archive` (reversible soft-hide) or `unarchive`.
 * Edit-scoped in the store (owner or in-domain Admin), so a mere viewer is
 * rejected 403 — restoring/archiving obeys the same authz as editing.
 *
 * Best-effort OM soft-delete / reactivation fires AFTER the OS archive succeeds.
 * An unreachable OM or an untested OM version is silently swallowed — the OS
 * archive/restore is authoritative and NEVER blocked by an OM error.
 *
 * SKIP: uses Promise.all([requireUser(), requirePrincipal()]) — two parallel gates.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    // requireUser for OM connection lookup (needs CurrentUser); requirePrincipal for
    // the store (needs Principal). Both share the same session; the cost is negligible.
    const [user, principal] = await Promise.all([requireUser(), requirePrincipal()]);
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { action?: string; name?: string };
    switch (body.action) {
      case 'rename': {
        // Display-name change only — the physical slug is frozen in the store, so no
        // Iceberg/Cube/dbt table ever moves. Edit-scoped (owner or in-domain admin).
        const dataset = renameDataset(id, principal, body.name ?? '');
        return NextResponse.json({ dataset: { ...dataset, archived: isDatasetArchived(id, principal) }, stages: stepperStages(dataset) });
      }
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
export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const dataset = deleteDataset(id, user); // throws 403/409 → nothing is dropped
  const physical = await dropPhysicalTables(dataset, user, executeRun);
  return NextResponse.json({ ok: true, physical });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
