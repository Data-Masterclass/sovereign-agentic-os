/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    The one job queue: pg-boss (MIT, pinned 12.38.2) in its own schema
 * USER STORY: As an operator I want every background job (reconciles, Docling, scans, scheduled
 *             runs) on one durable queue in the database we already back up, not on timers that
 *             die with a pod, and run only by the worker so the web app's latency is not spent on it.
 * ARCHITECTURE:
 *   - `new PgBoss({ connectionString, schema, createSchema: false, max, supervise, schedule })`
 *     exactly as docs/api/constructor.md documents it. `connectionString` is the QUEUE login, which
 *     owns the `pgboss` schema (created for it by the chart bootstrap, `files/os-governance/
 *     schemas.sql`); pg-boss installs and migrates its own objects there at `start()`. The OS's
 *     runtime login only uses the queue (DML through `send(…, { db })`), never owns it.
 *   - Design 10 F8: queues per reconciler, `singletonKey` coalescing, `send(…, { db })` as the
 *     outbox, `schedule()` with `tz`. Proven in `pgboss.it.ts`.
 *   - WORKER-ONLY WORK: maintenance (`supervise`) and the cron pass (`schedule`) are on only in the
 *     worker process (`@core/kernel/process-role`), and `registerWorker` refuses to call
 *     `boss.work()` anywhere else. The web process may only send.
 *   - CONNECTION BUDGET (pg-0, `max_connections` = 100): pg-boss's own pool is `max` 3 per process
 *     (an outbox send uses the caller's governance client, not this pool), the governance pool is
 *     4 (`pool.ts`). os-ui web + worker: 2 × (3 + 4) = 14, next to agent_runs' 2 × 10 = 20.
 *   - The caller owns `start()` / `stop()` and must listen for `error` (pg-boss's contract).
 */
import { PgBoss, type WorkHandler, type WorkOptions } from 'pg-boss';
import { isRunWorkerProcess } from '@core/kernel/process-role';

export const PGBOSS_SCHEMA = 'pgboss';
export const PGBOSS_POOL_MAX = 3;

/** `databaseUrl` is the queue login's URL (the owner of schema `pgboss`), not the runtime's. */
export function createBoss(databaseUrl: string): PgBoss {
  const connectionString = databaseUrl.trim();
  if (!connectionString) throw new Error('createBoss: no database URL');
  const worker = isRunWorkerProcess();
  return new PgBoss({
    connectionString,
    schema: PGBOSS_SCHEMA,
    createSchema: false,
    max: PGBOSS_POOL_MAX,
    supervise: worker,
    schedule: worker,
  });
}

/** `boss.work()`, but only in the worker process. Anywhere else it throws. */
export async function registerWorker<T>(
  boss: PgBoss,
  name: string,
  options: WorkOptions,
  handler: WorkHandler<T>,
): Promise<string> {
  if (!isRunWorkerProcess()) {
    throw new Error(`registerWorker(${name}): pg-boss workers run only in os-ui-worker, not in the web process`);
  }
  return boss.work<T>(name, options, handler);
}
