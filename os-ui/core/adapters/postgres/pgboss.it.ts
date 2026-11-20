/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    Integration test: the pg-boss behaviours the OS design relies on (10 F8)
 * USER STORY: As an engineer I want the one job queue proven on the pinned pg-boss and the real
 *             postgres:17 before any reconciler, outbox or scheduled run depends on it.
 * ARCHITECTURE:
 *   - Proves, against the real database, the four behaviours 10 F8 names:
 *       1. `send(…, { db })` joins the CALLER's transaction: rollback → no job, commit → job
 *          (the outbox is pg-boss itself). Negative twin: without `db` the job escapes the
 *          rollback, so the test would fail if `bossDb` were not really the caller's client.
 *       2. `singletonKey` coalesces per key on a `stately` queue (and does not on `standard`).
 *       3. `work()` retries a failed job up to `retryLimit` and completes it; `retryLimit: 0`
 *          fails it at once (non-idempotent work).
 *       4. `schedule(…, { tz })` stores and fires in the given IANA zone (TestClock, pg-boss's
 *          documented test clock), and rejects an unknown zone.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PgBoss, TestClock } from 'pg-boss';
import { freshDatabase } from './it-support.ts';
import { migrateGovernance } from './migrate.ts';
import { PGBOSS_POOL_MAX, PGBOSS_SCHEMA, createBoss, registerWorker } from './boss.ts';
import { __clearRunWorkerProcess, markRunWorkerProcess } from '@core/kernel/process-role';
import { bossDb, withTransaction } from './tx.ts';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
let boss: PgBoss;

