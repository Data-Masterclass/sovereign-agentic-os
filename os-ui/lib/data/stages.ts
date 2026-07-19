/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The DATA guided path as a shared-core staged model — Ingest · Define · Harmonize ·
 * Validate · Use · Publish. Pure and framework-free (mirrors the Agents `PHASES` array and
 * the Dashboards `DASH_STAGES`) so the gating and ✓ rules are unit-testable on their own;
 * the React skin is components/data/DataBuilder.tsx, riding components/core/StageShell.tsx.
 *
 * Medallion alignment:
 *   Ingest   🥉 Bronze — name the dataset + land the source + explore raw data
 *   Define   🥈 Silver — now columns are real: document + clean/conform into Silver
 *   Harmonize 🥇 Gold  — join/aggregate into the Gold business mart + explore result
 *   Validate  ✅ Quality — author DQ rules + run checks + show pass/fail badge
 *   Use       —         — governed NL→SQL + lineage + doorway to Metrics/Dashboards
 *   Publish   🚀 Ship   — promote to domain / certify (LAST — after use/verify)
 *
 * `enabled(ctx)` gates which stages are reachable off REAL dataset state (the layer dots
 * and tier the registry already tracks) — you can't Define without Bronze, can't Harmonize
 * without Silver, can't Validate/Use without something materialized, can't Publish without
 * a refined (Silver/Gold) layer. `completed(ctx)` is each stage's LIVE condition; a stage
 * shows a ✓ only when the user ALSO worked it this session (tracked by the StageState in
 * the component). So a freshly-opened dataset shows no pre-marked checks, and a check
 * clears if the user later invalidates it (e.g. the layer is rebuilt away).
 */

import type { StageDef } from '@/lib/core/stages';

export type DataStageId = 'ingest' | 'define' | 'harmonize' | 'validate' | 'use' | 'publish';

/** The live state the data stage gates/✓-conditions read — derived fresh each render from
 *  the dataset's real layer dots + tier, never faked. */
export type DataCtx = {
  /** The dataset has a name (the one field a fresh dataset always has once created). */
  named: boolean;
  /** The raw Bronze layer is materialized (upload/extract/import verified server-side). */
  bronzeBuilt: boolean;
  /** A Silver layer exists (cleaned/conformed). */
  silverBuilt: boolean;
  /** A Gold layer exists (joined/aggregated business mart). */
  goldBuilt: boolean;
  /** A refined layer exists — Silver OR Gold built (the publish guard). */
  refined: boolean;
  /** At least one medallion layer is materialized (there is something to query/lineage). */
  materialized: boolean;
};

/**
 * The six stages in medallion order. Ingest is always reachable; Define needs Bronze;
 * Harmonize needs Silver; Validate needs a materialized layer; Use needs a materialized
 * layer; Publish needs a refined layer. Each gate reads the dataset's real state so
 * skipping ahead past unbuilt work is impossible and no ✓ is ever faked.
 */
export const DATA_STAGES: StageDef<DataStageId, DataCtx>[] = [
  {
    id: 'ingest',
    title: 'Ingest',
    hint: 'Name the dataset, pick or land the source into Bronze, and explore the raw data.',
    completed: (c) => c.bronzeBuilt,
  },
  {
    id: 'define',
    title: 'Define',
    hint: 'Columns are real now — document their meanings and clean/conform into the Silver layer.',
    enabled: (c) => c.bronzeBuilt,
    completed: (c) => c.silverBuilt,
  },
  {
    id: 'harmonize',
    title: 'Harmonize',
    hint: 'Join and aggregate Silver into the Gold business mart, then explore the result.',
    enabled: (c) => c.silverBuilt,
    completed: (c) => c.goldBuilt,
  },
  {
    id: 'validate',
    title: 'Validate',
    hint: 'Author the data-quality rules and run the checks — a real pass/fail against the built table.',
    enabled: (c) => c.materialized,
    completed: (c) => c.materialized,
  },
  {
    id: 'use',
    title: 'Use',
    hint: 'Ask it in plain language (governed NL→SQL), trace lineage, and jump to Metrics or Dashboards.',
    enabled: (c) => c.materialized,
    completed: (c) => c.materialized,
  },
  {
    id: 'publish',
    title: 'Publish',
    hint: 'Promote to your domain or certify as a data product — the final step, after you have used and verified the data.',
    enabled: (c) => c.refined,
    completed: (c) => c.refined,
  },
];
