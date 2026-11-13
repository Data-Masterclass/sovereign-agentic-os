/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    The agent WORKER flag — who executes a queued agent run
 * USER STORY: As a platform operator I want a laptop or kind install (one os-ui pod, no worker)
 *             to execute agent runs exactly as before, and a cluster with the `os-ui-worker`
 *             Deployment to execute them off-request in that worker, with ONE env var deciding
 *             which — and a mistyped value must fall back to the mode that needs no extra pod.
 * ARCHITECTURE:
 *   - Pure: a closed union + one parser; `core/kernel/config.ts` reads AGENTS_WORKER once and
 *     passes the raw string in. The kernel never imports the Agents tab, so the union lives here
 *     and `tabs/agents/lib/build/run-jobs-server.ts` consumes it.
 *   - `inline`: every door (run route, scheduler, MCP, the approval-resume hook) enqueues the job
 *     in the `run_jobs` store AND executes it at once in the same process, writing the same
 *     `run_events`. Behaviour is identical to worker mode from the outside; tests need no worker.
 *   - `worker`: the doors only enqueue and tail; `os-ui/worker/agent-runs.ts` claims and executes.
 */

export type AgentsWorkerMode = 'inline' | 'worker';

export const AGENTS_WORKER_MODES: readonly AgentsWorkerMode[] = ['inline', 'worker'];

/** The default needs no worker pod: the process that enqueues also executes. */
export const DEFAULT_AGENTS_WORKER_MODE: AgentsWorkerMode = 'inline';

export function isAgentsWorkerMode(v: unknown): v is AgentsWorkerMode {
  return typeof v === 'string' && (AGENTS_WORKER_MODES as readonly string[]).includes(v);
}

/** Parse AGENTS_WORKER. Case-insensitive, trimmed; unknown/unset → {@link DEFAULT_AGENTS_WORKER_MODE}. */
export function parseAgentsWorkerMode(raw: string | undefined): AgentsWorkerMode {
  const v = (raw ?? '').trim().toLowerCase();
  return isAgentsWorkerMode(v) ? v : DEFAULT_AGENTS_WORKER_MODE;
}
