/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    Integration test: a clean install as a NOSUPERUSER, NOCREATEROLE owner
 * USER STORY: As an operator I want the governance schema installed without any superuser at
 *             migration time, owned by a role that cannot create roles, with the OS running as a
 *             separate non-owner login, so the audit log's guarantees hold against the OS itself.
 * ARCHITECTURE:
 *   - Executes the SAME two SQL files the chart Job `os-governance-bootstrap` mounts
 *     (charts/sovereign-agentic-os/files/os-governance/*.sql), as the superuser, the same way the
 *     Job does: set the session parameters, roles.sql, CREATE DATABASE … OWNER, database-grants.sql.
 *   - Then node-pg-migrate runs AS THE OWNER, and pg-boss starts AS THE RUNTIME LOGIN.
 *   - The privilege probes are the verifier's (`verify-07-probes/rt.sql`, `owner.sql`): every
 *     refusal is Postgres's own SQLSTATE 42501.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { adminClient, urlFor } from './it-support.ts';
import { migrateGovernance } from './migrate.ts';
import { appendAuditEvent, verifyAuditChain } from './audit.ts';
import { PGBOSS_SCHEMA, createBoss } from './boss.ts';

const chartSql = (name: string) =>
  readFile(new URL(`../../../../charts/sovereign-agentic-os/files/os-governance/${name}`, import.meta.url), 'utf8');

const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
const DB = `wp07_install_${suffix}`;
const OWNER = { user: `wp07_owner_${suffix}`, password: 'owner-pw-it' };
const RUNTIME = { user: `wp07_rt_${suffix}`, password: 'rt-pw-it' };
const OUTSIDER = { user: `wp07_out_${suffix}`, password: 'out-pw-it' };

const denied = (err: { code?: string }) => err.code === '42501';

/** The chart Job's steps, in one superuser session. */
async function bootstrap(): Promise<void> {
  const su = await adminClient();
  try {
    await su.query(
      `select set_config('os_bootstrap.database', $1, false), set_config('os_bootstrap.owner_role', $2, false),
              set_config('os_bootstrap.owner_password', $3, false), set_config('os_bootstrap.runtime_role', $4, false),
              set_config('os_bootstrap.runtime_password', $5, false)`,
      [DB, OWNER.user, OWNER.password, RUNTIME.user, RUNTIME.password],
    );
    await su.query(await chartSql('roles.sql'));
    const exists = await su.query(`select 1 from pg_database where datname = $1`, [DB]);
    if (exists.rowCount === 0) await su.query(`CREATE DATABASE ${DB} OWNER ${OWNER.user}`);
    await su.query(await chartSql('database-grants.sql'));
  } finally {
    await su.end();
  }
}

async function connect(login: { user: string; password: string }): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlFor(DB, login) });
  await c.connect();
  return c;
}

describe('clean install as a NOCREATEROLE owner (real postgres:17)', { timeout: 120_000 }, () => {
  let owner: pg.Client;
  let runtime: pg.Client;

  before(async () => {
    await bootstrap();
    const su = await adminClient();
    await su.query(`CREATE ROLE ${OUTSIDER.user} LOGIN PASSWORD '${OUTSIDER.password}'`);
    await su.end();
  });
  after(async () => {
    await owner?.end().catch(() => undefined);
    await runtime?.end().catch(() => undefined);
    const su = await adminClient();
    try {
      await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      for (const r of [RUNTIME.user, OUTSIDER.user, OWNER.user]) await su.query(`DROP ROLE IF EXISTS ${r}`);
    } finally {
      await su.end();
    }
  });

  test('the bootstrap makes an owner that is neither superuser nor able to create roles', async () => {
    const su = await adminClient();
    try {
      const r = await su.query(
        `select rolname, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = any($1) order by rolname`,
        [[OWNER.user, RUNTIME.user]],
      );
      for (const row of r.rows) {
        assert.deepEqual([row.rolsuper, row.rolcreaterole, row.rolcreatedb], [false, false, false], row.rolname);
      }
      const member = await su.query(`select pg_has_role($1, 'os_governance_app', 'member') as m`, [RUNTIME.user]);
      assert.equal(member.rows[0].m, true);
      const dbOwner = await su.query(`select pg_get_userbyid(datdba) as o from pg_database where datname = $1`, [DB]);
      assert.equal(dbOwner.rows[0].o, OWNER.user);
    } finally {
      await su.end();
    }
    await bootstrap(); // idempotent: a second run (every helm upgrade) changes nothing and does not fail
  });

  test('the migrations install cleanly AS THE OWNER (no CREATEROLE needed once the role exists)', async () => {
    const ran = await migrateGovernance({ databaseUrl: urlFor(DB, OWNER), direction: 'up' });
    assert.equal(ran.length, 2);
    owner = await connect(OWNER);
    const notOwned = await owner.query(
      `select tablename from pg_tables where schemaname = 'os_governance' and tableowner <> current_user`,
    );
    assert.equal(notOwned.rowCount, 0, 'every os_governance table is owned by the owner role');
  });

  test('pg-boss installs its own schema AS THE RUNTIME LOGIN, which then owns only that schema', async () => {
    const boss = createBoss(urlFor(DB, RUNTIME));
    boss.on('error', (err) => console.error('pg-boss error', err));
    await boss.start();
    try {
      await boss.createQueue('install.check');
      assert.ok(await boss.send('install.check', {}));
    } finally {
      await boss.stop({ graceful: false, timeout: 2000 });
    }
    runtime = await connect(RUNTIME);
    const owners = await runtime.query(
      `select nspname, pg_get_userbyid(nspowner) as owner from pg_namespace where nspname in ('os_governance', $1) order by 1`,
      [PGBOSS_SCHEMA],
    );
    assert.deepEqual(owners.rows, [
      { nspname: 'os_governance', owner: OWNER.user },
      { nspname: PGBOSS_SCHEMA, owner: RUNTIME.user },
    ]);
  });

  test('the runtime login appends audit events and verifies the chain', async () => {
    await appendAuditEvent(runtime, { actorUid: 'u1', actorKind: 'user', action: 'install.check' });
    assert.equal((await verifyAuditChain(runtime)).ok, true);
  });

  test('the runtime login cannot disable or drop the triggers, nor switch them off for its session', async () => {
    for (const sql of [
      `alter table os_governance.audit_events disable trigger audit_events_no_update`,
      `drop trigger audit_events_chain on os_governance.audit_events`,
      `set session_replication_role = replica`,
      `create or replace function os_governance.audit_genesis_hash() returns text language sql as $$select 'x'$$`,
      `create table os_governance.evil (x int)`,
      `update os_governance.audit_events set action = 'x'`,
    ]) {
      await assert.rejects(runtime.query(sql), denied, sql);
    }
  });

  test('the non-superuser owner cannot switch triggers off with session_replication_role', async () => {
    await assert.rejects(owner.query(`set session_replication_role = replica`), denied);
  });

  test('a login outside the governance roles cannot connect to the database', async () => {
    await assert.rejects(connect(OUTSIDER), denied);
  });
});
