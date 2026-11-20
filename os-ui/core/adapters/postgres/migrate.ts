/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    Run the `os_governance` migrations with node-pg-migrate (MIT, pinned 9.0.0)
 * USER STORY: As an operator I want the governance schema installed and upgraded by a standard,
 *             documented migration tool that I can also run by hand, not by custom OS code.
 * ARCHITECTURE:
 *   - A thin call to node-pg-migrate's documented programmatic `runner()`
 *     (https://github.com/salsita/node-pg-migrate/blob/v9.0.0/docs/src/api.md). The OS has no
 *     migration runner of its own; this file only fixes the options so every caller (boot, a Job,
 *     the tests) applies the same files the same way.
 *   - Migrations are plain SQL in `./migrations/` (node-pg-migrate's default SQL format:
 *     `-- Up Migration` / `-- Down Migration`). The identical CLI command is in
 *     `components/node-pg-migrate/UPSTREAM.md`.
 *   - The record of applied migrations lives OUTSIDE `os_governance`
 *     (`os_migrations.governance_migrations`), so rolling the schema back (DROP SCHEMA) never
 *     deletes the table that records the rollback.
 *   - node-pg-migrate's advisory lock (default on) makes concurrent boots safe: one migrates, the
 *     other waits (`advisoryLockMode: 'wait'`) and then finds nothing to do.
 *   - THE QUEUE SCHEMA: after the SQL migrations, an `up` also runs pg-boss's OWN install/migrate
 *     (its CLI, `pg-boss migrate`, docs/cli.md) as the same login, i.e. the migration owner. That is the ONLY place pg-boss DDL runs: every runtime instance
 *     (`createBoss`) starts with `migrate: false`, so the owner owns `pgboss` and everything in it,
 *     and the OS's logins have DML only (migration 3's default privileges).
 *   - Errors propagate. There is no "continue without the schema" path.
 */
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import type { Fetched } from '@core/adapters/_contract';
import { PGBOSS_SCHEMA } from './boss.ts';
import { fetchedOk, pgFailure } from './pool.ts';

const run = promisify(execFile);

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
export const MIGRATIONS_SCHEMA = 'os_migrations';
export const MIGRATIONS_TABLE = 'governance_migrations';

/** The `agent_runs` database's own migrations (WP-53b): tables the agent-module runs use. */
export const AGENT_RUNS_MIGRATIONS_DIR = fileURLToPath(new URL('./agent-runs-migrations/', import.meta.url));
export const AGENT_RUNS_MIGRATIONS_TABLE = 'agent_runs_migrations';

/**
 * Apply the `agent_runs` migrations with node-pg-migrate's runner, under its advisory lock
 * (`wait`), so concurrent boots of os-ui and os-ui-worker serialise: one migrates, the other finds
 * nothing to do. No pg-boss step (the queue is not in this database).
 */
export async function migrateAgentRuns(opts: { databaseUrl: string; direction?: 'up' | 'down'; count?: number }): Promise<Fetched<string[]>> {
  const databaseUrl = opts.databaseUrl.trim();
  if (!databaseUrl) throw new Error('migrateAgentRuns: no database URL');
  try {
    const ran = await runner({
      databaseUrl,
      dir: AGENT_RUNS_MIGRATIONS_DIR,
      direction: opts.direction ?? 'up',
      count: opts.count,
      migrationsSchema: MIGRATIONS_SCHEMA,
      createMigrationsSchema: true,
      migrationsTable: AGENT_RUNS_MIGRATIONS_TABLE,
      checkOrder: true,
      singleTransaction: true,
      advisoryLockMode: 'wait',
      log: () => undefined,
    });
    return fetchedOk(ran.map((m) => m.name));
  } catch (err) {
    return pgFailure(err);
  }
}

export interface MigrateOptions {
  databaseUrl: string;
  direction: 'up' | 'down';
  /** How many migrations to apply; default all for `up`, 1 for `down` (node-pg-migrate defaults). */
  count?: number;
}

