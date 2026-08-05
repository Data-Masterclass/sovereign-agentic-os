/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The SCIENCE guided path as a shared-core staged model — Design · Launch · Monitor.
 * Pure and framework-free (mirrors lib/dashboards/stages.ts and the Agents PHASES array) so
 * the gating and ✓ rules ride the unit-tested core primitive (lib/core/stages.ts); the React
 * skin is components/science/ModelBuilder.tsx on components/core/StageShell.tsx.
 *
 * Three plain-language stages for a business user:
 *   • Design  — describe the goal (chat) or pick a dataset + target/features by hand.
 *   • Launch  — one "Train & launch" that reads → trains → publishes (auto-deploy fused).
 *   • Monitor — try the deployed model on a real row, watch health + real usage, govern it.
 *
 * Gating is driven DIRECTLY by the persisted model `buildState`: you can't Launch without a
 * spec; Monitor opens once the model is `deployed`. `completed(ctx)` is each stage's LIVE
 * condition; a stage shows a ✓ only when the user ALSO worked it this session (tracked by the
 * StageState in the component).
 */

import type { StageDef } from '@/lib/core/stages';
import type { ModelBuildState } from './shared';

export type SciStageId = 'design' | 'launch' | 'monitor';

/** The live state the science stage gates/✓-conditions read — derived fresh each render. */
export type SciCtx = {
  /** The model has a build spec (name + source + trainable task) — Design is done. */
  hasSpec: boolean;
  /** The persisted buildState — the single source of truth the stages gate on. */
  buildState: ModelBuildState;
  /** A prediction actually ran this session (Monitor's try-it signal). */
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
  archived: 0,
};

/** True once the model has reached AT LEAST `min` on the lifecycle ladder. */
export const atLeast = (bs: ModelBuildState, min: ModelBuildState): boolean =>
  STATE_RANK[bs] >= STATE_RANK[min];

/**
 * The three stages. Launch needs a spec; Monitor opens once the model is DEPLOYED (a real
 * serving endpoint exists). `deploy_failed` stays in Launch (to retry) but is NOT `deployed`,
 * so Monitor stays gated — honest about a broken rollout.
 */
export const SCI_STAGES: StageDef<SciStageId, SciCtx>[] = [
  {
    id: 'design',
    title: 'Design',
    hint: 'Describe what you want to predict — or pick a dataset and choose the columns by hand.',
    completed: (c) => c.hasSpec,
  },
  {
    id: 'launch',
    title: 'Launch',
    hint: 'Train the model and put it live in one step, then watch it happen.',
    enabled: (c) => c.hasSpec,
    completed: (c) => c.buildState === 'deployed',
  },
  {
    id: 'monitor',
    title: 'Monitor',
    hint: 'Try it on a real example, watch its health and usage, then promote or govern it.',
    enabled: (c) => c.buildState === 'deployed',
    completed: (c) => c.buildState === 'deployed',
  },
];
