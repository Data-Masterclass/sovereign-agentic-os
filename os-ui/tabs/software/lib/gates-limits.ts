/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - limits on gates runs (one per app, a ceiling per user)
 * USER STORY: As the platform owner I want a run of the gates to cost one Job at a time per app, and a person
 *             (or an agent acting for them) to be unable to start an unbounded number of them.
 * ARCHITECTURE:
 *   - Per app: one run in progress. A new request SUPERSEDES the old one: the old run's AbortSignal fires and
 *     Tekton cancels the old PipelineRun (`spec.status: Cancelled`, tekton-checks.ts; that is what supersedes
 *     across os-ui replicas).
 *   - Per user: at most {@link MAX_GATE_RUNS_PER_USER} runs in progress (across different apps); the next is
 *     refused with 429. Counts are per os-ui process: a documented best effort, the per-app supersede is
 *     the cluster-wide guarantee.
 *   - PURE (in-memory).
 */
const MAX = Number(process.env.SOFTWARE_GATES_MAX_PER_USER ?? '') || 2;
export const MAX_GATE_RUNS_PER_USER = MAX;

type Slot = { userId: string; appId: string; ac: AbortController };
const bySlot = new Map<string, Slot>(); // appId -> the run in progress

export type GateSlot = { signal: AbortSignal; release: () => void };

export function acquireGateSlot(who: { userId: string; appId: string }): GateSlot {
  const active = [...bySlot.values()].filter((s) => s.userId === who.userId && s.appId !== who.appId).length;
  if (active >= MAX_GATE_RUNS_PER_USER) {
    const err = new Error(`too many quality-gate runs in progress for you (${active}, the limit is ${MAX_GATE_RUNS_PER_USER}); wait for one to finish or re-run the same app, which replaces its run`) as Error & { status?: number };
    err.status = 429;
    throw err;
  }
  bySlot.get(who.appId)?.ac.abort(); // supersede the run in progress for this app, only once this one is admitted
  const slot: Slot = { userId: who.userId, appId: who.appId, ac: new AbortController() };
  bySlot.set(who.appId, slot);
  return { signal: slot.ac.signal, release: () => { if (bySlot.get(who.appId) === slot) bySlot.delete(who.appId); } };
}

export function __resetGateSlots(): void {
  bySlot.clear();
}
