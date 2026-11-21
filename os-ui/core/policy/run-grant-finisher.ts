/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    End the activation of every run grant whose Dagster run has finished (WP-15)
 * USER STORY: As a data owner I want Dagster to stop acting as me the moment my run ends, even if
 *             the end-of-run notice from Dagster's sensor never arrives.
 * ARCHITECTURE:
 *   - Reads DAGSTER, never an OS ledger: for each grant with an `active_run_id`, `runOrError` by id;
 *     a SUCCESS / FAILURE / CANCELED run (or one Dagster no longer knows) ends the activation
 *     (`finishRunGrant`, one-shot grants are revoked). The code server's run-status sensors call
 *     /finish too when the chart mounts their token; this is the os-ui side of the same rule.
 *   - `active_until` closes a window in OPA by itself; this only makes it close sooner.
 *   - Web process only, every 15 s, only with `OS_DAGSTER_RUN_GRANTS` on.
 */
import 'server-only';
import type pg from 'pg';
import { config } from '@core/kernel/config';
import { governanceRuntimePool } from '@core/adapters/postgres/pool';
import * as dagster from '@core/infra/dagster';
import { finishRunGrant } from '@core/policy/run-grants';
import { scheduleEvery } from '@core/reconcile/runtime';

const TERMINAL = new Set(['SUCCESS', 'FAILURE', 'CANCELED']);

/** One pass. Returns the grant ids whose activation ended. */
export async function finishTerminalRunGrants(pool: pg.Pool, readRun: typeof dagster.run = dagster.run): Promise<string[]> {
  const active = (await pool.query<{ id: string; active_run_id: string }>(
    `SELECT id, active_run_id FROM os_governance.run_grants WHERE active_run_id IS NOT NULL AND kind IN ('standing', 'dataset')`,
  )).rows;
  const done: string[] = [];
  for (const g of active) {
    const r = await readRun(g.active_run_id);
    const over = r.ok ? TERMINAL.has(r.data.status) : /RunNotFound|not found/i.test(r.error);
    if (over && (await finishRunGrant(pool, g.id, g.active_run_id)) !== null) done.push(g.id);
  }
  return done;
}

/** Every `everyMs` through the one reconcile timer (core/reconcile/runtime.ts). */
export function startRunGrantFinisher(everyMs = 15_000): () => void {
  if (!config.dagsterRunGrants) return () => {};
  return scheduleEvery('run-grant-finisher', everyMs, () => finishTerminalRunGrants(governanceRuntimePool()));
}
