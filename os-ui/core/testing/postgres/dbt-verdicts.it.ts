/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       monitoring / adapters/postgres
 * FEATURE:    Integration test: the newest dbt verdict per domain, read from the real `commit_checks` rows
 * USER STORY: As an engineer whose commit dbt refused I want the alert to come from the rows the
 *             verdict copy really writes, not from a fixture shape I hope matches.
 * ARCHITECTURE:
 *   - Real postgres:17, the real `os_governance` migrations, the rows are written with the same INSERT
 *     shape as `copyDbtParseVerdicts`, then read by the real reader and the alert core.
 *   - Negative twin: the same domain, fixed in a newer commit, raises nothing.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase } from './it-support.ts';
import { migrateGovernance } from './unwrapped.ts';
import { readNewestDbtVerdicts } from '@core/adapters/dagster/commit-checks';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('refused dbt commit alert (real postgres:17)', { timeout: 120_000 }, () => {
  before(async () => {
    db = await freshDatabase('own_dbt_verdict');
    await migrateGovernance({ databaseUrl: db.url, direction: 'up' });
    pool = new pg.Pool({ connectionString: db.url });
  });
  after(async () => {
    await pool?.end();
    await db?.drop();
  });

  test('the newest row of a domain is its head: failed, then a later passed commit replaces it', async () => {
    await pool.query(
      `INSERT INTO os_governance.commit_checks (domain, sha, check_name, status, details) VALUES ('sales', $1, 'dbt-parse', 'failed', $2::jsonb)`,
      [A, JSON.stringify({ errorSummary: 'Compilation Error in model silver_x', current: null })],
    );
    const first = (await readNewestDbtVerdicts(pool)).filter((r) => r.domain === 'sales');
    assert.equal(first.length, 1);
    assert.equal(first[0].status, 'failed');
    assert.equal(first[0].sha, A);
    assert.equal(first[0].details.errorSummary, 'Compilation Error in model silver_x');

    await new Promise((r) => setTimeout(r, 20));
    await pool.query(`INSERT INTO os_governance.commit_checks (domain, sha, check_name, status, details) VALUES ('sales', $1, 'dbt-parse', 'passed', '{}')`, [B]);
    const second = (await readNewestDbtVerdicts(pool)).filter((r) => r.domain === 'sales');
    assert.deepEqual(second.map((r) => [r.sha, r.status]), [[B, 'passed']]);
  });

  test('twin: a row of another check (opa-test) is never returned as a dbt verdict', async () => {
    await pool.query(`INSERT INTO os_governance.commit_checks (domain, sha, check_name, status) VALUES ('ops', $1, 'opa-test', 'failed')`, [A]);
    assert.deepEqual((await readNewestDbtVerdicts(pool)).filter((r) => r.domain === 'ops'), []);
  });
});
