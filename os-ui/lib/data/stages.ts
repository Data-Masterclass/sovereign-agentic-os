/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The DATA guided path as a shared-core staged model — Define · Ingest · Refine ·
 * Publish · Use. Pure and framework-free (mirrors the Agents `PHASES` array and the
 * Dashboards `DASH_STAGES`) so the gating and ✓ rules are unit-testable on their own;
 * the React skin is components/data/DataBuilder.tsx, riding components/core/StageShell.tsx.
 *
 * `enabled(ctx)` gates which stages are reachable off REAL dataset state (the layer dots
 * and tier the registry already tracks) — you can't Ingest without a named dataset, can't
 * Refine without a Bronze layer, can't Publish without a refined (Silver/Gold) layer, can't
 * Use a dataset that was never materialized. `completed(ctx)` is each stage's LIVE condition;
 * a stage shows a ✓ only when the user ALSO worked it this session (tracked by the StageState
 * in the component). So a freshly-opened dataset shows no pre-marked checks, and a check clears
 * if the user later invalidates it (e.g. the layer is rebuilt away).
 */

import type { StageDef } from '@/lib/core/stages';

export type DataStageId = 'define' | 'ingest' | 'refine' | 'publish' | 'use';

/** The live state the data stage gates/✓-conditions read — derived fresh each render from
 *  the dataset's real layer dots + tier, never faked. */
export type DataCtx = {
  /** The dataset has a name (the one field a fresh dataset always has once created). */
  named: boolean;
  /** The raw Bronze layer is materialized (upload/extract/import verified server-side). */
  bronzeBuilt: boolean;
  /** A refined layer exists — Silver OR Gold built (the publish guard). */
  refined: boolean;
  /** At least one medallion layer is materialized (there is something to query/lineage). */
  materialized: boolean;
};

/**
 * The five stages. Ingest needs a name; Refine needs Bronze; Publish needs a refined layer;
 * Use needs a materialized table. Each gate reads the dataset's real state so skipping ahead
 * past unbuilt work is impossible and no ✓ is ever faked.
 */
export const DATA_STAGES: StageDef<DataStageId, DataCtx>[] = [
  { id: 'define', title: 'Define', hint: 'Name it, document its columns, and author the data-quality rules it must meet.', completed: (c) => c.named },
  { id: 'ingest', title: 'Ingest', hint: 'Bring in the raw data — upload a file or pull a governed extract into the Bronze layer.', enabled: (c) => c.named, completed: (c) => c.bronzeBuilt },
  { id: 'refine', title: 'Refine', hint: 'Clean Bronze into Silver, harmonize into Gold, and explore the result.', enabled: (c) => c.bronzeBuilt, completed: (c) => c.refined },
  { id: 'publish', title: 'Publish', hint: 'Run the quality checks, then promote to your domain, certify, or define a metric.', enabled: (c) => c.refined, completed: (c) => c.refined },
  { id: 'use', title: 'Use', hint: 'Ask it in plain language (governed NL→SQL) and trace its lineage end to end.', enabled: (c) => c.materialized, completed: (c) => c.materialized },
];
