/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal, errorResponse } from '@tabs/data/lib/server';
import { getDataset } from '@tabs/data/lib/store';
import { parseSyncBlock, type DatasetSync } from '@tabs/data/lib/dataset-schema';
import { runtimeTokenOk } from '@tabs/agents/lib/build/runtime-auth';
import { runSyncNow } from '@tabs/data/lib/dbt/launch';
import { saveDatasetSyncService, syncDatasetNowService } from '@tabs/data/lib/mutations-server';
import { syncStatusFor } from '@tabs/data/lib/sync-status-server';

export const dynamic = 'force-dynamic';

/**
 * SCHEDULED INCREMENTAL SYNC — the per-dataset trigger + history endpoint.
 *
 * POST — run one sync. Two callers, two auths (both governed, no bypass):
 *   • a signed-in user pressing "Sync now" / "Reset & full re-sync" → `syncDatasetNowService`,
 *     the SAME function MCP `sync_dataset_now` calls (checklist X8), which carries the edit gate
 *     (`requireDatasetEditable`) and then the owner-identity execution;
 *   • a SERVICE presenting the shared runtime bearer → trigger 'schedule'; the executor resolves
 *     the OWNER's live identity (409 when unresolvable) and runs AS them, never a service
 *     principal. Since B4 no CronJob calls this: Dagster runs the dbt assets instead. The door
 *     stays because it is the contract the planned Kafka/API-batch Dagster asset will use to reach
 *     the OS's governed slice executor (deviation B2-6).
 * PUT  — save the sync config through `saveDatasetSyncService` (per-source mode/cursor locks, then
 *        the store's strict gate: edit scope, cron, cursor-for-incremental, merge keys), then
 *        reconcile the SCHEDULE: the schedule is declared in the domain repo's `os/schedules.yml`
 *        (committed by this same write) and run by the Dagster `sovereign` code location — the OS
 *        provisions NO CronJob and removes a pre-B2 one. With `DATA_PROJECT_GIT` off nothing
 *        schedules the saved config and the outcome says exactly that (B4 deleted the provisioning).
 * GET  — sync status + run history for the UI (canView gate), read from DAGSTER with the
 *        flag on and from the OS ledger with it off (`syncStatusFor`).
 *
 * With the flag on (the default), POST launches a DAGSTER run for the dataset's asset selection
 * from the committed head as the dataset owner and writes no `os-sync-runs` row (checklist D9).
 *
 * SKIP (POST): non-standard bearer-OR-user auth at top, not a single gate.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { action?: string };

  // DATA_PROJECT_GIT on ⇒ the run is a DAGSTER run launched from the committed head as the owner;
  // the OS writes no ledger row (checklist D9). Off ⇒ the OS executor, unchanged. A user-triggered
  // run goes through `syncDatasetNowService` — the SAME function MCP `sync_dataset_now` calls
  // (checklist X8), which carries the edit gate; the CronJob/Dagster bearer path keeps the
  // service-principal trigger, which has no user to gate.
  let ran: Awaited<ReturnType<typeof runSyncNow>>;
  if (runtimeTokenOk(req.headers.get('authorization'))) {
    ran = await runSyncNow(id, 'schedule', 'system');
  } else {
    try {
      const user = await requirePrincipal();
      ran = await syncDatasetNowService(user, id, { reset: body.action === 'reset' });
    } catch (e) {
      return errorResponse(e);
    }
  }
  if (ran.mode === 'dagster') {
    const l = ran.launch;
    if (l.launchError) return NextResponse.json({ error: l.launchError, commit: l.commit, source: 'dagster' }, { status: 502 });
    return NextResponse.json({ source: 'dagster', run: { id: l.dagsterRunId, dagsterRunId: l.dagsterRunId, commit: l.commit, status: 'running', batchId: l.batchId ?? null }, selection: l.selection });
  }
  const outcome = ran.outcome;
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  if (outcome.skipped) return NextResponse.json({ skipped: true, reason: outcome.reason, run: outcome.run ?? null });
  return NextResponse.json({ run: outcome.run });
}

export const PUT = withRoute<{ id: string }, { sync?: unknown }>(async ({ user, params, body }) => {
  const { id } = params;
  // Normalise the browser payload through the tolerant schema parser, then hand it to
  // `saveDatasetSyncService` — the SAME function MCP `set_dataset_sync` calls (checklist X8):
  // it applies the per-source mode/cursor locks at CONFIG time, delegates to the store's
  // STRICT gate (cron, cursor-for-incremental, merge keys, edit scope) and reconciles the
  // schedule. An unparseable-but-present payload falls through to that gate so the caller
  // gets the precise 400 instead of a generic one.
  const cleared = body.sync === null || body.sync === undefined;
  const normalised = cleared ? null : (parseSyncBlock(body.sync) ?? (body.sync as DatasetSync));
  const out = await saveDatasetSyncService(user, id, normalised);
  return NextResponse.json({ sync: out.sync, cron: out.cron });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });

export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const dataset = getDataset(id, user); // canView gate (403/404)
  // The source connection's PLATFORM (kafka ⇒ the panel locks mode/cursor to the
  // offsets kind). Lazy import + best-effort: an unresolvable connection is an
  // honest null, never a 500 on the status read.
  let platform: string | null = null;
  if (dataset.sync) {
    try {
      const [{ getConnectionForUser }, { requireUser }] = await Promise.all([
        import('@tabs/connections/lib/store'),
        import('@core/kernel/auth'),
      ]);
      const c = await getConnectionForUser(dataset.sync.connectionId, await requireUser());
      platform =
        c.template === 'warehouse' && c.warehouse
          ? c.warehouse.platform
          : c.template === 'salesforce-api'
            ? 'salesforce'
            : c.template === 'kajabi-api'
              ? 'kajabi'
              : null;
    } catch {
      platform = null;
    }
  }
  // Run history, quarantine and the next tick come from DAGSTER when the flag is on, and from the
  // OS ledger when it is off — one function, so the route and `get_sync_status` cannot drift.
  const status = await syncStatusFor(dataset);
  return NextResponse.json({ ...status, platform });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