async function statusRow(id: string): Promise<number> {
  const r = await pool.query(`select count(*)::int as n from os_governance.object_status where kind = 'dataset' and id = $1`, [id]);
  return r.rows[0].n;
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('pg-boss on the real postgres:17', { timeout: 120_000 }, () => {
  before(async () => {
    db = await freshDatabase('wp07_boss');
    await migrateGovernance({ databaseUrl: db.url, direction: 'up' });
    pool = new pg.Pool({ connectionString: db.url, max: 5 });
    markRunWorkerProcess(); // these tests run pg-boss workers, which only the worker process may
    boss = createBoss(db.url);
    boss.on('error', (err) => console.error('pg-boss error', err));
    await boss.start();
  });
  after(async () => {
    __clearRunWorkerProcess();
    await boss?.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
    await pool?.end();
    await db?.drop();
  });

  test('start() installs pg-boss in its own schema (version 46 for 12.38.x)', async () => {
    const r = await pool.query(`select version from ${PGBOSS_SCHEMA}.version`);
    assert.equal(Number(r.rows[0].version), 46);
  });

  test('pg-boss holds at most PGBOSS_POOL_MAX connections of its own', async () => {
    const r = await pool.query(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and application_name = 'pgboss'`,
    );
    assert.ok(r.rows[0].n <= PGBOSS_POOL_MAX, `pg-boss opened ${r.rows[0].n} connections`);
  });

  test('bossDb returns every statement result for a multi-statement text, as pg does (constructor.md `db`)', async () => {
    await withTransaction(pool, async (client) => {
      const one = (await bossDb(client).executeSql('select 1 as a')) as unknown as { rows: { a: number }[] };
      assert.deepEqual(one.rows, [{ a: 1 }]);
      const many = (await bossDb(client).executeSql('select 1 as a; select 2 as b')) as unknown as { rows: unknown[] }[];
      assert.ok(Array.isArray(many), 'several statements → an array of results');
      assert.deepEqual(many.map((r) => r.rows), [[{ a: 1 }], [{ b: 2 }]]);
    });
  });

  test('registerWorker refuses outside the worker process; the web process only sends', async () => {
    __clearRunWorkerProcess();
    try {
      await boss.createQueue('web.only');
      await assert.rejects(registerWorker(boss, 'web.only', {}, async () => undefined), /only in os-ui-worker/);
      assert.ok(await boss.send('web.only', {}), 'sending from the web process is allowed');
    } finally {
      markRunWorkerProcess();
    }
  });

  test('send(…, { db }) rolls back with the caller transaction and commits with it', async () => {
    await boss.createQueue('reconcile.dataset');

    await assert.rejects(
      withTransaction(pool, async (client) => {
        await client.query(`insert into os_governance.object_status (kind, id, generation) values ('dataset', 'd-rollback', 1)`);
        const id = await boss.send('reconcile.dataset', { id: 'd-rollback' }, { db: bossDb(client) });
        assert.ok(id, 'send inside the tx returns an id');
        throw new Error('caller aborts');
      }),
      /caller aborts/,
    );
    assert.equal(await statusRow('d-rollback'), 0);
    const leaked = await boss.findJobs('reconcile.dataset', { data: { id: 'd-rollback' } });
    assert.equal(leaked.length, 0, 'the job must roll back with the state change');

    const committedId = await withTransaction(pool, async (client) => {
      await client.query(`insert into os_governance.object_status (kind, id, generation) values ('dataset', 'd-commit', 1)`);
      return boss.send('reconcile.dataset', { id: 'd-commit' }, { db: bossDb(client) });
    });
    assert.equal(await statusRow('d-commit'), 1);
    assert.ok(committedId);
    assert.ok(await boss.getJobById('reconcile.dataset', committedId), 'the committed job exists');
  });

  test('NEGATIVE TWIN: without { db } the job escapes the rollback', async () => {
    await assert.rejects(
      withTransaction(pool, async (client) => {
        await client.query(`insert into os_governance.object_status (kind, id, generation) values ('dataset', 'd-escape', 1)`);
        await boss.send('reconcile.dataset', { id: 'd-escape' });
        throw new Error('caller aborts');
      }),
      /caller aborts/,
    );
    assert.equal(await statusRow('d-escape'), 0);
    const escaped = await boss.findJobs('reconcile.dataset', { data: { id: 'd-escape' } });
    assert.equal(escaped.length, 1, 'pg-boss on its own pool is NOT in the caller transaction');
  });

  test('singletonKey coalesces per key on a stately queue, not on a standard one', async () => {
    await boss.createQueue('reconcile.connection', { policy: 'stately' });
    const a = await boss.send('reconcile.connection', { id: 'c1' }, { singletonKey: 'connection:c1' });
    const b = await boss.send('reconcile.connection', { id: 'c1' }, { singletonKey: 'connection:c1' });
    const c = await boss.send('reconcile.connection', { id: 'c2' }, { singletonKey: 'connection:c2' });
    assert.ok(a);
    assert.equal(b, null, 'a second queued job for the same key is coalesced');
    assert.ok(c, 'another key is independent');

    await boss.createQueue('plain', { policy: 'standard' });
    const p1 = await boss.send('plain', {}, { singletonKey: 'k' });
    const p2 = await boss.send('plain', {}, { singletonKey: 'k' });
    assert.ok(p1 && p2, 'a standard queue does not coalesce: the policy is what does it');
  });

  test('work() retries a failing job up to retryLimit, then completes it', async () => {
    await boss.createQueue('retry.ok', { retryLimit: 2, retryDelay: 0 });
    const attempts: number[] = [];
    await registerWorker(boss, 'retry.ok', { pollingIntervalSeconds: 0.5 }, async ([job]) => {
      attempts.push(job.id.length);
      if (attempts.length === 1) throw new Error('transient');
      return { done: true };
    });
    const id = await boss.send('retry.ok', { x: 1 });
    assert.ok(id);
    const final = await waitFor('retry.ok completed', async () => {
      const j = await boss.getJobById('retry.ok', id);
      return j && j.state === 'completed' ? j : null;
    });
    assert.equal(final.retryCount, 1, 'one failure, one retry');
    assert.equal(attempts.length, 2);
    assert.deepEqual(final.output, { done: true });
  });

  test('retryLimit: 0 fails a non-idempotent job at once, with the error as output', async () => {
    await boss.createQueue('retry.none', { retryLimit: 0 });
    let calls = 0;
    await registerWorker(boss, 'retry.none', { pollingIntervalSeconds: 0.5 }, async () => {
      calls++;
      throw new Error('not idempotent');
    });
    const id = await boss.send('retry.none', {});
    assert.ok(id);
    const final = await waitFor('retry.none failed', async () => {
      const j = await boss.getJobById('retry.none', id);
      return j && j.state === 'failed' ? j : null;
    });
    assert.equal(final.retryCount, 0);
    assert.equal(calls, 1);
    assert.match(JSON.stringify(final.output), /not idempotent/);
  });

  test('schedule(…, { tz }) is stored with its zone; an unknown zone is rejected', async () => {
    await boss.createQueue('agents.sys_1.run');
    await boss.schedule('agents.sys_1.run', '0 3 * * *', { systemId: 'sys_1' }, { tz: 'Europe/Berlin' });
    const [s] = await boss.getSchedules('agents.sys_1.run');
    assert.equal(s.cron, '0 3 * * *');
    assert.equal(s.timezone, 'Europe/Berlin');
    await assert.rejects(boss.schedule('agents.sys_1.run', '0 3 * * *', null, { tz: 'Europe/Berlinn' }));
  });

  test('a tz schedule fires at 03:00 Berlin (02:00Z in winter), a UTC one does not', async () => {
    // A second instance on the same schema with pg-boss's own TestClock (docs/api/testing.md).
    const clock = new TestClock('2026-11-21T01:58:00Z');
    const timed = new PgBoss({
      connectionString: db.url,
      schema: PGBOSS_SCHEMA,
      clock,
      supervise: false,
      __test__enableSpies: true,
    });
    timed.on('error', (err) => console.error('pg-boss (clock) error', err));
    await timed.start();
    try {
      await timed.createQueue('tz.berlin');
      await timed.createQueue('tz.utc');
      await timed.schedule('tz.berlin', '0 3 * * *', { zone: 'berlin' }, { tz: 'Europe/Berlin' });
      await timed.schedule('tz.utc', '0 3 * * *', { zone: 'utc' });

      await clock.tick(4 * 60_000); // 01:58Z → 02:02Z, i.e. 02:58 → 03:02 in Berlin
      const berlin = await waitFor('tz.berlin job', async () => (await timed.findJobs('tz.berlin')).at(0));
      assert.deepEqual(berlin.data, { zone: 'berlin' });
      assert.equal((await timed.findJobs('tz.utc')).length, 0, '03:00 UTC has not come yet');
    } finally {
      await timed.stop({ graceful: false, timeout: 2000 });
    }
  });
});
