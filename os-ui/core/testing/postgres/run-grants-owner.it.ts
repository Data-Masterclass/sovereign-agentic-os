/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       policy / adapters/postgres
 * FEATURE:    Integration test: deactivating an owner ends their run grants and any active window
 * USER STORY: As a data owner's admin I want deactivating a person to stop Dagster acting as them at
 *             once, not at the end of a window that can last up to six hours.
 * ARCHITECTURE:
 *   - Real postgres:17, the real `os_governance` migrations, the real `run-grants.ts` queries.
 *   - Negative twin: another person's grants and active window are untouched.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase } from './it-support.ts';
import { migrateGovernance } from './unwrapped.ts';
import { endRunGrantsOf, reconcileStandingGrants } from '@core/policy/run-grants';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;

describe('ending an owner\'s run grants (real postgres:17)', { timeout: 120_000 }, () => {
  before(async () => {
    db = await freshDatabase('wp15_owner_end');
    await migrateGovernance({ databaseUrl: db.url, direction: 'up' });
    pool = new pg.Pool({ connectionString: db.url });
  });
  after(async () => {
    await pool?.end();
    await db?.drop();
  });

  test('the owner\'s grants are revoked and their open window closes; another owner\'s stay', async () => {
    const ids = await reconcileStandingGrants(pool, 'sales', [
      { dataset: 'ds_a', principal: 'alice', schedule: 'sales__ds_a', enabled: true, job: 'sales__ds_a' },
      { dataset: 'ds_b', principal: 'bob', schedule: 'sales__ds_b', enabled: true, job: 'sales__ds_b' },
    ], 'ada');
    await pool.query(`update os_governance.run_grants set active_run_id = 'run_1', active_until = clock_timestamp() + interval '5 hours' where id = any($1)`, [Object.values(ids)]);

    const n = await endRunGrantsOf(pool, 'alice');
    assert.equal(n, 1);
    const rows = (await pool.query(`select principal_uid, revoked_at, active_run_id, active_until from os_governance.run_grants order by principal_uid`)).rows;
    const alice = rows.find((r) => r.principal_uid === 'alice');
    const bob = rows.find((r) => r.principal_uid === 'bob');
    assert.ok(alice.revoked_at, 'alice\'s grant is revoked');
    assert.equal(alice.active_run_id, null, 'her window is closed');
    assert.equal(alice.active_until, null);
    assert.equal(bob.revoked_at, null, 'bob\'s grant is untouched');
    assert.equal(bob.active_run_id, 'run_1', 'bob\'s window is untouched');
    assert.ok(bob.active_until, 'bob\'s window is untouched');
    assert.equal(await endRunGrantsOf(pool, 'alice'), 0, 'ending twice changes nothing');
  });
});
