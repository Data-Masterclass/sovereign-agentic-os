/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The DATA guided path as a shared-core staged model — Ingest · Define · Harmonize ·
 * Validate · Publish (5 stages). Pure and framework-free (mirrors the Agents `PHASES`
 * array and the Dashboards `DASH_STAGES`) so the gating and ✓ rules are unit-testable
 * on their own; the React skin is components/data/DataBuilder.tsx, riding
 * components/core/StageShell.tsx.
 *
 * Medallion alignment:
 *   Ingest (Bronze)              — name the dataset + land the source + explore raw data
 *   Define (Silver)              — now columns are real: document + clean/conform into Silver
 *   Harmonize (Gold)             — join/aggregate into the Gold business mart + explore result
 *   Validate (Data Quality & Lineage) — author DQ rules + run checks + badge + lineage trace
 *   View (Talk · Stats · Preview · Quality) — talk to it, see its shape + rows, check its quality
 *                                (promotion moved to the detail header, beside the lifecycle controls)
 *
 * STAGES ARE VOLUNTARILY SKIPPABLE. Every stage is always reachable — you can move
 * straight from Bronze to Publish without doing Silver/Gold first (a single-table or
 * pass-through Gold is legitimate, and not every dataset needs cleaning or a join).
 * We deliberately do NOT hard-gate navigation: no `enabled` predicate blocks a stage.
 * What stays honest is the ✓ — `completed(ctx)` is each stage's LIVE condition, and a
 * stage shows a ✓ only when the user ALSO worked it this session (tracked by the
 * StageState in the component). So a freshly-opened dataset shows no pre-marked checks,
 * a check clears if the user later invalidates it (e.g. the layer is rebuilt away), and
 * skipping a stage simply leaves it unchecked — never a faked green. Each stage's `hint`
 * says plainly what it does and that the refinement stages are optional.
 */

import type { StageDef } from '@/lib/core/stages';

export type DataStageId = 'ingest' | 'define' | 'harmonize' | 'validate' | 'publish';

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
  /** At least one column carries a description (drives the curated flow's Document ✓). */
  documented?: boolean;
};

/**
 * Five stages in medallion order — ALL always reachable (no `enabled` gate), so a user
 * can skip straight through. `completed(ctx)` reads the dataset's real state, so a ✓ is
 * only ever earned, never faked; skipping a stage simply leaves it unchecked. Each
 * `hint` describes what the stage does and flags the optional (refinement) stages.
 */
export const DATA_STAGES: StageDef<DataStageId, DataCtx>[] = [
  {
    id: 'ingest',
    title: 'Ingest (Bronze)',
    hint: 'Name the dataset and load your source as the raw Bronze table, then explore exactly what landed. This is the one required step — the rest are optional.',
    completed: (c) => c.bronzeBuilt,
  },
  {
    id: 'define',
    title: 'Define (Silver)',
    hint: 'Optional. Document what each column means and clean/conform the data into a tidy Silver layer. Skip it to keep Bronze as-is.',
    completed: (c) => c.silverBuilt,
  },
  {
    id: 'harmonize',
    title: 'Harmonize (Gold)',
    hint: 'Optional. Join or aggregate into a Gold business mart — a single-table or straight pass-through Gold is fine. Skip it if Bronze/Silver already answers your question.',
    completed: (c) => c.goldBuilt,
  },
  {
    id: 'validate',
    title: 'Validate (Quality & Lineage)',
    hint: 'Optional but recommended. Author data-quality checks, run them for a real pass/fail score, and trace the lineage before you share.',
    completed: (c) => c.materialized,
  },
  {
    // Internal id stays 'publish' so stored stage state, anchors and the promote/certify
    // routes never move — only the user-facing title/hint change to "View".
    id: 'publish',
    title: 'View',
    hint: 'Talk to your data in plain language, see its shape and rows, and check its quality. Promotion lives in the header — promote to your domain or certify as a data product from any stage.',
    completed: (c) => c.refined,
  },
];

/**
 * The stages a dataset's ORIGIN actually walks. A CURATED dataset is born from existing
 * governed datasets — there is no raw file to ingest and nothing of its own to clean
 * (cleaning belongs to the SOURCES; fixing data in two places forks the truth) — so its
 * flow is Compose · Document · Validate · View. Ids stay stable (stored stage anchors and
 * routes never move); only the visible set, order, titles and ✓-conditions change.
 * An ingested dataset keeps the full 5-stage medallion path unchanged.
 */
export function stagesForOrigin(origin?: 'ingest' | 'curated'): StageDef<DataStageId, DataCtx>[] {
  if (origin !== 'curated') return DATA_STAGES;
  const byId = new Map(DATA_STAGES.map((s) => [s.id, s] as const));
  return [
    {
      ...byId.get('harmonize')!,
      title: 'Compose (Gold)',
      hint: 'Join existing governed datasets into this one — pick the base, join others in, choose the output columns. This IS the curated build; ingesting and cleaning happened at the sources.',
    },
    {
      ...byId.get('define')!,
      title: 'Document',
      hint: 'Describe the composed dataset and what each output column means — required before it can be promoted.',
      completed: (c) => !!c.documented,
    },
    byId.get('validate')!,
    byId.get('publish')!,
  ];
}
