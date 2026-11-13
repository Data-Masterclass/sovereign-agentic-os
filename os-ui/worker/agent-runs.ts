/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       os-ui entrypoint (outside core/ and tabs/, like `instrumentation.ts`)
 * FEATURE:    The `os-ui-worker` process — agent runs execute here, not in a request
 * USER STORY: As an operator I want agent runs to finish regardless of how long they take and to
 *             survive a rolling restart: a pod whose only job is to drain `run_jobs`, with the SAME
 *             boot hooks os-ui has (so an approval decided anywhere resumes the run here), and a
 *             SIGTERM that finishes the current superstep and puts the run back on the queue.
 * ARCHITECTURE:
 *   - Boot parity with `instrumentation.ts`: the secret guard, the approval→resume hook, the
 *     checkpointer `setup()`, the `run_jobs` migrations, the approvals queue hydrated from its
 *     durable mirror, and the Langfuse singleton (whose own SIGTERM flush lives in
 *     `core/infra/langfuse.ts`). Everything the run path needs, nothing the HTTP path needs.
 *   - Then `startAgentRunsWorker()` (`tabs/agents/lib/build/run-jobs-server.ts`) — the SAME
 *     executor the inline mode uses, so there is one code path for a run and one for a resume.
 *   - This file may import the Agents tab: it is an entrypoint, not kernel code (`core/` still
 *     never imports a tab).
 *   - Run by `worker/start.mjs`, which registers the module resolver the `@core/*` / `@tabs/*`
 *     path aliases need and then imports this file under Node's type stripping.
 *   - NOT A REPO WRITER (Part D review H-3): the `os-repos` PVC is ReadWriteOnce, so only os-ui
 *     can mount it; this pod therefore marks itself and REFUSES agent-system definition writes
 *     with a typed error rather than applying them with no commit. Run bookkeeping still writes.
 *   - LIVENESS (A4 review L-2): the pod serves no HTTP, so the probe reads the FRESHNESS of
 *     `AGENTS_WORKER_ALIVE_FILE`, which an unref'd 15-second interval here touches. An interval
 *     only fires while the event loop turns, so a stale file means a wedged process — which is
 *     exactly what liveness should catch, and what `node -e 'process.exit(0)'` never could.
 */
import { writeFileSync } from 'node:fs';
import { startAgentRunsWorker } from '@tabs/agents/lib/build/run-jobs-server';

export type WorkerBoot = {
  checkpointer: 'postgres' | 'memory';
  jobs: 'postgres' | 'memory';
  resumeHook: boolean;
  approvals: boolean;
  langfuse: boolean;
};

const log = (m: string) => console.info(`[agent-runs-worker] ${m}`);
const warn = (m: string) => console.warn(`[agent-runs-worker] ${m}`);

/** How often the liveness heartbeat file is touched. The probe allows 2x the probe period (60 s). */
export const ALIVE_EVERY_MS = 15_000;

/**
 * Touch `AGENTS_WORKER_ALIVE_FILE` every `everyMs` so the liveness probe can tell a working
 * process from a wedged one. Unref'd: it never keeps the process alive by itself, and a write
 * failure (a read-only /tmp) is logged ONCE rather than crash-looping the pod — a missing file
 * fails the probe, which is the honest outcome.
 */
