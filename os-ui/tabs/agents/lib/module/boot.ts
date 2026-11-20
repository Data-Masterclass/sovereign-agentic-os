/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53b N2 — the agent-module tables are created by migration at worker boot
 * USER STORY: As the operator I want the tables an agent-module run uses created ONCE by
 *             node-pg-migrate under its advisory lock, never by a run racing another process.
 * ARCHITECTURE:
 *   - Called by `worker/agent-runs.ts` at boot (the worker runs the TypeScript source, so the
 *     migration SQL files are read from disk next to `core/adapters/postgres/migrate.ts`). The
 *     Next.js server bundle never imports this file: a module run there finds the tables or
 *     fails loudly (`module/os-run.ts` `moduleStores`).
 *   - Off unless `AGENT_GRAPH_MODULE`; a failed migration throws (no module run without its tables).
 */
import { config } from '@core/kernel/config';
import { migrateAgentRuns } from '@core/adapters/postgres/migrate';

/**
 * BOOT (os-ui-worker): with `AGENT_GRAPH_MODULE` on, apply the `agent_runs` migrations
 * (node-pg-migrate, advisory lock) so no run ever creates a table. Off → nothing happens and no
 * table exists. A failed migration throws: module runs must not start without their tables.
 */
export async function ensureAgentModuleReady(databaseUrl: string | undefined): Promise<'off' | 'memory' | 'postgres'> {
  if (!config.agentGraphModule) return 'off';
  if (!databaseUrl) return 'memory';
  const r = await migrateAgentRuns({ databaseUrl });
  if (!r.ok) throw new Error(`agent_runs migrations failed: ${r.reason} — ${r.detail}`);
  return 'postgres';
}

