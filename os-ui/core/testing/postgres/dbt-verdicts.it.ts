/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       monitoring / adapters/postgres
 * FEATURE:    Integration test: the refused-commit alert reads the real `commit_checks` rows
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
import { collectDbtVerdictAlerts } from '@tabs/monitoring/lib/adapters/dbt-verdicts';

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

  test('a failed verdict row becomes one warning with dbt text; a later passed head clears it', async () => {
    await pool.query(
      `INSERT INTO os_governance.commit_checks (domain, sha, check_name, status, details) VALUES ('sales', $1, 'dbt-parse', 'failed', $2::jsonb)`,
      [A, JSON.stringify({ errorSummary: 'Compilation Error in model silver_x', current: null })],
    );
    const alerts = await collectDbtVerdictAlerts(pool);
    assert.equal(alerts.length, 1, JSON.stringify(alerts));
    assert.equal(alerts[0].domain, 'sales');
    assert.match(alerts[0].detail, /Compilation Error in model silver_x/);

    await new Promise((r) => setTimeout(r, 20));
    await pool.query(`INSERT INTO os_governance.commit_checks (domain, sha, check_name, status, details) VALUES ('sales', $1, 'dbt-parse', 'passed', '{}')`, [B]);
    assert.deepEqual(await collectDbtVerdictAlerts(pool), []);
  });

  test('another check name (opa test) on a failed row raises nothing', async () => {
    await pool.query(`INSERT INTO os_governance.commit_checks (domain, sha, check_name, status) VALUES ('ops', $1, 'opa-test', 'failed')`, [A]);
    assert.deepEqual((await collectDbtVerdictAlerts(pool)).filter((a) => a.domain === 'ops'), []);
  });
});