export function startAliveHeartbeat(path = (process.env.AGENTS_WORKER_ALIVE_FILE ?? '').trim(), everyMs = ALIVE_EVERY_MS): () => void {
  if (!path) return () => undefined;
  let complained = false;
  const touch = () => {
    try {
      writeFileSync(path, `${Date.now()}\n`);
    } catch (err) {
      if (!complained) {
        complained = true;
        warn(`liveness heartbeat file '${path}' is not writable — the probe will restart this pod: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  touch();
  const timer = setInterval(touch, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Register the boot hooks a run needs. Fail-soft per hook, LOUD on failure — but a worker with no
 * durable store is a lie, so an unreachable `agent_runs` database stops the process (the pod
 * crash-loops and the deploy is visibly broken) rather than draining runs into memory.
 */
export async function bootWorker(): Promise<WorkerBoot> {
  const { config } = await import('@core/kernel/config');
  // Deliberately NOT the dev-default-secret guard from instrumentation.ts: it protects the session
  // cookie and MCP token signing secrets, and this process signs neither. Its env carries no
  // OS_SESSION_SECRET / OS_MCP_TOKEN_SECRET on purpose (A4 review M-4 keeps every admin secret
  // out of the run path), so the guard would — and on the first 0.8.0 worker rollout did —
  // refuse to boot a correctly configured worker. The secret this process DOES depend on, the
  // scoped LiteLLM agent key, fails closed per call in core/infra/litellm-credential.ts.

  // FAIL CLOSED ON AGENT-SYSTEM WRITES (Part D review H-3). This pod mounts no `os-repos` volume
  // — the PVC is ReadWriteOnce and os-ui owns it — and carries no `DATA_PROJECT_GIT`, so a
  // DEFINITION change made here could never be committed or mirrored: the repository would
  // silently stop being true. Marking the process makes every committable store write throw a
  // typed `SystemWriteUnavailableError` instead. Run and build BOOKKEEPING (the activity marker,
  // the run checkpoint, the last-run report — `writeThrough(rec, null)`) is unaffected: it is
  // deliberately not a commit, and it is this pod's whole job.
  const { markRunWorkerProcess } = await import('@tabs/agents/lib/write-availability');
  markRunWorkerProcess();
  log('agent-system DEFINITION writes are refused in this process (no os-repos mount — RWO, os-ui only); run bookkeeping is unaffected');

  const boot: WorkerBoot = { checkpointer: 'memory', jobs: 'memory', resumeHook: false, approvals: false, langfuse: false };

  // The approval → resume hook: a decision taken in os-ui enqueues a `resume` job, and a decision
  // taken here (MCP through the worker is not served, but the hook must exist for symmetry) does
  // the same. Registering it in BOTH pods keeps one code path.
  try {
    const { registerResumeHook } = await import('@tabs/agents/lib/engine/resume-boot');
    registerResumeHook();
    boot.resumeHook = true;
  } catch (err) {
    console.error(`[agent-runs-worker] approval-resume hook NOT registered: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The approvals queue, rebuilt from its durable mirror — the tools node re-reads each approval
  // on every re-run, so a cold worker must not see an empty queue (A3 review M-A).
  try {
    const { ensureHydrated } = await import('@core/policy/approvals');
    await ensureHydrated();
    boot.approvals = true;
  } catch (err) {
    warn(`approvals queue not hydrated (held writes may re-park): ${err instanceof Error ? err.message : String(err)}`);
  }

  // The LangGraph checkpoint store — without it a run cannot survive this pod, which is the whole
  // point of the worker.
  const { ensureCheckpointerReady } = await import('@tabs/agents/lib/engine/checkpointer');
  boot.checkpointer = await ensureCheckpointerReady(config.agentRunsDatabaseUrl);
  if (boot.checkpointer === 'memory') warn('AGENT_RUNS_DATABASE_URL unset — checkpoints are IN MEMORY; a restart loses in-flight runs');

  // `run_jobs` / `run_events` (idempotent DDL), next to the checkpointer's setup().
  const { ensureRunJobsReady } = await import('@tabs/agents/lib/build/run-jobs-server');
  boot.jobs = await ensureRunJobsReady();
  if (boot.jobs === 'memory') warn('the run queue is IN MEMORY — this process can only execute jobs it filed itself');

  // The Langfuse singleton (its SIGTERM flush is registered on construction).
  try {
    const { langfuseClient } = await import('@core/infra/langfuse');
    boot.langfuse = langfuseClient() !== null;
    if (!boot.langfuse) log('Langfuse not configured — runs execute untraced');
  } catch (err) {
    warn(`Langfuse client unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  log(`boot: checkpointer=${boot.checkpointer} jobs=${boot.jobs} resumeHook=${boot.resumeHook} approvals=${boot.approvals} langfuse=${boot.langfuse}`);
  return boot;
}

/** Boot, drain until SIGTERM/SIGINT, then exit once the current superstep has been checkpointed. */
export async function main(): Promise<void> {
  await bootWorker();
  const stopAlive = startAliveHeartbeat();
  const handle = startAgentRunsWorker();
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} — finishing the current superstep, then exiting (the run returns to the queue)`);
    handle.stop();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  await handle.done;
  stopAlive();
  try {
    const { flushLangfuse } = await import('@core/infra/langfuse');
    await flushLangfuse();
  } catch { /* nothing to flush */ }
  log('exiting cleanly');
}
