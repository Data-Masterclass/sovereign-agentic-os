/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The ONE honest derivation of the app-pipeline status — the single source of
 * truth BOTH the Test stage (granular Scaffold→…→Live stepper) and the Publish
 * stage (rolled-up deploy badge) read, so the two surfaces can NEVER disagree.
 *
 * Pure + client-safe (no server imports): the raw per-stage `app.pipeline`
 * record + the reconciled `deploy` fields go in, the resolved steps/summary come
 * out. The React components are thin skins over this.
 *
 * The bug this fixes: Test used to read `app.pipeline` DIRECTLY and Publish read
 * `deploy.state` — two sources. A demonstrably LIVE app (its pod is running, a
 * release shipped) could still show its "Build image (CI)" stage as not-complete
 * in Test, because `pipeline.actions` only turns 'ok' when the LATEST head commit
 * has a matching successful Actions run — a post-live edit, a fast/cached build,
 * or a run not yet reconciled for the exact head sha leaves it 'pending'/'stalled'.
 * Publish showed green (live) at the same time. That is inconsistent AND wrong.
 *
 * The honest rule, applied identically to both surfaces: a LIVE, SERVING app
 * (deploy.state === 'live' AND at least one release shipped) PROVABLY built,
 * published and deployed — so every upstream stage is complete. We derive that
 * from real state; we do NOT force-green a stage on a non-live app. A genuinely
 * incomplete/failed pipeline surfaces the SAME marked stage + message in both.
 */

import type { StepState, Step } from '@/lib/core/progress-stepper';

/** The five pipeline stages, in order. */
export const PIPELINE_STAGES = ['forgejo', 'actions', 'harbor', 'argocd', 'live'] as const;
export type PipelineStageId = (typeof PIPELINE_STAGES)[number];

/** Human labels for each stage (the Test stepper shows these). */
export const PIPELINE_STAGE_LABEL: Record<PipelineStageId, string> = {
  forgejo: 'Scaffold repo',
  actions: 'Build image (CI)',
  harbor: 'Publish to registry',
  argocd: 'Deploy',
  live: 'Live / health',
};

/** The reconciled deploy facts the derivation needs — nothing server-side. */
export type DeployFacts = {
  state: 'building' | 'preview' | 'review' | 'live';
  releases: number;
};

/**
 * A LIVE, SERVING app: the reconciled deploy state is `live` AND a release has
 * shipped. Such an app provably passed every upstream stage (a pod can't run an
 * image that was never built, published or deployed), so its stages are honestly
 * all complete regardless of a stale/cached per-stage CI status.
 */
export function isServingLive(deploy: DeployFacts): boolean {
  return deploy.state === 'live' && deploy.releases > 0;
}

/** Map ONE raw stage status string to a stepper state (before live-reconcile). */
function rawStageState(status: string): StepState {
  if (status === 'ok' || status === 'disabled') return 'done';
  if (status === 'offline' || status === 'failing' || status === 'stalled') return 'fail';
  return 'pending'; // 'pending' and any unknown/in-progress status
}

export type PipelineView = {
  steps: Step[];
  /** True while the pipeline is still in flight (nothing failed, not all done). */
  active: boolean;
  /** True once settled (all done, or a stage failed). */
  done: boolean;
  /** True when no stage failed. */
  ok: boolean;
  /** The single commentary line — IDENTICAL wording is used in Test and Publish. */
  commentary: string;
};

/** The complete-message and the incomplete-message, shared so both surfaces match. */
export const PIPELINE_MSG = {
  building: 'Building & deploying…',
  complete: 'Build & deploy complete.',
  incompletePrefix: 'A build/deploy stage did not complete — see the marked stage',
  // A live app whose LATEST build FAILED: the running pod serves an EARLIER release,
  // so recent commits are NOT deployed. This must be LOUD — it is the "looks fine
  // until you open the app" trap. Named stage is appended by the caller.
  staleLivePrefix:
    'The latest build FAILED — the app is live on an EARLIER release, so your recent changes are NOT deployed. Fix the build error and re-commit',
} as const;

/**
 * Derive the honest pipeline view from the raw per-stage record + reconciled
 * deploy facts. This is the shared source of truth for Test and Publish.
 *
 * When the app is serving live, EVERY stage is 'done' (earned from the running
 * pod). Otherwise each stage reflects its real recorded status, and the first
 * still-incomplete stage is the 'active' one; a failed stage marks the run failed.
 */
export function derivePipelineView(pipeline: Record<string, string>, deploy: DeployFacts): PipelineView {
  const serving = isServingLive(deploy);
  let firstPendingSeen = false;
  const steps: Step[] = PIPELINE_STAGES.map((s) => {
    const raw = pipeline[s] ?? 'pending';
    // Live-and-serving ⇒ this stage is provably complete — EXCEPT one that is
    // genuinely FAILING (the latest CI run failed). Force-greening a `failing`
    // stage would hide that the live pod is serving an EARLIER release while new
    // commits don't deploy. A merely pending/stalled stage on a live app IS benign
    // reconcile-lag (a post-live edit / fast-cached build), so keep force-greening it.
    if (serving && raw !== 'failing') return { key: s, label: PIPELINE_STAGE_LABEL[s], state: 'done' as StepState };
    let state = rawStageState(raw);
    if (state === 'pending') {
      state = firstPendingSeen ? 'pending' : 'active';
      firstPendingSeen = true;
    }
    return { key: s, label: PIPELINE_STAGE_LABEL[s], state };
  });

  const failedStep = steps.find((st) => st.state === 'fail');
  const anyPending = steps.some((st) => st.state === 'active' || st.state === 'pending');
  const done = !!failedStep || !anyPending;
  const ok = !failedStep;

  let commentary: string;
  if (!done) commentary = PIPELINE_MSG.building;
  else if (ok) commentary = PIPELINE_MSG.complete;
  // A live-and-serving app with a failed stage = the latest build broke; be explicit
  // that the app is stuck on an older release (not merely "a stage didn't complete").
  else if (serving) commentary = `${PIPELINE_MSG.staleLivePrefix}: ${failedStep!.label}.`;
  else commentary = `${PIPELINE_MSG.incompletePrefix}: ${failedStep!.label}.`;

  return { steps, active: !done, done, ok, commentary };
}
