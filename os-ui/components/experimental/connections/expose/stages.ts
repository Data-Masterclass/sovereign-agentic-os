/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The EXPOSE guided path as a shared-core staged model — Catalog · Organize · Assign · Review.
 * Pure and framework-free (mirrors components/science/stages.ts and lib/data/stages.ts) so the
 * gating and ✓ rules ride the unit-tested core primitive (lib/core/stages.ts); the React skin
 * is components/connections/ExposePanel.tsx on components/core/StageShell.tsx.
 *
 * Four plain-language stages for a platform admin exposing external-catalog tables to domains:
 *   • Catalog  — snapshot health + Refresh; browse the catalog by schema, multi-select tables.
 *   • Organize — (Phase B: AI folders) group the same selection by category; enterable but
 *                SKIPPABLE — AI never blocks exposure. Done = the admin visited it or picked
 *                something. In Phase A it falls back to the schema browser with a quiet note.
 *   • Assign   — the calm form: name (auto-suggested), domains, mode (Live/Sync), tier, note.
 *   • Review   — human-impact card + grouped read-only list + one primary Create/Update.
 *
 * Gating is honest about a real exposure's readiness:
 *   • Catalog is the landing — always reachable; ✓ once a snapshot exists to browse.
 *   • Organize never gates entry (AI is optional) and never blocks Assign.
 *   • Assign needs at least one selected table (there is nothing to name/assign otherwise).
 *   • Review needs the whole thing ready to write — a selection, a name, and ≥1 domain.
 * `completed(ctx)` is each stage's LIVE condition; a stage shows a ✓ only when the user ALSO
 * worked it this session (tracked by the StageState in the component).
 */

import type { StageDef } from '@/lib/core/stages';

export type ExposeStageId = 'catalog' | 'organize' | 'assign' | 'review';

/** The live state the expose stage gates/✓-conditions read — derived fresh each render. */
export type ExposeCtx = {
  /** A catalog snapshot has been taken for this connection (something to browse). */
  hasSnapshot: boolean;
  /** The snapshot's honest freshness/reachability, for stage copy (not a gate). */
  snapshotStatus: 'live' | 'stale' | 'unreachable' | 'none';
  /** How many `schema.table` rows are currently selected (the ONE panel-owned set). */
  selectedCount: number;
  /** The exposure has a non-blank name. */
  hasName: boolean;
  /** At least one domain is chosen. */
  hasDomains: boolean;
  /** The admin has worked Organize this session — visited it or made a selection there.
   *  Purely a ✓ signal (Organize is optional); it never gates any downstream stage. */
  classified: boolean;
};

/** Everything Assign/Review need before a set can be written. */
const readyToWrite = (c: ExposeCtx): boolean => c.selectedCount > 0 && c.hasName && c.hasDomains;

/**
 * The four stages. Catalog is the always-reachable landing; Organize is enterable-but-
 * skippable (AI never blocks exposure); Assign opens once a table is selected; Review opens
 * once the set is ready to write. Nothing here fabricates progress — every ✓ rides a live
 * condition in `completed`.
 */
export const EXPOSE_STAGES: StageDef<ExposeStageId, ExposeCtx>[] = [
  {
    id: 'catalog',
    title: 'Catalog',
    hint: 'Snapshot the connection’s catalog, then pick the tables to expose.',
    completed: (c) => c.hasSnapshot,
  },
  {
    id: 'organize',
    title: 'Organize',
    hint: 'Group the tables by category to expose whole areas at once — optional.',
    // No `enabled` gate: Organize is voluntary and never blocks exposure.
    completed: (c) => c.classified || c.selectedCount > 0,
  },
  {
    id: 'assign',
    title: 'Assign',
    hint: 'Name it, choose the domains, and set how the data is served.',
    enabled: (c) => c.selectedCount > 0,
    completed: (c) => c.hasName && c.hasDomains,
  },
  {
    id: 'review',
    title: 'Review',
    hint: 'See exactly who gains access, then create the exposure.',
    enabled: readyToWrite,
    completed: readyToWrite,
  },
];
