/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    The process-wide `pg` pool for the `os_governance` database, its transactions, its
 *             health, and the one mapping from a Postgres error to the adapter contract
 * USER STORY: As an operator I want one bounded connection pool per process for governance state,
 *             and a database that is down, refusing or rejecting a write to show up as exactly
 *             that, with Postgres's own reason, never as an empty result.
 * ARCHITECTURE:
 *   - `pg` (MIT, already pinned 8.23.1), no ORM (00 §3.5).
 *   - One pool per URL, pinned on `globalThis` (Next bundles route handlers separately and dev HMR
 *     re-evaluates modules; a pool per module instance would leak connections). Same pattern as
 *     `tabs/agents/lib/engine/jobs-postgres.ts`. No URL → throw: there is no in-memory stand-in.
 *   - `pgFailure` maps a `pg` error to the `Fetched` contract (`core/adapters/_contract.ts`) by
 *     SQLSTATE class, keeping the SQLSTATE in `detail` so callers and tests can still see it.
 *   - `withTransaction` is BEGIN / COMMIT / ROLLBACK on one checked-out client. The caller's error
 *     always propagates; if the ROLLBACK itself fails, the connection is destroyed (never returned
 *     to the pool in an unknown state) and both errors are thrown together.
 *   - `governanceHealth` reports the version the server itself states (GLUE-4).
 *   - `agentRunsPool(url)`: the ONE process-wide pool for the `agent_runs` database, shared by the
 *     run queue, LangGraph's `PostgresSaver` (`new PostgresSaver(pool)`) and the agent-system key
 *     store. `configuredAgentRunsDatabaseUrl()` is the one read of `AGENT_RUNS_DATABASE_URL` for
 *     callers outside the adapters (GLUE-1).
 */
import pg from 'pg';
import type { ComponentHealth, Fetched, FetchedFailure } from '@core/adapters/_contract';
import { config } from '@core/kernel/config';

/** What the adapter needs from a pool or a checked-out client: `pg`'s own `query`. */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

type Slot = { url: string; pool: pg.Pool };
const slot = globalThis as unknown as { __osGovernancePool?: Slot };

/** Small on purpose: see the connection budget in `boss.ts`. */
export const GOVERNANCE_POOL_MAX = 4;

export function governancePool(databaseUrl: string, max = GOVERNANCE_POOL_MAX): pg.Pool {
  const url = databaseUrl.trim();
  if (!url) throw new Error('governancePool: no database URL');
  if (!slot.__osGovernancePool || slot.__osGovernancePool.url !== url) {
    const pool = new pg.Pool({ connectionString: url, max });
    slot.__osGovernancePool = { url, pool };
  }
  return slot.__osGovernancePool.pool;
}

/**
 * The runtime pool from `OS_GOVERNANCE_DATABASE_URL` (chart: the DML-only runtime login), used by
 * the os-grants OPA bundle (WP-11). Unset → throw: there is no in-memory stand-in.
 */
export function governanceRuntimePool(): pg.Pool {
  const url = config.governanceDatabaseUrl;
  if (!url) throw new Error('OS_GOVERNANCE_DATABASE_URL is not set — the governance database is not configured');
  return governancePool(url);
}

export async function closeGovernancePool(): Promise<void> {
  const s = slot.__osGovernancePool;
  delete slot.__osGovernancePool;
  if (s) await s.pool.end();
}

const now = () => new Date().toISOString();

/** A `pg` error as the contract's failure: reason by SQLSTATE class, SQLSTATE first in `detail`. */
export function pgFailure(err: unknown): { ok: false; reason: FetchedFailure; detail: string; at: string } {
  const e = err as { code?: string; message?: string };
  const code = typeof e?.code === 'string' ? e.code : '';
  const message = e?.message ?? String(err);
  let reason: FetchedFailure;
  if (code === '42501') reason = 'forbidden';
  else if (code === '28P01' || code === '28000') reason = 'unauthorized';
  else if (code === '57014') reason = 'timeout';
  else if (code === '40001' || code === '40P01' || code === '23505') reason = 'conflict';
  else if (/^[0-9A-Z]{5}$/.test(code) && !code.startsWith('08') && !code.startsWith('57P')) reason = 'invalid';
  else reason = 'unreachable'; // connection-level (08xxx, 57Pxx) or a socket error without SQLSTATE
  return { ok: false, reason, detail: code ? `${code} ${message}` : message, at: now() };
}

export function fetchedOk<T>(value: T): Fetched<T> {
  return { ok: true, value, at: now() };
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: unknown;
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      broken = rollbackErr;
      throw new AggregateError([err, rollbackErr], 'withTransaction: the transaction failed and so did its ROLLBACK');
    }
    throw err;
  } finally {
    client.release(broken instanceof Error ? broken : undefined); // an Error destroys the connection
  }
}

/** The server's own version string, or why it could not be read. */
export async function governanceHealth(db: Queryable): Promise<Fetched<ComponentHealth>> {
  try {
    const r = await db.query(`select current_setting('server_version') as v`);
    return fetchedOk({ version: String(r.rows[0].v), status: 'ready' });
  } catch (err) {
    return pgFailure(err);
  }
}

// ------------------------------------------------------------- agent_runs ----

/** Connections per process: the worker holds one run at a time; os-ui enqueues, tails and inspects. */
export const AGENT_RUNS_POOL_MAX = 10;

type PoolSlot = { url: string; pool: Promise<pg.Pool> };
const runsSlot = globalThis as unknown as { __osAgentRunsPgPool?: PoolSlot };

/** The process-wide pool for `databaseUrl` (created once, cached per URL). */
export function agentRunsPool(databaseUrl: string): Promise<pg.Pool> {
  const url = databaseUrl.trim();
  if (!url) throw new Error('agentRunsPool: no AGENT_RUNS_DATABASE_URL');
  if (!runsSlot.__osAgentRunsPgPool || runsSlot.__osAgentRunsPgPool.url !== url) {
    const pool = Promise.resolve(new pg.Pool({ connectionString: url, max: AGENT_RUNS_POOL_MAX }));
    runsSlot.__osAgentRunsPgPool = { url, pool };
  }
  return runsSlot.__osAgentRunsPgPool.pool;
}

/** The configured `agent_runs` database URL, trimmed; '' when there is none (a laptop: memory). */
export function configuredAgentRunsDatabaseUrl(): string {
  return (config.agentRunsDatabaseUrl ?? '').trim();
}
