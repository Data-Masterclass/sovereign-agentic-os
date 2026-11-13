/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Checkpointer selection — Postgres in the cluster, memory on a laptop, never silent
 * USER STORY: As an operator I want every agent run checkpointed to the `agent_runs` database so
 *             a pod restart or the request cap never loses a run; as a developer without that
 *             database I want runs to still work in memory — and I want the run report to SAY
 *             which one it got, so a memory fallback can never masquerade as durability.
 * ARCHITECTURE:
 *   - One decision: `AGENT_RUNS_DATABASE_URL` (`config.agentRunsDatabaseUrl`) set → `PostgresSaver`
 *     from `@langchain/langgraph-checkpoint-postgres` on that database (its tables are created by
 *     the idempotent `setup()`, run once per process — also at os-ui boot from
 *     `instrumentation.ts`); unset → LangGraph's `MemorySaver`. The chosen kind travels with the
 *     run report (`checkpointer: 'postgres' | 'memory'`).
 *   - Process-wide singletons pinned on `globalThis` (Next dev HMR re-evaluates modules; a fresh
 *     MemorySaver per module instance would lose every in-flight thread). The Postgres package is
 *     imported lazily so a test or laptop never loads `pg`.
 *   - Fail loudly: an unreachable configured database throws here rather than quietly degrading
 *     to memory — a cluster that asked for durability and did not get it must not look healthy.
 */
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';

export type CheckpointerKind = 'postgres' | 'memory';

export type SelectedCheckpointer = { kind: CheckpointerKind; saver: BaseCheckpointSaver };

type Cache = {
  memory?: MemorySaver;
  postgres?: { url: string; ready: Promise<SelectedCheckpointer> };
};

const slot = globalThis as unknown as { __osAgentRunsCheckpointer?: Cache };
function cache(): Cache {
  slot.__osAgentRunsCheckpointer ??= {};
  return slot.__osAgentRunsCheckpointer;
}

/**
 * The checkpointer for this process. `databaseUrl` set → PostgresSaver (set up once, cached per
 * URL); unset/empty → the process-wide MemorySaver. Throws if the configured database cannot be
 * prepared.
 */
export async function selectCheckpointer(databaseUrl: string | undefined): Promise<SelectedCheckpointer> {
  const url = (databaseUrl ?? '').trim();
  const c = cache();
  if (!url) {
    c.memory ??= new MemorySaver();
    return { kind: 'memory', saver: c.memory };
  }
  if (!c.postgres || c.postgres.url !== url) {
    const ready = (async (): Promise<SelectedCheckpointer> => {
      const { PostgresSaver } = await import('@langchain/langgraph-checkpoint-postgres');
      const saver = PostgresSaver.fromConnString(url);
      await saver.setup(); // idempotent: CREATE TABLE IF NOT EXISTS + versioned migrations
      return { kind: 'postgres', saver };
    })();
    c.postgres = { url, ready };
    // A failed setup must not poison the cache forever: drop it so the next call retries.
    ready.catch(() => {
      if (c.postgres?.ready === ready) delete c.postgres;
    });
  }
  return c.postgres.ready;
}

/** Boot-time init: prepare the configured checkpointer (runs `setup()` once). Returns the kind. */
export async function ensureCheckpointerReady(databaseUrl: string | undefined): Promise<CheckpointerKind> {
  return (await selectCheckpointer(databaseUrl)).kind;
}

/** A fresh, private MemorySaver — for tests that must not share the process-wide one. */
export function memoryCheckpointer(): SelectedCheckpointer {
  return { kind: 'memory', saver: new MemorySaver() };
}
