/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    ONE `pg.Pool` per process for the `agent_runs` database
 * USER STORY: As an operator I want the run queue (`run_jobs` / `run_events`) and LangGraph's
 *             `PostgresSaver` to share one connection pool per process, so the database sees one
 *             bounded set of connections from each pod rather than two pools that each grow.
 * ARCHITECTURE:
 *   - `agentRunsPool(url)` returns the process-wide `pg.Pool` for that URL (pinned on
 *     `globalThis`: Next bundles route handlers separately and dev HMR re-evaluates modules).
 *     `PostgresSaver` is constructed on it with its documented constructor
 *     (`new PostgresSaver(pool)`), and `jobs-postgres.ts` runs its SQL on it.
 *   - `pg` is imported lazily so a laptop or a pure test never loads it.
 */
import type { Pool } from 'pg';

/** Connections per process: the worker holds one run at a time; os-ui enqueues, tails and inspects. */
export const AGENT_RUNS_POOL_MAX = 10;

type PoolSlot = { url: string; pool: Promise<Pool> };
const slot = globalThis as unknown as { __osAgentRunsPgPool?: PoolSlot };

/** The process-wide pool for `databaseUrl` (created once, cached per URL). */
export function agentRunsPool(databaseUrl: string): Promise<Pool> {
  const url = databaseUrl.trim();
  if (!url) throw new Error('agentRunsPool: no AGENT_RUNS_DATABASE_URL');
  if (!slot.__osAgentRunsPgPool || slot.__osAgentRunsPgPool.url !== url) {
    const pool = (async () => {
      const { Pool: PgPool } = await import('pg');
      return new PgPool({ connectionString: url, max: AGENT_RUNS_POOL_MAX });
    })();
    slot.__osAgentRunsPgPool = { url, pool };
  }
  return slot.__osAgentRunsPgPool.pool;
}
