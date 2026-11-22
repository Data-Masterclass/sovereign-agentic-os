/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       os-ui entrypoint (outside core/ and tabs/, like `worker/agent-runs.ts`)
 * FEATURE:    The production caller of the `os_governance` migrations (the chart's migration Job)
 * USER STORY: As an operator I want every install and upgrade with the governance store enabled to
 *             create or upgrade the schema AS THE OWNER, so the os-grants bundle has its
 *             `grant_revision` table and OPA becomes Ready; and I want a failed migration to fail the
 *             release, never to continue silently.
 * ARCHITECTURE:
 *   - A thin call to `migrateGovernance` (node-pg-migrate's runner, then pg-boss's own migrate),
 *     both idempotent under node-pg-migrate's advisory lock.
 *   - Connects with `OS_GOVERNANCE_OWNER_DATABASE_URL` only (the chart builds it from the OWNER
 *     Secret). os-ui and the worker never hold that credential: they run as the DML-only login.
 *   - Refuses a SUPERUSER login: the schema must be owned by the NOSUPERUSER, NOCREATEROLE owner or
 *     the audit log's guarantees do not hold against the OS's own credentials.
 *   - Any failure throws; `migrate-governance.mjs` exits non-zero, the Job fails, `helm upgrade` fails.
 */
import pg from 'pg';
import { migrateGovernance } from '@core/adapters/postgres/migrate';

export const OWNER_URL_ENV = 'OS_GOVERNANCE_OWNER_DATABASE_URL';

/** Run the migrations as the login in `env[OWNER_URL_ENV]`. Returns the migration names applied. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const databaseUrl = (env[OWNER_URL_ENV] ?? '').trim();
  if (!databaseUrl) throw new Error(`${OWNER_URL_ENV} is not set: the governance migrations run as the owner login only`);

  const probe = new pg.Client({ connectionString: databaseUrl });
  await probe.connect();
  try {
    const who = await probe.query<{ rolname: string; rolsuper: boolean }>(
      'select rolname, rolsuper from pg_roles where rolname = current_user',
    );
    if (who.rows[0]?.rolsuper) {
      throw new Error(`refusing to migrate as a superuser (${who.rows[0].rolname}): use the NOSUPERUSER owner login`);
    }
  } finally {
    await probe.end();
  }

  const r = await migrateGovernance({ databaseUrl, direction: 'up' });
  if (!r.ok) throw new Error(`governance migrations failed: ${r.reason} — ${r.detail}`);
  return r.value;
}
