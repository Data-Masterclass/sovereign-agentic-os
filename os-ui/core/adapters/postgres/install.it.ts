/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    Integration test: a clean install as a NOSUPERUSER, NOCREATEROLE owner, and the
 *             privilege boundary of the OS's own logins (incl. search_path shadowing)
 * USER STORY: As an operator I want the governance schema installed without any superuser at
 *             migration time, owned by a role that cannot create roles, with the OS running as a
 *             separate login that owns and can create nothing, and the queue owned by a third
 *             role, so the audit log's guarantees hold against the OS's own credentials.
 * ARCHITECTURE:
 *   - Executes the SAME SQL files the chart Job `os-governance-bootstrap` mounts
 *     (charts/sovereign-agentic-os/files/os-governance/*.sql), as the superuser, in the Job's order:
 *     session parameters → roles.sql → CREATE DATABASE … OWNER → database-grants.sql.
 *   - Then the migration step runs AS THE OWNER (node-pg-migrate, then `pg-boss migrate`), so the
 *     owner owns `pgboss` and every object in it; pg-boss starts AS THE QUEUE LOGIN with
 *     `migrate: false`; the OS's runtime login appends audit events and sends jobs inside its own
 *     transaction. Neither OS login can attach a trigger (verifier N1) or create anything.
 *   - The privilege probes are the verifier's (`verify-07-probes/rt.sql`, `owner.sql`,
 *     `shadow.sql`, `fork.mjs`): every refusal is Postgres's own SQLSTATE 42501, and a shadowed
 *     `clock_timestamp` / `pg_advisory_xact_lock` / `sha256` must not change what the chain stores.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { adminClient, urlFor } from './it-support.ts';
import { migrateGovernance } from './migrate.ts';
import { appendAuditEvent, verifyAuditChain } from './audit.ts';
import { PGBOSS_SCHEMA, createBoss } from './boss.ts';
import { bossDb } from './tx.ts';

const chartSql = (name: string) =>
  readFile(new URL(`../../../../charts/sovereign-agentic-os/files/os-governance/${name}`, import.meta.url), 'utf8');

const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
const DB = `wp07_install_${suffix}`;
const OWNER = { user: `wp07_owner_${suffix}`, password: 'owner-pw-it' };
const RUNTIME = { user: `wp07_rt_${suffix}`, password: 'rt-pw-it' };
const QUEUE = { user: `wp07_q_${suffix}`, password: 'q-pw-it' };
const OUTSIDER = { user: `wp07_out_${suffix}`, password: 'out-pw-it' };

const denied = (err: { code?: string }) => err.code === '42501';

type Params = { db: string; owner: string; runtime: string; queue: string };
const DEFAULT_PARAMS: Params = { db: DB, owner: OWNER.user, runtime: RUNTIME.user, queue: QUEUE.user };

async function setParams(c: pg.Client, p: Params): Promise<void> {
  await c.query(
    `select set_config('os_bootstrap.database', $1, false),
            set_config('os_bootstrap.owner_role', $2, false), set_config('os_bootstrap.owner_password', $3, false),
            set_config('os_bootstrap.runtime_role', $4, false), set_config('os_bootstrap.runtime_password', $5, false),
            set_config('os_bootstrap.queue_role', $6, false), set_config('os_bootstrap.queue_password', $7, false)`,
    [p.db, p.owner, OWNER.password, p.runtime, RUNTIME.password, p.queue, QUEUE.password],
  );
}

/** The chart Job's steps, as the superuser. */
async function bootstrap(): Promise<void> {
  const su = await adminClient();
  try {
    await setParams(su, DEFAULT_PARAMS);
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
      for (const r of [RUNTIME.user, QUEUE.user, OUTSIDER.user, OWNER.user]) await su.query(`DROP ROLE IF EXISTS ${r}`);
    } finally {
      await su.end();
    }
  });

  test('the bootstrap makes three distinct roles, none superuser or able to create roles', async () => {
    const su = await adminClient();
    try {
      const r = await su.query(
        `select rolname, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = any($1) order by rolname`,
        [[OWNER.user, RUNTIME.user, QUEUE.user]],
      );
      assert.equal(r.rowCount, 3);
      for (const row of r.rows) {
        assert.deepEqual([row.rolsuper, row.rolcreaterole, row.rolcreatedb], [false, false, false], row.rolname);
      }
      const member = await su.query(
        `select pg_has_role($1, 'os_governance_app', 'member') as rt_app, pg_has_role($2, 'os_governance_app', 'member') as q_app,
                pg_has_role($2, 'os_governance_jobs', 'member') as q_jobs, pg_has_role($1, 'os_governance_jobs', 'member') as rt_jobs`,
        [RUNTIME.user, QUEUE.user],
      );
      assert.deepEqual(member.rows[0], { rt_app: true, q_app: false, q_jobs: true, rt_jobs: false });
      const dbOwner = await su.query(`select pg_get_userbyid(datdba) as o from pg_database where datname = $1`, [DB]);
      assert.equal(dbOwner.rows[0].o, OWNER.user);
      const create = await su.query(
        `select has_database_privilege($1, $3, 'CREATE') as rt, has_database_privilege($2, $3, 'CREATE') as q`,
        [RUNTIME.user, QUEUE.user, DB],
      );
      assert.deepEqual(create.rows[0], { rt: false, q: false }, 'no OS login may CREATE in the database');
    } finally {
      await su.end();
    }
    await bootstrap(); // idempotent: a second run (every helm upgrade) changes nothing and does not fail
  });

  test('the bootstrap refuses a reserved name, an existing superuser and another service\'s database', async () => {
    const su = await adminClient();
    try {
      const roles = await chartSql('roles.sql');
      const grants = await chartSql('database-grants.sql');
      const cases: Array<[Partial<Params>, string, RegExp]> = [
        [{ owner: 'langfuse' }, roles, /reserved/],
        [{ runtime: 'agent_runs' }, roles, /reserved/],
        [{ db: 'litellm' }, roles, /reserved/],
        [{ queue: 'postgres' }, roles, /reserved/],
        [{ runtime: OWNER.user }, roles, /three different roles/],
        [{ owner: 'postgres_like_su' }, roles, /superuser/],
        [{ db: 'postgres' }, grants, /owned by|reserved/],
      ];
      await su.query(`DROP ROLE IF EXISTS postgres_like_su`);
      await su.query(`CREATE ROLE postgres_like_su SUPERUSER NOLOGIN`);
      try {
        for (const [over, sql, why] of cases) {
          await setParams(su, { ...DEFAULT_PARAMS, ...over });
          await assert.rejects(su.query(sql), why, JSON.stringify(over));
        }
        const attrs = await su.query(`select rolsuper from pg_roles where rolname = 'postgres_like_su'`);
        assert.equal(attrs.rows[0].rolsuper, true, 'the refused superuser was not demoted');
      } finally {
        await su.query(`DROP ROLE IF EXISTS postgres_like_su`);
      }
    } finally {
      await su.end();
    }
  });

  test('the migrations install cleanly AS THE OWNER (no CREATEROLE needed once the role exists)', async () => {
    const ran = await migrateGovernance({ databaseUrl: urlFor(DB, OWNER), direction: 'up' });
    assert.equal(ran.length, 3);
    owner = await connect(OWNER);
    const notOwned = await owner.query(
      `select n.nspname, c.relname, pg_get_userbyid(c.relowner) as owner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('os_governance', $1) and c.relowner <> (select oid from pg_roles where rolname = current_user)
       union all
       select n.nspname, p.proname, pg_get_userbyid(p.proowner)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('os_governance', $1) and p.proowner <> (select oid from pg_roles where rolname = current_user)
       union all
       select nspname, '(schema)', pg_get_userbyid(nspowner) from pg_namespace
        where nspname in ('os_governance', $1) and nspowner <> (select oid from pg_roles where rolname = current_user)`,
      [PGBOSS_SCHEMA],
    );
    assert.deepEqual(notOwned.rows, [], 'the owner owns both schemas and every table, sequence, index and function in them');
    const version = await owner.query(`select version from ${PGBOSS_SCHEMA}.version`);
    assert.equal(Number(version.rows[0].version), 46, 'pg-boss migrate ran as the owner');
  });

  test('pg-boss runs AS THE QUEUE LOGIN with migrate: false (DML only); the runtime sends in its own transaction', async () => {
    const boss = createBoss(urlFor(DB, QUEUE));
    boss.on('error', (err) => console.error('pg-boss error', err));
    await boss.start();
    try {
      await boss.createQueue('install.check');
      runtime = await connect(RUNTIME);
      await runtime.query('begin');
      const id = await boss.send('install.check', { n: 1 }, { db: bossDb(runtime as unknown as pg.PoolClient) });
      await runtime.query('commit');
      assert.ok(id && (await boss.getJobById('install.check', id)), 'the runtime-sent job is visible to the queue');
      const [job] = await boss.fetch('install.check');
      assert.equal(job?.id, id, 'the queue login fetches it');
      await boss.complete('install.check', id);
      assert.equal((await boss.getJobById('install.check', id))?.state, 'completed');
      await boss.supervise(); // maintenance runs as the queue login without any DDL
    } finally {
      await boss.stop({ graceful: false, timeout: 2000 });
    }
    const owners = await runtime.query(
      `select nspname, pg_get_userbyid(nspowner) as owner from pg_namespace where nspname in ('os_governance', $1) order by 1`,
      [PGBOSS_SCHEMA],
    );
    assert.deepEqual(owners.rows, [
      { nspname: 'os_governance', owner: OWNER.user },
      { nspname: PGBOSS_SCHEMA, owner: OWNER.user },
    ]);
  });

  test('the runtime login appends audit events and verifies the chain', async () => {
    await appendAuditEvent(runtime, { actorUid: 'u1', actorKind: 'user', action: 'install.check' });
    assert.equal((await verifyAuditChain(runtime)).ok, true);
  });

  test('the runtime login can create nothing and change no trigger, function or queue table', async () => {
    for (const sql of [
      `create schema evil`,
      `create function pgboss.clock_timestamp() returns timestamptz language sql as $$select now()$$`,
      `create table pgboss.evil (x int)`,
      `alter table pgboss.job add column evil int`,
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

  // Verifier N1: a trigger planted on pgboss.job would run as the runtime role inside a governance
  // transaction (send({ db })) and could forge governance rows. Neither OS login may plant one.
  test('NEGATIVE TWIN (N1): neither the queue nor the runtime login can plant a trigger on pgboss.job', async () => {
    const queue = await connect(QUEUE);
    try {
      for (const [who, c] of [['queue', queue], ['runtime', runtime]] as const) {
        for (const sql of [
          `create function pgboss.forge() returns trigger language plpgsql as $$ begin
             insert into os_governance.run_grants (id, kind, principal_uid, domain, system_id, scopes, issued_by, expires_at)
             values ('forged', 'run', 'attacker', 'sales', 'sys', '{write}', 'attacker', now() + interval '1 day');
             return new; end $$`,
          `create trigger forge after insert on pgboss.job for each row execute function os_governance.bump_row_version()`,
          `alter table pgboss.job disable trigger all`,
          `alter table pgboss.job alter column data set default '{}'::jsonb`,
          `create table pgboss.evil (x int)`,
          `truncate pgboss.job`,
        ]) {
          await assert.rejects(c.query(sql), denied, `${who}: ${sql.slice(0, 60)}`);
        }
        const priv = await c.query(
          `select has_table_privilege(current_user, 'pgboss.job', 'TRIGGER') as trig,
                  has_table_privilege(current_user, 'pgboss.job', 'TRUNCATE') as trunc,
                  has_schema_privilege(current_user, 'pgboss', 'CREATE') as create_in_schema,
                  has_table_privilege(current_user, 'pgboss.job', 'INSERT') as can_send`,
        );
        assert.deepEqual(priv.rows[0], { trig: false, trunc: false, create_in_schema: false, can_send: true }, who);
      }
      const triggers = await owner.query(
        `select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and not t.tgisinternal`,
        [PGBOSS_SCHEMA],
      );
      assert.deepEqual(triggers.rows, [], 'no user trigger exists on any pgboss table');
      const forged = await owner.query(`select count(*)::int as n from os_governance.run_grants where id = 'forged'`);
      assert.equal(forged.rows[0].n, 0);
    } finally {
      await queue.end();
    }
  });

  test('NEGATIVE TWIN: shadowing clock_timestamp / sha256 on search_path cannot backdate or poison a row', async () => {
    // A shadow schema the runtime can read (in production it cannot even create one, see above;
    // this proves the functions themselves are immune, the second line of defence).
    const su = await adminClient(DB);
    try {
      await su.query(`create schema shadow`);
      await su.query(`create function shadow.clock_timestamp() returns timestamptz language sql as $$ select timestamptz '2001-01-01 00:00:00Z' $$`);
      await su.query(`create function shadow.now() returns timestamptz language sql as $$ select timestamptz '2001-01-01 00:00:00Z' $$`);
      await su.query(`create function shadow.sha256(bytea) returns bytea language sql as $$ select '\\x00'::bytea $$`);
      await su.query(`create function shadow.pg_advisory_xact_lock(bigint) returns void language sql as $$ select $$`);
      await su.query(`grant usage on schema shadow to os_governance_app`);
    } finally {
      await su.end();
    }
    await runtime.query(`set search_path = shadow, pg_catalog, public`);
    try {
      const r = await runtime.query(
        `insert into os_governance.audit_events (actor_uid, actor_kind, action) values ('rt', 'user', 'backdate') returning occurred_at, hash`,
      );
      assert.ok(new Date(r.rows[0].occurred_at).getUTCFullYear() >= 2026, `stored ${r.rows[0].occurred_at}`);
      assert.notEqual(r.rows[0].hash, '00', 'the real sha256 was used');
      assert.match(r.rows[0].hash, /^[0-9a-f]{64}$/);
    } finally {
      await runtime.query(`reset search_path`);
    }
    assert.equal((await verifyAuditChain(runtime)).ok, true);
  });

  test('NEGATIVE TWIN: a shadowed pg_advisory_xact_lock does not skip the lock (no fork)', async () => {
    const a = await connect(RUNTIME);
    const b = await connect(RUNTIME);
    try {
      await a.query(`set search_path = shadow, pg_catalog, public`);
      await a.query('begin');
      await a.query(`insert into os_governance.audit_events (actor_uid, actor_kind, action) values ('a', 'user', 'no-lock?')`);
      // If the lock were skipped, B would append on the same head and commit first: a fork.
      // With the real lock, B waits for A.
      const bDone = b.query(`insert into os_governance.audit_events (actor_uid, actor_kind, action) values ('b', 'user', 'normal')`);
      const raced = await Promise.race([bDone.then(() => 'b-finished'), new Promise((r) => setTimeout(() => r('b-waiting'), 500))]);
      assert.equal(raced, 'b-waiting', 'B must wait for A\'s lock');
      await a.query('commit');
      await bDone;
    } finally {
      await a.query('rollback').catch(() => undefined);
      await a.end();
      await b.end();
    }
    const v = await verifyAuditChain(runtime);
    assert.equal(v.ok, true, v.reason ?? '');
  });

  test('the non-superuser owner cannot switch triggers off with session_replication_role', async () => {
    await assert.rejects(owner.query(`set session_replication_role = replica`), denied);
  });

  test('a login outside the governance roles cannot connect to the database', async () => {
    await assert.rejects(connect(OUTSIDER), denied);
  });
});
