/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The scheduled Drive-sync pass the Dagster job `os_files_drive_sync` calls
 * USER STORY: As a drive owner I want my connected drive kept fresh on a schedule by the same governed sync
 *             path my click uses — as me, never as the scheduler — and skipped while it is paused.
 * ARCHITECTURE:
 *   - `route.ts` checks the caller (the Dagster run pod's ServiceAccount, TokenReview) and OPA's
 *     `files_sync_run` decision; this module is what runs after that: `runDueConnectorSyncs`, which
 *     syncs every unpaused source as ITS owner (live owner check + the token of the source's own
 *     connection) and records each run with trigger `schedule`.
 *   - 200 even when a source failed (the body says which); the Dagster op turns any failure into a failed
 *     run, so the failure is visible in Dagster too. 503 (typed) while the sources could not be loaded.
 */
import 'server-only';
import { runDueConnectorSyncs, type SyncEntitlement } from '@tabs/files/lib/connectors-server';
import type { ConnectorSource } from '@tabs/files/lib/connectors';

/** The pass, with the owner's live-principal check and the source's connection token supplied by the caller
 *  (`route.ts` wires `principalById` and `resolveConnectionAccessToken`). */
export async function tickWith(entitlementFor: (source: ConnectorSource) => SyncEntitlement): Promise<Response> {
  try {
    const results = await runDueConnectorSyncs(entitlementFor);
    return Response.json({ trigger: 'schedule', results, failed: results.filter((r) => r.status === 'failed').length });
  } catch (e) {
    const err = e as Error & { code?: string; status?: number };
    return Response.json({ error: err.code ?? 'sync_pass_failed', reason: err.message }, { status: err.status ?? 500 });
  }
}
