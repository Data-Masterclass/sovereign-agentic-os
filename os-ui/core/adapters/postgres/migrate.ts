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
 *   - Errors propagate. There is no "continue without the schema" path.
 */
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
export const MIGRATIONS_SCHEMA = 'os_migrations';
export const MIGRATIONS_TABLE = 'governance_migrations';

export interface MigrateOptions {
  databaseUrl: string;
  direction: 'up' | 'down';
  /** How many migrations to apply; default all for `up`, 1 for `down` (node-pg-migrate defaults). */
  count?: number;
}

/** Apply the governance migrations. Returns the names node-pg-migrate ran (empty when up to date). */
export async function migrateGovernance(opts: MigrateOptions): Promise<string[]> {
  const databaseUrl = opts.databaseUrl.trim();
  if (!databaseUrl) throw new Error('migrateGovernance: no database URL');
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
  return ran.map((m) => m.name);
}
