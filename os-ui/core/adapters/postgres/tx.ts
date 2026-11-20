/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    One transaction helper, and the pg-boss `db` adapter for the caller's transaction
 * USER STORY: As an engineer I want a state change and the job it triggers to commit or roll back
 *             together, so a reconcile is never lost and never runs for a change that did not happen.
 * ARCHITECTURE:
 *   - `withTransaction` is BEGIN / COMMIT / ROLLBACK on one checked-out client; the error always
 *     propagates after the rollback.
 *   - `bossDb(client)` is pg-boss's documented `db` interface (`executeSql(text, values)`,
 *     docs/api/jobs.md), bound to that client. Passing it as `send(…, { db })` puts the job
 *     insert in the caller's transaction: that is the outbox (10 F8), with no outbox table.
 */
import type pg from 'pg';

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** pg-boss's `Db` interface over a transaction's client. */
export function bossDb(client: pg.PoolClient): { executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> } {
  return {
    executeSql: async (text, values) => {
      const r = await client.query(text, values as unknown[] | undefined);
      return { rows: r.rows };
    },
  };
}
