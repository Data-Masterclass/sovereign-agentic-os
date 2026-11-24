/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    Integration test: the append-only, hash-chained `audit_events` table
 * USER STORY: As an auditor I want every governance event kept in order and tamper-evident, so a
 *             changed, removed or reordered event is found by one verify query, and the OS's own
 *             database role can only append, never rewrite.
 * ARCHITECTURE:
 *   - The runtime connects as a LOGIN role that is a member of `os_governance_app`, exactly as
 *     deployed; the privilege checks are Postgres's (SQLSTATE 42501), not ours.
 *   - Negative twin: tampering as the superuser (with triggers disabled through
 *     `session_replication_role = replica`, the strongest in-database attacker) MUST turn
 *     `verifyAuditChain` red. If the chain were faked (hash not covering the content, or the link
 *     not checked) these tests fail.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase, testPool, urlFor } from './it-support.ts';
import { migrateGovernance } from './unwrapped.ts';
import { appendAuditEvent, AUDIT_GENESIS_HASH, verifyAuditChain } from './unwrapped.ts';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let admin: pg.Client;
let app: pg.Pool;
let closeApp: (() => Promise<void>) | undefined;
const APP_LOGIN = { user: `wp07_app_${process.pid}`, password: 'wp07-app-pw' };

const event = (i: number) => ({
  actorUid: 'u123',
  actorKind: 'user' as const,
  action: 'approval.decide',
  objectKind: 'approval',
  objectId: `a${i}`,
  domain: 'sales',
  outcome: 'allow' as const,
  decisionId: `dec-${i}`,
  policyRev: 'rev-7',
  payload: { n: i, note: 'ünïcode ✓' },
});

/** Run SQL as the superuser with every trigger off: the strongest in-database tamperer. */
async function tamper(sql: string, params: unknown[] = []): Promise<void> {
  await admin.query(`SET session_replication_role = replica`);
  try {
    await admin.query(sql, params);
  } finally {
    await admin.query(`SET session_replication_role = origin`);
  }
}

