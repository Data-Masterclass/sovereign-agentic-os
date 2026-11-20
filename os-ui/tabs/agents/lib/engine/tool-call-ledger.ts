/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The tool-call ledger: a governed call, keyed by its idempotency key, runs at most
 *             once across worker deaths
 * USER STORY: As an approver I want an approved write to happen once, even if the worker dies
 *             after the write committed but before LangGraph recorded the step. LangGraph writes a
 *             superstep's results only after the step returns, so a replay re-runs the call.
 *             `durability: 'sync'` cannot close that window; a durable record of the call can.
 * ARCHITECTURE:
 *   - `tools_<id>` passes every governed call an idempotency key: `<thread>:<node>#<visit>.<round>:<callId>`,
 *     deterministic for the same call on any replay of its superstep.
 *   - `withToolCallLedger(executor, ledger)` is the governed executor's door. It writes `started`
 *     BEFORE dispatch and `done` with the result after. On a repeat of the same key:
 *       · `done` → the recorded result is returned and nothing is dispatched;
 *       · `started` (the worker died mid-call, so the outcome is unknown) → a WRITE is NOT sent
 *         again: the model gets the typed `unresolved_previous_call` result and is told to read
 *         first (at most once). A READ is dispatched again, since re-reading is free.
 *   - The Postgres ledger is the `tool_call_ledger` table in the `agent_runs` database, on the
 *     process's shared pool. Its rows are deleted with their run by the retention sweep
 *     (`deleteRunLedger`). The memory ledger is for laptops and pure tests.
 *   - What this guarantees: a governed WRITE is dispatched AT MOST ONCE per call, whatever dies
 *     when; and EXACTLY ONCE when the worker survives the dispatch. If the worker dies during the
 *     dispatch, whether the target system applied the write is unknown: the agent is told so
 *     (typed `unresolved_previous_call`) and the call is never re-sent. A READ is at least once.
 */
import type { ToolExecutor } from '@core/runtime/agentic';
import { isWriteTool } from '@tabs/agents/lib/build/hold';
import { unresolvedReplay } from '@tabs/agents/lib/engine/tool-result';

export type LedgerResult = { text: string; isError: boolean };
export type LedgerBegin = { state: 'new' } | { state: 'started' } | { state: 'done'; result: LedgerResult };

export type ToolCallLedger = {
  /** Record `started` for a new key; for an existing key, say what is on record. */
  begin(key: string, tool: string): Promise<LedgerBegin>;
  /** Record the result of the call. */
  finish(key: string, result: LedgerResult): Promise<void>;
};

/** The governed executor with the ledger in front of it. Calls without a key pass straight through. */
export function withToolCallLedger(exec: ToolExecutor, ledger: ToolCallLedger): ToolExecutor {
  return async (name, args, ctx) => {
    const key = ctx?.idempotencyKey;
    if (!key) return exec(name, args, ctx);
    const seen = await ledger.begin(key, name);
    if (seen.state === 'done') return seen.result;
    if (seen.state === 'started' && isWriteTool(name)) return unresolvedReplay(name);
    const out = await exec(name, args, ctx);
    await ledger.finish(key, { text: out.text, isError: out.isError });
    return out;
  };
}

/** In-process ledger (memory checkpointer, tests). */
export function memoryToolCallLedger(): ToolCallLedger & { rows: Map<string, { tool: string; result?: LedgerResult }> } {
  const rows = new Map<string, { tool: string; result?: LedgerResult }>();
  return {
    rows,
    async begin(key, tool) {
      const r = rows.get(key);
      if (!r) {
        rows.set(key, { tool });
        return { state: 'new' };
      }
      return r.result ? { state: 'done', result: r.result } : { state: 'started' };
    },
    async finish(key, result) {
      const r = rows.get(key);
      rows.set(key, { tool: r?.tool ?? '', result });
    },
  };
}

/** The minimum of `pg.Pool` the ledger uses. */
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> };

/** Idempotent DDL for the ledger table. */
export async function migrateToolCallLedger(db: Queryable): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS tool_call_ledger (
     call_key    TEXT PRIMARY KEY,
     thread_id   TEXT        NOT NULL,
     tool        TEXT        NOT NULL,
     result      JSONB,
     started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     finished_at TIMESTAMPTZ)`);
  await db.query(`CREATE INDEX IF NOT EXISTS tool_call_ledger_thread ON tool_call_ledger (thread_id)`);
}

/** The thread a key belongs to (the key starts with `<thread>:`). */
function threadOf(key: string): string {
  const i = key.indexOf(':');
  return i > 0 ? key.slice(0, i) : key;
}

/** The durable ledger in the `agent_runs` database. Call `migrateToolCallLedger` first. */
export function postgresToolCallLedger(db: Queryable): ToolCallLedger {
  return {
    async begin(key, tool) {
      const ins = await db.query(
        `INSERT INTO tool_call_ledger (call_key, thread_id, tool) VALUES ($1, $2, $3) ON CONFLICT (call_key) DO NOTHING RETURNING call_key`,
        [key, threadOf(key), tool],
      );
      if (ins.rows.length > 0) return { state: 'new' };
      const { rows } = await db.query(`SELECT result FROM tool_call_ledger WHERE call_key = $1`, [key]);
      const result = rows[0]?.result as LedgerResult | null | undefined;
      return result ? { state: 'done', result } : { state: 'started' };
    },
    async finish(key, result) {
      await db.query(`UPDATE tool_call_ledger SET result = $2, finished_at = now() WHERE call_key = $1`, [key, JSON.stringify(result)]);
    },
  };
}

/** RETENTION: drop a run's ledger rows with the run. */
export async function deleteRunLedger(db: Queryable, threadIds: readonly string[]): Promise<number> {
  if (threadIds.length === 0) return 0;
  const r = await db.query(`DELETE FROM tool_call_ledger WHERE thread_id = ANY($1)`, [threadIds]);
  return r.rowCount ?? 0;
}

type LedgerSlot = { memory?: ToolCallLedger; postgres?: { url: string; ready: Promise<ToolCallLedger> } };
const slot = globalThis as unknown as { __osToolCallLedger?: LedgerSlot };

/**
 * The ledger for this process, chosen like the checkpointer: `AGENT_RUNS_DATABASE_URL` set → the
 * Postgres ledger on the shared pool (DDL once); unset → the process-wide memory ledger.
 */
export async function selectToolCallLedger(databaseUrl: string | undefined): Promise<ToolCallLedger> {
  const url = (databaseUrl ?? '').trim();
  slot.__osToolCallLedger ??= {};
  const c = slot.__osToolCallLedger;
  if (!url) {
    c.memory ??= memoryToolCallLedger();
    return c.memory;
  }
  if (!c.postgres || c.postgres.url !== url) {
    const ready = (async () => {
      const { agentRunsPool } = await import('@tabs/agents/lib/engine/pg-pool');
      const pool = (await agentRunsPool(url)) as unknown as Queryable;
      await migrateToolCallLedger(pool);
      return postgresToolCallLedger(pool);
    })();
    c.postgres = { url, ready };
    ready.catch(() => {
      if (c.postgres?.ready === ready) delete c.postgres;
    });
  }
  return c.postgres.ready;
}
