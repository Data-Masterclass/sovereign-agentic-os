/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal, errorResponse } from '@tabs/data/lib/server';
import { getDataset, isDatasetArchived, archiveDataset, unarchiveDataset, deleteDataset, renameDataset, listAllDatasets } from '@tabs/data/lib/store';
import { dropPhysicalTables, sharedFootprintFqns } from '@tabs/data/lib/physical-delete';
import { domainTableMissing } from '@tabs/data/lib/reconcile-server';
import { executeRun } from '@core/infra/governed';
import { stepperStages } from '@tabs/data/lib/panels';
import { goldOutputColumns } from '@tabs/data/lib/metrics';
import { appSlugFromRequest, checkAppGrant } from '@tabs/software/lib/app-origin';

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
  // PROBE-BEFORE-CLAIM (#96): for a PROMOTED dataset, physically probe the domain gold table
  // before the detail view claims it queryable/cube-ready. If the table has drifted away
  // (registry says served, warehouse says gone — the Northpeak zombie), flag it STALE at
  // read time so the UI shows the honest "not materialized — re-materialize to serve" note +
  // the repair action, even when the (previously unreliable) stored flag was never set. Fail-
  // soft: an un-promoted dataset / an unreachable engine never flips it (no false alarm).
  const missing = await domainTableMissing(dataset).catch(() => false);
  const domainTableStale = dataset.domainTableStale || missing;
  return NextResponse.json({
    dataset: { ...dataset, archived, goldColumns: goldOutputColumns(dataset), ...(domainTableStale ? { domainTableStale: true } : {}) },
    stages: stepperStages(dataset),
  });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

/**
 * POST → dataset lifecycle: `archive` (reversible soft-hide) or `unarchive`.
 * Edit-scoped in the store (owner or in-domain Admin), so a mere viewer is
 * rejected 403 — restoring/archiving obeys the same authz as editing.
 *
 * SKIP: dispatches on body.action with a shared gate — left hand-rolled.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal();
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
        return NextResponse.json({ dataset: summary });
      }
      case 'unarchive': {
        const summary = unarchiveDataset(id, principal);
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
  // COLLISION SAFETY: never drop a physical table another LIVE dataset still occupies via a
  // name/slug collision (dropping it would orphan the still-served sibling). Compute the
  // protected footprint from every OTHER live dataset before issuing the drops.
  const protectedFqns = sharedFootprintFqns(dataset, listAllDatasets());
  const physical = await dropPhysicalTables(dataset, user, executeRun, protectedFqns);
  return NextResponse.json({ ok: true, physical });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
