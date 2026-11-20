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
 *     docs/api/constructor.md and jobs.md), bound to that client, returning `pg`'s result as is. Passing it as `send(…, { db })` puts the job
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

/**
 * pg-boss's `db` interface over a transaction's client. pg-boss documents (constructor.md, `db`,
 * at 12.38.2) that some of its texts hold several statements and that `executeSql` must then
 * return EVERY statement's result, as an array, "the way `pg` does". So this returns `pg`'s own
 * result unchanged: one `Result` for one statement, `Result[]` for several. (pg-boss's published
 * `IDatabase` type says `{ rows }` only; the documented contract is the wider one.)
 */
export function bossDb(client: pg.PoolClient): { executeSql(text: string, values?: unknown[]): Promise<{ rows: any[] }> } {
  return {
    executeSql: (text, values) => client.query(text, values as unknown[] | undefined) as unknown as Promise<{ rows: any[] }>,
  };
}
