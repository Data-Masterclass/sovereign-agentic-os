/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Metric guided-path stage model — Define, Refine, Preview, Publish, Monitor
 * USER STORY: As a creator I want the metric builder to show which step I am on and which steps are done,
 *             so that I know what is left before my metric is live.
 * ARCHITECTURE:
 *   - Pure `StageDef` list (`core/kernel/stages.ts`) with enable/complete rules over a `MetricCtx`
 *     derived from the builder's form state; unit-testable without React.
 *   - Not mounted by any screen today: only the `MetricStageId` type is imported (by
 *     `tabs/metrics/ui/MetricStageAssistant.tsx`). Monitor's condition repeats Publish's `saved`.
 */

import type { StageDef } from '@core/kernel/stages';

export type MetricStageId = 'define' | 'refine' | 'preview' | 'publish' | 'monitor';

/** The live state the metric stage gates/✓-conditions read — derived fresh each render. */
export type MetricCtx = {
  /** A source dataset is chosen AND the metric has a non-empty name. */
  defined: boolean;
  /** The measure config is valid: aggregation chosen, and (for non-count/ratio) a column. */
  refined: boolean;
  /** A preview ran and returned at least one non-pending result. */
  previewed: boolean;
  /** The metric was saved (persisted) at least once this session or was pre-existing. */
  saved: boolean;
};

export const METRIC_STAGES: StageDef<MetricStageId, MetricCtx>[] = [
  {
    id: 'define',
    title: 'Define',
    hint: 'Pick a governed dataset and name your metric — describe it in words to let the assistant fill the form.',
    completed: (c) => c.defined,
  },
  {
    id: 'refine',
    title: 'Refine',
    hint: 'Choose the aggregation, optional filters, time window, format and slice dimensions.',
    enabled: (c) => c.defined,
    completed: (c) => c.refined,
  },
  {
    id: 'preview',
    title: 'Preview',
    hint: 'See the live governed number before you save — row-level security applies.',
    enabled: (c) => c.defined && c.refined,
    completed: (c) => c.previewed,
  },
  {
    id: 'publish',
    title: 'Publish',
    hint: 'Save the metric definition and, optionally, promote it to your domain.',
    enabled: (c) => c.defined && c.refined,
    completed: (c) => c.saved,
  },
  {
    id: 'monitor',
    title: 'Monitor',
    hint: 'Set alert thresholds and explore the live value under row-level security.',
    enabled: (c) => c.saved,
    completed: (c) => c.saved,
  },
];
