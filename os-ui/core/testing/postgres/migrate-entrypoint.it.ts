/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    Integration test: the production migration entrypoint (`worker/migrate-governance.mjs`)
 *             installs os_governance + pgboss as the NOSUPERUSER owner, idempotently, and fails loudly
 * USER STORY: As an operator I want the chart's migration Job to be the one thing that creates the
 *             governance schema, so a fresh or upgraded release never serves the os-grants bundle
 *             from a database that has no `grant_revision` (dev, 21-22 Nov 2026: OPA never became
 *             Ready and every OPA-checked action answered `opa-unreachable`).
 * ARCHITECTURE:
 *   - Runs the REAL entrypoint as a child process (the exact command the Job runs) against a real
 *     postgres:17, after the chart's own bootstrap SQL created the roles. Asserts on Postgres's
 *     catalog and on the exit code, never on what the entrypoint prints.
 *   - Negative twins: a wrong password, a missing URL and a SUPERUSER URL each exit non-zero and
 *     leave no schema behind (the owner role, not a superuser, owns the schema).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { adminClient, adminUrl, urlFor } from './it-support.ts';

const chartSql = (name: string) =>
  readFile(new URL(`../../../../charts/sovereign-agentic-os/files/os-governance/${name}`, import.meta.url), 'utf8');
const OS_UI = fileURLToPath(new URL('../../../', import.meta.url));

const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
const DB = `wp_mig_${suffix}`;
const OWNER = { user: `wp_mig_owner_${suffix}`, password: 'owner-pw-it' };
const RUNTIME = { user: `wp_mig_rt_${suffix}`, password: 'rt-pw-it' };
const QUEUE = { user: `wp_mig_q_${suffix}`, password: 'q-pw-it' };

/** The exact command the chart's `os-governance-migrate` Job runs, with only the owner URL in its env. */
function entrypoint(env: Record<string, string>) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'worker/migrate-governance.mjs'], {
    cwd: OS_UI,
    env: { PATH: process.env.PATH ?? '', ...env } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 100_000,
  });
}
const ownerUrl = () => urlFor(DB, OWNER);

async function schemaExists(): Promise<{ gov: boolean; boss: boolean }> {
  const su = await adminClient(DB);
  try {
    const r = await su.query(
      `select to_regclass('os_governance.grant_revision') is not null as gov, to_regclass('pgboss.job') is not null as boss`,
    );
    return r.rows[0];
  } finally {
    await su.end();
  }
}

describe('production governance migration entrypoint (real postgres:17)', { timeout: 300_000 }, () => {
  before(async () => {
    const su = await adminClient();
    try {
      await su.query(
        `select set_config('os_bootstrap.database', $1, false),
                set_config('os_bootstrap.owner_role', $2, false), set_config('os_bootstrap.owner_password', $3, false),
                set_config('os_bootstrap.runtime_role', $4, false), set_config('os_bootstrap.runtime_password', $5, false),
                set_config('os_bootstrap.queue_role', $6, false), set_config('os_bootstrap.queue_password', $7, false)`,
        [DB, OWNER.user, OWNER.password, RUNTIME.user, RUNTIME.password, QUEUE.user, QUEUE.password],
      );
      await su.query(await chartSql('roles.sql'));
      await su.query(`CREATE DATABASE ${DB} OWNER ${OWNER.user}`);
      await su.query(await chartSql('database-grants.sql'));
    } finally {
      await su.end();
    }
  });
  after(async () => {
    const su = await adminClient();
    try {
      await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      for (const r of [RUNTIME.user, QUEUE.user, OWNER.user]) await su.query(`DROP ROLE IF EXISTS ${r}`);
    } finally {
      await su.end();
    }
  });

  test('negative twins: no URL, a wrong password and a SUPERUSER login all exit non-zero and create nothing', async () => {
    const none = entrypoint({});
    assert.notEqual(none.status, 0, 'no owner URL must fail');
    assert.match(none.stderr, /OS_GOVERNANCE_OWNER_DATABASE_URL/);

    const wrong = entrypoint({ OS_GOVERNANCE_OWNER_DATABASE_URL: urlFor(DB, { user: OWNER.user, password: 'not-the-password' }) });
    assert.notEqual(wrong.status, 0, 'a wrong password must fail');

    const su = new URL(adminUrl());
    const sup = entrypoint({ OS_GOVERNANCE_OWNER_DATABASE_URL: urlFor(DB, { user: decodeURIComponent(su.username), password: decodeURIComponent(su.password) }) });
    assert.notEqual(sup.status, 0, 'a superuser login must be refused');
    assert.match(sup.stderr, /superuser/i);

    assert.deepEqual(await schemaExists(), { gov: false, boss: false }, 'a failed run leaves no schema behind');
  });

  test('as the owner it installs os_governance and pgboss, and the runtime login can read grant_revision', async () => {
    const r = entrypoint({ OS_GOVERNANCE_OWNER_DATABASE_URL: ownerUrl() });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(await schemaExists(), { gov: true, boss: true });

    const su = await adminClient(DB);
    try {
      const o = await su.query(`select pg_get_userbyid(nspowner) as o from pg_namespace where nspname = 'os_governance'`);
      assert.equal(o.rows[0].o, OWNER.user, 'the schema is owned by the NOSUPERUSER owner, not a superuser');
    } finally {
      await su.end();
    }
    const rt = new pg.Client({ connectionString: urlFor(DB, RUNTIME) });
    await rt.connect();
    try {
      const rev = await rt.query('select rev from os_governance.grant_revision');
      assert.equal(rev.rowCount, 1);
    } finally {
      await rt.end();
    }
  });

  test('idempotent: a second run (every upgrade) succeeds and applies nothing', async () => {
    const r = entrypoint({ OS_GOVERNANCE_OWNER_DATABASE_URL: ownerUrl() });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /up to date|0 migrations/i);
  });
});