describe('audit_events hash chain (real postgres:17)', { timeout: 120_000 }, () => {
  before(async () => {
    db = await freshDatabase('wp07_audit');
    await migrateGovernance({ databaseUrl: db.url, direction: 'up' });
    admin = new pg.Client({ connectionString: db.url });
    await admin.connect();
    await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN.user}`);
    await admin.query(`CREATE ROLE ${APP_LOGIN.user} LOGIN PASSWORD '${APP_LOGIN.password}' IN ROLE os_governance_app`);
    ({ pool: app, close: closeApp } = testPool({ connectionString: urlFor(db.name, APP_LOGIN), max: 10 }));
  });
  after(async () => {
    await closeApp?.();
    await admin?.end().catch(() => undefined);
    await db?.drop();
    const c = new pg.Client({ connectionString: urlFor('postgres') });
    await c.connect();
    await c.query(`DROP ROLE IF EXISTS ${APP_LOGIN.user}`).catch(() => undefined);
    await c.end();
  });

  test('the runtime role appends; each row links to the previous hash; verify is OK', async () => {
    const rows = [];
    for (let i = 1; i <= 5; i++) rows.push(await appendAuditEvent(app, event(i)));
    assert.equal(rows[0].prevHash, AUDIT_GENESIS_HASH);
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prevHash, rows[i - 1].hash, `link ${i}`);
    assert.match(rows[4].hash, /^[0-9a-f]{64}$/);
    const v = await verifyAuditChain(app);
    assert.deepEqual({ ok: v.ok, checked: v.checked, head: v.headHash }, { ok: true, checked: 5, head: rows[4].hash });
  });

  test('a client cannot choose its own hash, prev_hash or timestamp', async () => {
    const r = await app.query(
      `insert into os_governance.audit_events (actor_uid, actor_kind, action, prev_hash, hash, occurred_at)
       values ('u9', 'user', 'forged', 'f', 'f', '2000-01-01') returning id, prev_hash, hash, occurred_at`,
    );
    assert.notEqual(r.rows[0].hash, 'f');
    assert.notEqual(r.rows[0].prev_hash, 'f');
    assert.ok(new Date(r.rows[0].occurred_at).getUTCFullYear() >= 2026);
    assert.equal((await verifyAuditChain(app)).ok, true);
  });

  test('the runtime role cannot UPDATE, DELETE or TRUNCATE audit_events (SQLSTATE 42501)', async () => {
    for (const sql of [
      `update os_governance.audit_events set action = 'x'`,
      `delete from os_governance.audit_events`,
      `truncate os_governance.audit_events`,
    ]) {
      await assert.rejects(app.query(sql), (err: { code?: string }) => err.code === '42501', sql);
    }
  });

  test('even the owner cannot UPDATE, DELETE or TRUNCATE through normal SQL (append-only trigger)', async () => {
    await assert.rejects(
      admin.query(`update os_governance.audit_events set action = 'x' where id = (select min(id) from os_governance.audit_events)`),
      /append-only/,
    );
    await assert.rejects(admin.query(`delete from os_governance.audit_events`), /append-only/);
    await assert.rejects(admin.query(`truncate os_governance.audit_events`), /append-only/);
  });

  test('20 concurrent appends from separate connections still form one linear chain', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendAuditEvent(app, event(100 + i))));
    const v = await verifyAuditChain(app);
    assert.equal(v.ok, true, v.reason ?? '');
    assert.equal(v.checked, 26);
  });

  test('a READ COMMITTED transaction that rolls back leaves no gap in the chain', async () => {
    const c = await app.connect();
    try {
      await c.query('begin');
      await appendAuditEvent(c, event(150));
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
    await appendAuditEvent(app, event(151));
    assert.equal((await verifyAuditChain(app)).ok, true);
  });

  // Verifier probe verify-07-probes/rr.mjs, as a test: A opens a transaction and takes its
  // snapshot, B appends and commits, then A appends.
  for (const iso of ['repeatable read', 'serializable'] as const) {
    test(`two connections: an append under ${iso.toUpperCase()} is refused (0A000) and the chain stays linked`, async () => {
      const a = await app.connect();
      const b = await app.connect();
      try {
        await a.query(`begin isolation level ${iso}`);
        await a.query('select count(*) from os_governance.audit_events'); // snapshot taken
        await appendAuditEvent(b, event(200)); // committed after A's snapshot
        await assert.rejects(
          appendAuditEvent(a, event(201)),
          (err: { code?: string; message?: string }) => err.code === '0A000' && /READ COMMITTED/.test(err.message ?? ''),
        );
      } finally {
        await a.query('rollback').catch(() => undefined); // never return a client with an open tx
        a.release();
        b.release();
      }
      const v = await verifyAuditChain(app);
      assert.equal(v.ok, true, v.reason ?? '');
    });
  }

  test('two connections: a READ COMMITTED append after a concurrent commit links to it', async () => {
    const a = await app.connect();
    const b = await app.connect();
    try {
      await a.query('begin isolation level read committed');
      await a.query('select count(*) from os_governance.audit_events');
      const fromB = await appendAuditEvent(b, event(300));
      const fromA = await appendAuditEvent(a, event(301));
      await a.query('commit');
      assert.equal(fromA.prevHash, fromB.hash, 'A links to the row B committed after A began');
    } finally {
      await a.query('rollback').catch(() => undefined);
      a.release();
      b.release();
    }
    const v = await verifyAuditChain(app);
    assert.equal(v.ok, true, v.reason ?? '');
  });

  test('NEGATIVE TWIN: a changed payload is detected at that row', async () => {
    const victim = (await admin.query(`select id from os_governance.audit_events order by id offset 2 limit 1`)).rows[0].id as string;
    await tamper(`update os_governance.audit_events set payload = '{"n": 999}' where id = $1`, [victim]);
    const v = await verifyAuditChain(app);
    assert.equal(v.ok, false);
    assert.equal(v.firstBadId, victim);
    assert.match(v.reason ?? '', /content/);
  });

  test('NEGATIVE TWIN: re-hashing the altered row breaks the next link instead', async () => {
    const victim = (await admin.query(`select id from os_governance.audit_events order by id offset 2 limit 1`)).rows[0].id as string;
    // The attacker recomputes the tampered row's own hash with the real function …
    await tamper(
      `update os_governance.audit_events e set hash = os_governance.audit_event_hash(e.prev_hash, e) where id = $1`,
      [victim],
    );
    const v = await verifyAuditChain(app);
    // … so the row itself checks out, but its successor still points at the old hash.
    const next = (await admin.query(`select min(id) as id from os_governance.audit_events where id > $1`, [victim])).rows[0].id;
    assert.equal(v.ok, false);
    assert.equal(v.firstBadId, next);
    assert.match(v.reason ?? '', /link/);
  });

  test('NEGATIVE TWIN: a removed row is detected (fresh chain)', async () => {
    await tamper(`truncate os_governance.audit_events`);
    for (let i = 1; i <= 4; i++) await appendAuditEvent(app, event(i));
    assert.equal((await verifyAuditChain(app)).ok, true, 'fresh chain verifies');

    const ids = (await admin.query(`select id from os_governance.audit_events order by id`)).rows.map((r) => r.id as string);
    await tamper(`delete from os_governance.audit_events where id = $1`, [ids[1]]);
    const v = await verifyAuditChain(app);
    assert.equal(v.ok, false);
    assert.equal(v.firstBadId, ids[2]);
    assert.match(v.reason ?? '', /link/);
  });
});
