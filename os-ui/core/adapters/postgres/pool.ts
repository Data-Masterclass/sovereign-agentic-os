/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    The process-wide `pg` pool for the `os_governance` database
 * USER STORY: As an operator I want one bounded connection pool per process for governance state,
 *             shared by every module, so a busy page cannot exhaust the database.
 * ARCHITECTURE:
 *   - `pg` (MIT, already pinned 8.23.1), no ORM (00 §3.5).
 *   - One pool per URL, pinned on `globalThis` (Next bundles route handlers separately and dev HMR
 *     re-evaluates modules; a pool per module instance would leak connections). Same pattern as
 *     `tabs/agents/lib/engine/jobs-postgres.ts`.
 *   - No URL → throw. There is no in-memory stand-in for governance state.
 */
import pg from 'pg';

/** What the adapter needs from a pool or a checked-out client: `pg`'s own `query`. */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

type Slot = { url: string; pool: pg.Pool };
const slot = globalThis as unknown as { __osGovernancePool?: Slot };

export function governancePool(databaseUrl: string, max = 8): pg.Pool {
  const url = databaseUrl.trim();
  if (!url) throw new Error('governancePool: no database URL');
  if (!slot.__osGovernancePool || slot.__osGovernancePool.url !== url) {
    const pool = new pg.Pool({ connectionString: url, max });
    slot.__osGovernancePool = { url, pool };
  }
  return slot.__osGovernancePool.pool;
}

export async function closeGovernancePool(): Promise<void> {
  const s = slot.__osGovernancePool;
  delete slot.__osGovernancePool;
  if (s) await s.pool.end();
}
