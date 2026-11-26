/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The EXPOSE guided path as a shared-core staged model — Catalog · Organize · Assign · Review.
 * Pure and framework-free (mirrors lib/data/stages.ts) so the

 * gating and ✓ rules ride the unit-tested core primitive (lib/core/stages.ts); the React skin
 * is components/connections/ExposePanel.tsx on components/core/StageShell.tsx.
 *
 * Four plain-language stages for a platform admin exposing external-catalog tables to domains:
 *   • Catalog  — snapshot health + Refresh; browse the catalog by schema, multi-select tables.
 *   • Organize — (Phase B: AI folders) group the same selection by category; enterable but
 *                SKIPPABLE — AI never blocks exposure. Done = the catalog has actually been
 *                organized. In Phase A it falls back to the schema browser with a quiet note.
 *   • Assign   — the calm form: name (auto-suggested), domains, mode (Live/Sync), tier, note.
 *   • Review   — human-impact card + grouped read-only list + one primary Create/Update.
 *
 * Gating is honest about a real exposure's readiness:
 *   • Catalog is the landing — always reachable; ✓ once a snapshot exists to browse.
 *   • Organize never gates entry (AI is optional) and never blocks Assign.
 *   • Assign needs at least one selected table (there is nothing to name/assign otherwise).
 *   • Review needs the whole thing ready to write — a selection, a name, and ≥1 domain.
 * `completed(ctx)` is what each stage's ✓ MEANS, read from the exposure being written (the
 * form for a new one, the saved set when editing) — never from which stages were visited
 * (the contract in core/kernel/stages.ts):
 *   Catalog   a snapshot exists AND tables are picked from it
 *   Organize  the catalog has been organized into folders (a classification run exists)
 *   Assign    it has a name and ≥1 domain
 *   Review    the exposure is SAVED (an existing set is open). A new one is not done until
 *             "Create exposure" succeeds — which closes this flow.
 */

import type { StageDef } from '@core/kernel/stages';

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
  /** The connection's catalog has been organized into folders — a classification run exists
   *  (persisted per connection). Purely a ✓ signal (Organize is optional); it gates nothing. */
  classified: boolean;
  /** An existing, saved exposure is open for editing (false while creating a new one). */
  saved: boolean;
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
    completed: (c) => c.hasSnapshot && c.selectedCount > 0,
    pending: (c) => (c.hasSnapshot ? 'no tables picked yet' : 'no catalog snapshot yet'),
  },
  {
    id: 'organize',
    title: 'Organize',
    hint: 'Group the tables by category to expose whole areas at once — optional.',
    // No `enabled` gate: Organize is voluntary and never blocks exposure.
    completed: (c) => c.classified,
    pending: () => 'not organized (optional)',
  },
  {
    id: 'assign',
    title: 'Assign',
    hint: 'Name it, choose the domains, and set how the data is served.',
    enabled: (c) => c.selectedCount > 0,
    completed: (c) => c.selectedCount > 0 && c.hasName && c.hasDomains,
    pending: () => 'needs a name and a domain',
  },
  {
    id: 'review',
    title: 'Review',
    hint: 'See exactly who gains access, then create the exposure.',
    enabled: readyToWrite,
    completed: (c) => c.saved && readyToWrite(c),
    pending: () => 'not created yet',
  },
];

/** A catalog key (namespace `connections`) for a stage's title / hint / pending reason. */
export type ExposeStageTextKey =
  | `exposeStages.${ExposeStageId}.title`
  | `exposeStages.${ExposeStageId}.hint`
  | 'exposeStages.catalog.pendingNoTables'
  | 'exposeStages.catalog.pendingNoSnapshot'
  | `exposeStages.${'organize' | 'assign' | 'review'}.pending`;

/**
 * The catalog keys behind each stage's English text above (i18n wave 2). The English stays for
 * non-UI readers and the unit tests; ExposePanel renders these keys through `connections.exposeStages.*`.
 * `pending` mirrors the English `pending(ctx)` branch for branch.
 */
export const EXPOSE_STAGE_KEYS: Record<
  ExposeStageId,
  { title: ExposeStageTextKey; hint: ExposeStageTextKey; pending: (c: ExposeCtx) => ExposeStageTextKey }
> = {
  catalog: {
    title: 'exposeStages.catalog.title',
    hint: 'exposeStages.catalog.hint',
    pending: (c) => (c.hasSnapshot ? 'exposeStages.catalog.pendingNoTables' : 'exposeStages.catalog.pendingNoSnapshot'),
  },
  organize: { title: 'exposeStages.organize.title', hint: 'exposeStages.organize.hint', pending: () => 'exposeStages.organize.pending' },
  assign: { title: 'exposeStages.assign.title', hint: 'exposeStages.assign.hint', pending: () => 'exposeStages.assign.pending' },
  review: { title: 'exposeStages.review.title', hint: 'exposeStages.review.hint', pending: () => 'exposeStages.review.pending' },
};
