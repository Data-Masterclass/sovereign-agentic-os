/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset, requireDatasetEditable, setDatasetSync } from '@/lib/data/store';
import { parseSyncBlock, type DatasetSync } from '@/lib/data/dataset-schema';
import { runtimeTokenOk } from '@/lib/agents/build/runtime-auth';
import { runDatasetSync, type SyncTrigger } from '@/lib/data/sync-run-server';
import { reconcileSyncCron } from '@/lib/data/sync-cron';
import {
  consecutiveErrorCount,
  currentWatermark,
  ensureSyncRunsHydrated,
  isQuarantined,
  lastMaintenanceAt,
  listSyncRuns,
} from '@/lib/data/sync-runs';

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
 *        then reconcile the per-dataset CronJob `data-sync-<datasetId>` — enabled +
 *        cron ⇒ upsert, disabled/cleared ⇒ delete — reporting the cluster outcome
 *        HONESTLY (`live:false` when the API server is unreachable, never a claim).
 * GET  — sync status + run history for the UI (canView gate).
 *
 * SKIP (POST): non-standard bearer-OR-user auth at top, not a single gate.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { action?: string };

  let trigger: SyncTrigger;
  if (runtimeTokenOk(req.headers.get('authorization'))) {
    trigger = 'schedule';
  } else {
    try {
      const user = await requirePrincipal();
      requireDatasetEditable(id, user); // owner/domain_admin/admin — same gate as any structural edit
    } catch (e) {
      return errorResponse(e);
    }
    trigger = body.action === 'reset' ? 'reset' : 'manual';
  }

  const outcome = await runDatasetSync(id, trigger);
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
  const cron = await reconcileSyncCron(id, dataset.sync ?? null);
  return NextResponse.json({ sync: dataset.sync ?? null, cron });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });

export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const dataset = getDataset(id, user); // canView gate (403/404)
  await ensureSyncRunsHydrated().catch(() => {});
  // The source connection's PLATFORM (kafka ⇒ the panel locks mode/cursor to the
  // offsets kind). Lazy import + best-effort: an unresolvable connection is an
  // honest null, never a 500 on the status read.
  let platform: string | null = null;
  if (dataset.sync) {
    try {
      const [{ getConnectionForUser }, { requireUser }] = await Promise.all([
        import('@/lib/connections/store'),
        import('@/lib/core/auth'),
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
  return NextResponse.json({
    sync: dataset.sync ?? null,
    platform,
    runs: listSyncRuns(id).slice(-20).reverse(), // newest first for the history strip
    watermark: currentWatermark(id),
    quarantined: isQuarantined(id),
    consecutiveErrors: consecutiveErrorCount(id),
    lastMaintenanceAt: lastMaintenanceAt(id),
  });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
