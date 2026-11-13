/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal, errorResponse } from '@tabs/data/lib/server';
import { getDataset, requireDatasetEditable, setDatasetSync } from '@tabs/data/lib/store';
import { parseSyncBlock, type DatasetSync } from '@tabs/data/lib/dataset-schema';
import { runtimeTokenOk } from '@tabs/agents/lib/build/runtime-auth';
import { type SyncTrigger } from '@tabs/data/lib/sync-run-server';
import { reconcileSyncSchedule, runSyncNow } from '@tabs/data/lib/dbt/launch';
import { syncStatusFor } from '@tabs/data/lib/sync-status-server';

export const dynamic = 'force-dynamic';

/**
 * SCHEDULED INCREMENTAL SYNC — the per-dataset trigger + history endpoint.
 *
 * POST — run one sync. Two callers, two auths (both governed, no bypass):
 *   • the sync CronJob (`data-sync-<datasetId>`) presents the shared runtime bearer
 *     (same contract as the agents scheduled-run route) → trigger 'schedule'; the
 *     executor resolves the OWNER's live identity (409 when unresolvable) and runs
 *     AS them — never a service principal;
 *   • a signed-in user pressing "Sync now" / "Reset & full re-sync" → edit-gated
 *     (`requireDatasetEditable`), then the SAME owner-identity execution.
 * PUT  — save the sync config (edit-gated; strict validation in `setDatasetSync`),
 *        then reconcile the SCHEDULE: with `DATA_PROJECT_GIT` off the per-dataset CronJob
 *        `data-sync-<datasetId>` (enabled + cron ⇒ upsert, disabled/cleared ⇒ delete),
 *        reporting the cluster outcome HONESTLY (`live:false` when the API server is
 *        unreachable, never a claim); with the flag ON the schedule is declared in the
 *        domain repo's `os/schedules.yml` (committed by this same write) and run by the
 *        Dagster `sovereign` code location — no CronJob, and a pre-B2 one is removed.
 * GET  — sync status + run history for the UI (canView gate), read from DAGSTER with the
 *        flag on and from the OS ledger with it off (`syncStatusFor`).
 *
 * With the flag on, POST launches a DAGSTER run for the dataset's asset selection from the
 * committed head as the dataset owner and writes no `os-sync-runs` row (checklist D9).
 *
 * SKIP (POST): non-standard bearer-OR-user auth at top, not a single gate.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { action?: string };

  let trigger: SyncTrigger;
  let actorId = 'system';
  if (runtimeTokenOk(req.headers.get('authorization'))) {
    trigger = 'schedule';
  } else {
    try {
      const user = await requirePrincipal();
      requireDatasetEditable(id, user); // owner/domain_admin/admin — same gate as any structural edit
      actorId = user.id;
    } catch (e) {
      return errorResponse(e);
    }
    trigger = body.action === 'reset' ? 'reset' : 'manual';
  }

  // DATA_PROJECT_GIT on ⇒ the run is a DAGSTER run launched from the committed head as the owner;
  // the OS writes no ledger row (checklist D9). Off ⇒ the OS executor, unchanged.
  const ran = await runSyncNow(id, trigger, actorId);
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
  // Normalise the browser payload through the tolerant schema parser, then let the
  // store's STRICT gate validate (cron, cursor-for-incremental, merge keys, edit
  // scope). An unparseable-but-present payload falls through to the strict gate so
  // the caller gets the precise 400 instead of a generic one.
  const cleared = body.sync === null || body.sync === undefined;
  const normalised = cleared ? null : (parseSyncBlock(body.sync) ?? (body.sync as DatasetSync));
  const dataset = setDatasetSync(id, user, normalised);
  const cron = await reconcileSyncSchedule(id, dataset.sync ?? null);
  return NextResponse.json({ sync: dataset.sync ?? null, cron });
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
