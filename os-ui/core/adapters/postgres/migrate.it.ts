/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    Integration test: the `os_governance` migrations up, again (idempotent), down, up
 * USER STORY: As an operator I want the governance schema to install, re-run as a no-op on every
 *             boot, and roll back cleanly, proven on the real postgres:17 image that runs live.
 * ARCHITECTURE:
 *   - Runs node-pg-migrate's own `runner()` through `migrate.ts` (no OS migration runner).
 *   - Asserts on Postgres's own catalog (`information_schema`, `pg_roles`), never on what the
 *     migrator says it did.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase } from './it-support.ts';
import { migrateGovernance, MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from './migrate.ts';

const EXPECTED_TABLES = [
  'approvals',
  'audit_events',
  'catalog_entities',
  'commit_checks',
  'confirmations',
  'cost_caps',
  'domain_settings',
  'exposure_sets',
  'grants',
  'lifecycle_pins',
  'notifications',
  'object_status',
  'prefs',
  'run_grant_approved_writes',
  'run_grants',
];

let db: Awaited<ReturnType<typeof freshDatabase>>;
let client: pg.Client;

async function tables(): Promise<string[]> {
  const r = await client.query(
    `select table_name from information_schema.tables where table_schema = 'os_governance' and table_type = 'BASE TABLE' order by 1`,
  );
  return r.rows.map((x) => x.table_name as string);
}

describe('os_governance migrations (real postgres:17)', () => {
  before(async () => {
    db = await freshDatabase('wp07_migrate');
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
  });
  after(async () => {
    await client?.end();
    await db?.drop();
  });

  test('up installs the 15 tables, the grant_rev sequence and the runtime role', async () => {
    const ran = await migrateGovernance({ databaseUrl: db.url, direction: 'up' });
    assert.ok(ran.length >= 2, `expected the migrations to run, got ${JSON.stringify(ran)}`);
    assert.deepEqual(await tables(), EXPECTED_TABLES);

    const seq = await client.query(
      `select 1 from information_schema.sequences where sequence_schema = 'os_governance' and sequence_name = 'grant_rev'`,
    );
    assert.equal(seq.rowCount, 1, 'grant_rev sequence missing');

    const role = await client.query(`select rolcanlogin from pg_roles where rolname = 'os_governance_app'`);
    assert.equal(role.rowCount, 1, 'os_governance_app role missing');
    assert.equal(role.rows[0].rolcanlogin, false, 'the runtime role is a group role, not a login');
  });

  test('every governance table except audit_events has version bigint and updated_at', async () => {
    for (const t of EXPECTED_TABLES.filter((x) => x !== 'audit_events')) {
      const cols = await client.query(
        `select column_name, data_type from information_schema.columns
          where table_schema = 'os_governance' and table_name = $1 and column_name in ('version', 'updated_at')
          order by column_name`,
        [t],
      );
      assert.deepEqual(
        cols.rows.map((c) => `${c.column_name}:${c.data_type}`),
        ['updated_at:timestamp with time zone', 'version:bigint'],
        `table ${t}`,
      );
    }
  });

  test('up again is a no-op (idempotent boot)', async () => {
    const ran = await migrateGovernance({ databaseUrl: db.url, direction: 'up' });
    assert.deepEqual(ran, []);
    assert.deepEqual(await tables(), EXPECTED_TABLES);
  });

  test('optimistic concurrency: an UPDATE bumps version and updated_at; a stale version matches 0 rows', async () => {
    await client.query(
      `insert into os_governance.prefs (principal_uid, key, value) values ('u1', 'theme', '"dark"')`,
    );
    const before = await client.query(`select version, updated_at from os_governance.prefs where principal_uid = 'u1'`);
    assert.equal(before.rows[0].version, '1');
    const upd = await client.query(
      `update os_governance.prefs set value = '"light"' where principal_uid = 'u1' and key = 'theme' and version = 1 returning version, updated_at`,
    );
    assert.equal(upd.rowCount, 1);
    assert.equal(upd.rows[0].version, '2');
    assert.ok(upd.rows[0].updated_at >= before.rows[0].updated_at);
    const stale = await client.query(
      `update os_governance.prefs set value = '"x"' where principal_uid = 'u1' and key = 'theme' and version = 1`,
    );
    assert.equal(stale.rowCount, 0, 'a stale version must not overwrite (409, never last-writer-wins)');
  });

  test('run_grants: exactly one of system_id / dataset; grant_rev advances on every change', async () => {
    await assert.rejects(
      client.query(
        `insert into os_governance.run_grants (id, kind, principal_uid, domain, scopes, issued_by, expires_at)
         values ('g0', 'run', 'u1', 'sales', '{}', 'u1', now() + interval '1 hour')`,
      ),
      /run_grants_target/,
    );
    const ins = await client.query(
      `insert into os_governance.run_grants (id, kind, principal_uid, domain, system_id, scopes, selection_hash, commit, issued_by, expires_at)
       values ('g1', 'run', 'u1', 'sales', 'sys_1', '{read}', 'h', 'abc', 'u1', now() + interval '1 hour') returning grant_rev`,
    );
    const upd = await client.query(
      `update os_governance.run_grants set active_run_id = 'run_1' where id = 'g1' returning grant_rev`,
    );
    assert.ok(BigInt(upd.rows[0].grant_rev) > BigInt(ins.rows[0].grant_rev), 'grant_rev must advance on update');
    await client.query(
      `insert into os_governance.approvals (id, kind, subject_kind, subject_id, domain, requested_by) values ('a1', 'write', 'run_grant', 'g1', 'sales', 'u1')`,
    );
    await client.query(
      `insert into os_governance.run_grant_approved_writes (grant_id, table_fqn, op, approval_id, expires_at)
       values ('g1', 'iceberg.sales.suppliers', 'insert', 'a1', now() + interval '1 hour')`,
    );
    await assert.rejects(
      client.query(
        `insert into os_governance.run_grant_approved_writes (grant_id, table_fqn, op, approval_id, expires_at)
         values ('g1', 'iceberg.sales.suppliers', 'update', 'a1', now() + interval '1 hour')`,
      ),
      /check constraint/,
      'op is limited to create|insert|merge|delete|drop',
    );
  });

  test('approvals: the requester can never be the approver', async () => {
    await assert.rejects(
      client.query(
        `update os_governance.approvals set status = 'approved', approver_uid = 'u1', decided_at = now() where id = 'a1'`,
      ),
      /approvals_four_eyes/,
    );
  });

  test('down removes the schema and the migration records; up works again', async () => {
    const down = await migrateGovernance({ databaseUrl: db.url, direction: 'down', count: Infinity });
    assert.ok(down.length >= 2);
    const schema = await client.query(`select 1 from information_schema.schemata where schema_name = 'os_governance'`);
    assert.equal(schema.rowCount, 0, 'os_governance must be gone after down');
    const recs = await client.query(`select count(*)::int as n from ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`);
    assert.equal(recs.rows[0].n, 0);

    const up = await migrateGovernance({ databaseUrl: db.url, direction: 'up' });
    assert.equal(up.length, down.length);
    assert.deepEqual(await tables(), EXPECTED_TABLES);
  });
});
