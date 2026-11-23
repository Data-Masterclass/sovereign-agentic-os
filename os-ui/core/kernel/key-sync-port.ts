/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    The seam for "bring the agent system's key up to date before this run"
 * USER STORY: As the owner a run never fails because the system's model key lags behind its definition.
 * ARCHITECTURE:
 *   - The run queue (`enqueueRun`, every run door) calls `preRunKeySync` — a kernel seam, so the run path never imports
 *     the gateway's ADMIN code (the master key stays out of the runtime and the worker: glue rule GLUE-2).
 *   - The web process registers the implementation at boot (`instrumentation.ts` → `syncDerivedKeyFieldsLive`,
 *     `tabs/agents/lib/build/key-reconcile.ts`). The worker registers nothing: there the seam does nothing, and the
 *     gateway answers the run itself — exactly as when the gateway cannot be reached.
 *   - Never throws into a run: an implementation that fails is logged and the run goes on.
 */

export type PreRunKeySync = (systemId: string, actor: string) => Promise<unknown>;

const SLOT = Symbol.for('soa.kernel.pre-run-key-sync');
type Slot = { fn?: PreRunKeySync };
const slot = (): Slot => {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>;
  g[SLOT] ??= {};
  return g[SLOT]!;
};

/** Register the implementation (the web process, at boot). A second registration replaces the first. */
export function registerPreRunKeySync(fn: PreRunKeySync | undefined): void {
  slot().fn = fn;
}

/** Bring the system key's OS-derived fields up to date before a run, when this process can. Never throws. */
export async function preRunKeySync(systemId: string, actor: string): Promise<'synced-or-checked' | 'not-registered' | 'failed'> {
  const fn = slot().fn;
  if (!fn) return 'not-registered';
  try {
    await fn(systemId, actor);
    return 'synced-or-checked';
  } catch (e) {
    console.warn(`[key-sync] pre-run-sync '${systemId}' failed: ${e instanceof Error ? e.message : String(e)} — the run goes on; the gateway answers it`);
    return 'failed';
  }
}