/**
 * Apply the governance migrations (and, on `up`, pg-boss's own migrate). `ok` carries the names
 * node-pg-migrate ran (empty when up to date); any failure is `ok:false` with Postgres's SQLSTATE
 * or the tool's own output in `detail` (the adapter contract), never a partial success.
 */
export async function migrateGovernance(opts: MigrateOptions): Promise<Fetched<string[]>> {
  const databaseUrl = opts.databaseUrl.trim();
  if (!databaseUrl) throw new Error('migrateGovernance: no database URL');
  try {
    const ran = await migrateOrThrow(databaseUrl, opts);
    return fetchedOk(ran);
  } catch (err) {
    return pgFailure(err);
  }
}

async function migrateOrThrow(databaseUrl: string, opts: MigrateOptions): Promise<string[]> {
  const ran = await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: opts.direction,
    count: opts.count,
    migrationsSchema: MIGRATIONS_SCHEMA,
    createMigrationsSchema: true,
    migrationsTable: MIGRATIONS_TABLE,
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: 'wait',
    log: () => undefined,
  });
  if (opts.direction === 'up') await installQueueSchema(databaseUrl);
  return ran.map((m) => m.name);
}

/**
 * (Throws; `migrateGovernance` reports it.) pg-boss's own install / migrate of schema `pgboss`, run AS THE MIGRATION OWNER (the caller's
 * login) with pg-boss's documented CLI (`pg-boss migrate`, docs/cli.md: "brings the schema up to
 * the latest version … a migration run needs no live worker", async index builds inlined), with
 * the connection in `PGBOSS_DATABASE_URL` / `PGBOSS_SCHEMA` as that page documents. Idempotent.
 * Exits non-zero → this throws with pg-boss's own output.
 */
export async function installQueueSchema(databaseUrl: string): Promise<void> {
  const cli = join(dirname(createRequire(import.meta.url).resolve('pg-boss')), 'cli.js');
  try {
    await run(process.execPath, [cli, 'migrate'], {
      env: { ...process.env, PGBOSS_DATABASE_URL: databaseUrl, PGBOSS_SCHEMA: PGBOSS_SCHEMA },
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`pg-boss migrate failed: ${e.stderr || e.stdout || e.message}`);
  }
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    await c.query(QUEUE_LOCKDOWN_SQL);
  } finally {
    await c.end();
  }
}

/**
 * Applied by the owner after every `pg-boss migrate` (verifier N2). Two pg-boss tables carry
 * content that a MIGRATING pg-boss instance acts on as the owner:
 *   - `bam` holds SQL text (`command`) that pg-boss's async-migration runner executes. Only the
 *     owner's migration writes it (`INSERT INTO … bam` exists only in pg-boss's migration and
 *     partitioned-queue plans, both DDL the OS logins cannot run anyway), so the OS logins keep
 *     SELECT only.
 *   - `version.version` decides which migrations run. At run time pg-boss only stamps its interval
 *     claims there — `cron_on`, `bam_on`, `flow_on`, `reindex_on` (`trySetTimestamp`) and
 *     `monitor_backoff_on` — read from pg-boss 12.38.2 `dist/plans.js`. So the OS logins get
 *     UPDATE on exactly those columns and no INSERT / DELETE.
 * Idempotent; re-applied after each migrate because a pg-boss migration may recreate a table.
 */
export const QUEUE_LOCKDOWN_SQL = `
  REVOKE INSERT, UPDATE, DELETE ON ${PGBOSS_SCHEMA}.bam FROM os_governance_app, os_governance_jobs;
  GRANT SELECT ON ${PGBOSS_SCHEMA}.bam TO os_governance_app, os_governance_jobs;
  REVOKE INSERT, UPDATE, DELETE ON ${PGBOSS_SCHEMA}.version FROM os_governance_app, os_governance_jobs;
  GRANT SELECT ON ${PGBOSS_SCHEMA}.version TO os_governance_app, os_governance_jobs;
  GRANT UPDATE (cron_on, bam_on, flow_on, reindex_on, monitor_backoff_on)
    ON ${PGBOSS_SCHEMA}.version TO os_governance_app, os_governance_jobs;
`;
