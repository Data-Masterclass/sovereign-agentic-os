/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The METRICS guided path — Define · Refine · Preview · Publish · Monitor.
 * Pure, framework-free (mirrors DASH_STAGES in lib/dashboards/stages.ts) so the
 * gating and ✓ rules are unit-testable without React.
 *
 * Stages:
 *  Define   — pick a source dataset and name the metric. NL-first: the agent box
 *             is the hero (not buried under Advanced). Gate: dataset chosen + measure named.
 *  Refine   — measure/filter/window/format/slice panels. Gate: aggregation and, for
 *             non-count/ratio types, a column selected.
 *  Preview  — live number + mode badge + auto-poll pending state. Gate: preview ran ok.
 *  Publish  — Save + PromoteButton. Gate: (optional) metric saved.
 *  Monitor  — Alerts + Explore-as-viewer. Gate: metric is live (saved).
 *
 * The live `ctx` is derived fresh each render from the builder's real form state;
 * a stage shows a ✓ only when the user also worked it this session.
 */

import type { StageDef } from '@/lib/core/stages';

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
