/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The latest run of a system for the signed-in user, from this process's run store
 * USER STORY: As a builder I open a system and see my latest run of it, whichever process ran it.
 * ARCHITECTURE:
 *   - The server wiring of `latest-run.ts`: the process's run store (Postgres when configured, so
 *     os-ui reads what `os-ui-worker` wrote) and a FAIL-SOFT read — an unreachable store falls
 *     back to the system record's `lastRun` (marked `source: 'system-record'`) and logs why, so
 *     opening a system never fails because the run database is down.
 *   - `server-only`: it touches the run store. The decision it applies is pure and tested.
 */
import 'server-only';
import type { LastRun } from '@tabs/agents/lib/store';
import { pickLatestRun, readLatestRun, type LatestRunView } from '@tabs/agents/lib/build/latest-run';

export async function latestRunView(systemId: string, userId: string, recordLastRun: LastRun | null | undefined): Promise<LatestRunView> {
  try {
    const { runJobStore } = await import('@tabs/agents/lib/build/run-jobs-server');
    return pickLatestRun(recordLastRun, await readLatestRun(await runJobStore(), systemId, userId));
  } catch (e) {
    console.warn(`[agent-runs] latest run of ${systemId} could not be read from the run store: ${(e as Error)?.message ?? String(e)}`);
    return pickLatestRun(recordLastRun, null);
  }
}
