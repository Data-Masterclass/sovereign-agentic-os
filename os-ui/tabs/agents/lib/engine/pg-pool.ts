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
 *   - The pool itself lives in `core/adapters/postgres/pool.ts` (GLUE-1); this module
 *     re-exports it for the agents tab.
 */
export { agentRunsPool, AGENT_RUNS_POOL_MAX } from '@core/adapters/postgres/pool';
