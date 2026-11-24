/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    Integration test: an idle pool connection killed by the server never crashes os-ui
 * USER STORY: As an operator I want a Postgres restart or failover to cost os-ui one reconnect, not
 *             the process: an idle connection the server closes is logged, and the next query works.
 * ARCHITECTURE:
 *   - Real postgres:17 (OS_PG_TEST_URL). The server itself ends the idle backend
 *     (`pg_terminate_backend`), exactly what a restart or `DROP DATABASE … WITH (FORCE)` does.
 *   - Negative twin: a bare `pg.Pool` (no listener) emits the same `error` with nobody to take it,
 *     which in a process is an uncaught exception (CI, 23 Nov 2026: test-dagster-identity went red
 *     after all eight tests had passed).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { adminClient, freshDatabase } from './it-support.ts';
import { closeGovernancePool, governancePool } from '@core/adapters/postgres/pool';

let db: Awaited<ReturnType<typeof freshDatabase>>;
before(async () => {
  db = await freshDatabase('pool_idle');
});
after(async () => {
  await closeGovernancePool();
  await db?.drop();
});

/** Terminate every backend of the test database except the admin's own. */
async function killBackends(): Promise<number> {
  const admin = await adminClient();
  try {
    const r = await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [db.name]);
    return r.rowCount ?? 0;
  } finally {
    await admin.end();
  }
}

/** Wait until `pool` has seen `n` errors via `listen`, or fail after `ms`. */
const errorsOn = (pool: pg.Pool, ms = 10_000) =>
  new Promise<Error>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no idle-client error within the deadline')), ms);
    pool.once('error', (e) => {
      clearTimeout(t);
      resolve(e);
    });
  });

test('the governance pool logs an idle connection the server closed, and the next query reconnects', async () => {
  const pool = governancePool(db.url);
  assert.equal(pool.listenerCount('error'), 1, 'the pool carries its own idle-client error listener');
  await pool.query('SELECT 1'); // one idle client in the pool now
  const logged: string[] = [];
  const keep = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  try {
    const seen = errorsOn(pool); // a second listener only to know WHEN it happened
    assert.ok((await killBackends()) >= 1, 'the server ended the idle backend');
    await seen;
  } finally {
    console.error = keep;
  }
  assert.ok(logged.some((l) => l.includes('postgres governance pool: an idle connection was closed by the server')), logged.join('\n'));
  const r = await pool.query<{ one: number }>('SELECT 1 AS one');
  assert.equal(r.rows[0].one, 1);
});

test('twin: a bare pg.Pool emits the same error with no listener of its own', async () => {
  const bare = new pg.Pool({ connectionString: db.url, max: 1 });
  try {
    assert.equal(bare.listenerCount('error'), 0);
    await bare.query('SELECT 1');
    const seen = errorsOn(bare); // without this listener, the emit below would be an uncaught exception
    await killBackends();
    const e = await seen;
    assert.match(e.message, /terminat/i);
  } finally {
    await bare.end().catch(() => undefined);
  }
});
