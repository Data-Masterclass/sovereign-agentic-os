/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    The one job queue: pg-boss (MIT, pinned 12.38.2) in its own schema
 * USER STORY: As an operator I want every background job (reconciles, Docling, scans, scheduled
 *             runs) on one durable queue in the database we already back up, not on timers that
 *             die with a pod, and run only by the worker so the web app's latency is not spent on it.
 * ARCHITECTURE:
 *   - `new PgBoss({ connectionString, schema, migrate: false, createSchema: false,
 *     persistQueueStats: false, max, supervise, schedule })` exactly as docs/api/constructor.md
 *     documents it. A RUNTIME instance never runs DDL: `migrate: false` ("when the configured user
 *     account does not have schema mutation privileges"), and no queue-stats partitions. The schema
 *     and every object in it belong to the migration owner, installed only by `installQueueSchema`
 *     (migrate.ts) in the migration Job. `connectionString` is the queue login (DML only, member of
 *     `os_governance_jobs`); the OS's runtime login uses the queue through `send(…, { db })`.
 *     Neither can create a trigger, a function or a table in `pgboss`.
 *   - Queues are `partition: false` (pg-boss's default): a partitioned queue needs DDL and so can
 *     only be created by the migration owner.
 *   - Design 10 F8: queues per reconciler, `singletonKey` coalescing, `send(…, { db })` as the
 *     outbox, `schedule()` with `tz`. Proven in `core/testing/postgres/pgboss.it.ts`.
 *   - WORKER-ONLY WORK: maintenance (`supervise`) and the cron pass (`schedule`) are on only in the
 *     worker process (`@core/kernel/process-role`), and `registerWorker` refuses to call
 *     `boss.work()` anywhere else. The web process may only send.
 *   - CONNECTION BUDGET (pg-0, `max_connections` = 100): pg-boss's own pool is `max` 3 per process
 *     (an outbox send uses the caller's governance client, not this pool), the governance pool is
 *     4 (`pool.ts`). os-ui web + worker: 2 × (3 + 4) = 14, next to agent_runs' 2 × 10 = 20.
 *   - The caller owns `start()` / `stop()` and must listen for `error` (pg-boss's contract).
 */
import { PgBoss, type ConstructorOptions, type WorkHandler, type WorkOptions } from 'pg-boss';
import type pg from 'pg';
import { isRunWorkerProcess } from '@core/kernel/process-role';
import type { ComponentHealth, Fetched } from '@core/adapters/_contract';
import { fetchedOk, pgFailure } from './pool.ts';

export const PGBOSS_SCHEMA = 'pgboss';
export const PGBOSS_POOL_MAX = 3;

/**
 * Thrown when a runtime pg-boss instance is asked to migrate or create its schema. A migrating
 * instance runs pg-boss's async-migration commands (`pgboss.bam`) and DDL; that happens only in
 * the migration Job (`installQueueSchema`, as the owner), never in os-ui (verifier N2).
 */
export class QueueMigrationRefusedError extends Error {
  readonly code = 'queue_migration_refused';
  constructor(option: string) {
    super(`createBoss: ${option} is refused at run time; pg-boss migrates only in the migration Job (installQueueSchema)`);
    this.name = 'QueueMigrationRefusedError';
  }
}

/** Options a runtime instance may set. Schema, connection and the no-DDL flags are fixed here. */
export type RuntimeBossOptions = Pick<ConstructorOptions, 'migrate' | 'createSchema'>;

/** `databaseUrl` is the queue login's URL (DML only on `pgboss`), never the owner's. */
export function createBoss(databaseUrl: string, options: RuntimeBossOptions = {}): PgBoss {
  if (options.migrate === true) throw new QueueMigrationRefusedError('migrate: true');
  if (options.createSchema === true) throw new QueueMigrationRefusedError('createSchema: true');
  const connectionString = databaseUrl.trim();
  if (!connectionString) throw new Error('createBoss: no database URL');
  const worker = isRunWorkerProcess();
  return new PgBoss({
    connectionString,
    schema: PGBOSS_SCHEMA,
    migrate: false,
    createSchema: false,
    persistQueueStats: false,
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

/**
 * pg-boss's `db` interface over a transaction's client (docs/api/constructor.md `db`, 12.38.2):
 * some pg-boss texts hold several statements and `executeSql` must then return EVERY statement's
 * result, as an array, "the way `pg` does". So this returns `pg`'s own result unchanged: one
 * `Result` for one statement, `Result[]` for several. (pg-boss's published `IDatabase` type says
 * `{ rows }` only; the documented contract is the wider one.) Passing it as `send(…, { db })` puts
 * the job insert in the caller's transaction: that is the outbox (10 F8), with no outbox table.
 */
export function bossDb(client: pg.PoolClient): { executeSql(text: string, values?: unknown[]): Promise<{ rows: any[] }> } {
  return {
    executeSql: (text, values) => client.query(text, values as unknown[] | undefined) as unknown as Promise<{ rows: any[] }>,
  };
}

/** The installed pg-boss schema version, as pg-boss's own `version` table states it. */
export async function queueHealth(boss: PgBoss): Promise<Fetched<ComponentHealth>> {
  try {
    const { rows } = await boss.getDb().executeSql(`select version from ${PGBOSS_SCHEMA}.version`);
    if (rows.length !== 1) return { ...pgFailure(new Error(`${PGBOSS_SCHEMA}.version has ${rows.length} rows`)), reason: 'invalid' };
    return fetchedOk({ version: String(rows[0].version), status: 'ready' });
  } catch (err) {
    return pgFailure(err);
  }
}
