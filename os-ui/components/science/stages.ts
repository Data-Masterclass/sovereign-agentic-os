/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The SCIENCE guided path as a shared-core staged model — Define · Train · Deploy ·
 * Predict · Monitor. Pure and framework-free (mirrors lib/dashboards/stages.ts and the
 * Agents PHASES array) so the gating and ✓ rules ride the unit-tested core primitive
 * (lib/core/stages.ts); the React skin is components/science/ModelBuilder.tsx on
 * components/core/StageShell.tsx.
 *
 * Gating is driven DIRECTLY by the persisted model `buildState`
 * (draft → training → trained → deploying → deployed → monitored) — the natural gate
 * source the P0 wave established. You can't Train without a spec; can't Deploy until the
 * model is `trained`; can't Predict until it is `deployed`; Monitor opens once deployed.
 * `completed(ctx)` is each stage's LIVE condition; a stage shows a ✓ only when the user
 * ALSO worked it this session (tracked by the StageState in the component) — so a freshly
 * opened model shows no pre-marked checks, and a check clears if the state regresses.
 */

import type { StageDef } from '@/lib/core/stages';
import type { ModelBuildState } from './shared';

export type SciStageId = 'define' | 'train' | 'deploy' | 'predict' | 'monitor';

/** The live state the science stage gates/✓-conditions read — derived fresh each render. */
export type SciCtx = {
  /** The model has a build spec (name + source + trainable task) — Define is done. */
  hasSpec: boolean;
  /** The persisted buildState — the single source of truth the stages gate on. */
  buildState: ModelBuildState;
  /** A prediction actually ran this session (Predict's completion signal). */
  predicted: boolean;
};

/** Ordinal rank of a buildState on the lifecycle ladder (higher = further along). */
const STATE_RANK: Record<ModelBuildState, number> = {
  draft: 0,
  training: 1,
  trained: 2,
  deploying: 3,
  deploy_failed: 3,
  deployed: 4,
  monitored: 5,
  archived: 0,
};

/** True once the model has reached AT LEAST `min` on the lifecycle ladder. */
export const atLeast = (bs: ModelBuildState, min: ModelBuildState): boolean =>
  STATE_RANK[bs] >= STATE_RANK[min];

/**
 * The five stages. Train needs a spec; Deploy needs a TRAINED model; Predict needs a
 * DEPLOYED model; Monitor opens once deployed (drift/metrics + lifecycle live there).
 * `deploy_failed` still enters Deploy (to retry) but is NOT `deployed`, so Predict/Monitor
 * stay gated — honest about a broken rollout.
 */
export const SCI_STAGES: StageDef<SciStageId, SciCtx>[] = [
  {
    id: 'define',
    title: 'Define',
    hint: 'Name it, pick the governed source dataset, and choose what to learn.',
    completed: (c) => c.hasSpec,
  },
  {
    id: 'train',
    title: 'Train',
    hint: 'Run the governed training job and watch it register a version.',
    enabled: (c) => c.hasSpec,
    completed: (c) => atLeast(c.buildState, 'trained'),
  },
  {
    id: 'deploy',
    title: 'Deploy',
    hint: 'Roll out the trained artifact to its own KServe endpoint.',
    enabled: (c) => c.hasSpec && atLeast(c.buildState, 'trained'),
    completed: (c) => c.buildState === 'deployed' || c.buildState === 'monitored',
  },
  {
    id: 'predict',
    title: 'Predict',
    hint: 'Call the governed predict front door as yourself.',
    enabled: (c) => c.buildState === 'deployed' || c.buildState === 'monitored',
    completed: (c) => c.predicted,
  },
  {
    id: 'monitor',
    title: 'Monitor',
    hint: 'Watch metrics and drift, then promote, archive or version.',
    enabled: (c) => c.buildState === 'deployed' || c.buildState === 'monitored',
    completed: (c) => c.buildState === 'deployed' || c.buildState === 'monitored',
  },
];
