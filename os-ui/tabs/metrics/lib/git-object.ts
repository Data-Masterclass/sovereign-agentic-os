/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Where a metric lives in the domain repo — the `registerGitObject('metric', …)` half
 * USER STORY: As any user I want a metric's head commit, history, diff and restore to work the same
 *             way as a dataset's or an agent system's, so "everything built in the OS lives in git
 *             and can be versioned" is true for metrics too (D23, D24; checklist G3/G4, M-R5.4).
 * ARCHITECTURE:
 *   - PURE. `metricGitLocation(id, facts)` is the whole contribution: given a metric id and the
 *     facts the tab's own governed read already resolved, it returns the repo paths and the
 *     `OS-Object` trailer. Stream G owns the kernel registry, the `git log` reads and the
 *     not-found gating; this tab owns only "where is it, and may you see it".
 *   - The TRAILER is `metric:<datasetId>.<measure>`, not the bare id (see
 *     `tabs/data/lib/dbt/commit.ts` `metricObjectId`), because `OS-Object` is a single namespace
 *     across kinds and a bare `<datasetId>.<measure>` would be ambiguous with a dataset id.
 *     G's `GitObjectLocation.trailerId` exists for exactly this, so it is set explicitly rather
 *     than left to default.
 *   - The PATHS are the lane the semantic emitter writes, and nothing else: a metric's history is
 *     the git log of its semantic YAML (M-R5.4 — "no third ledger"). A rename does not move the
 *     file (the member is frozen), and a promotion does, which is why the location carries BOTH
 *     lanes: `git log -- <paths>` across the two is how a promoted metric keeps its history from
 *     before the lane move.
 *   - `null` means "no such metric OR you may not see it" — G turns both into one byte-identical
 *     `not_found`, so an id cannot be probed for existence (checklist G5).
 *   - Typed locally: `@core/infra/git-objects.ts` lands with stream G, and this file must compile
 *     before that merge. The shape is G's `GitObjectLocation` field for field.
 */

/** G's `GitObjectLocation`, structurally. Replaced by the import at merge (deviation M-11). */
export type MetricGitLocation = {
  domain: string;
  paths: string[];
  trailerId?: string;
  name?: string;
};

/** What the tab's own governed read must have resolved before a location can be built. */
export type MetricGitFacts = {
  /** The owning domain — the repo that holds the file. */
  domain: string;
  /** The dbt semantic model name (`modelName(dataset)`), which is the YAML's basename. */
  semanticModel: string;
  /** The dataset owner's sanitised uid — needed for the personal lane path. */
  ownerUid: string;
  /** Display name for the drawer header. */
  name?: string;
};

/** The promoted (domain) lane. */
export function domainLanePath(semanticModel: string): string {
  return `models/semantic/${semanticModel}.yml`;
}

/** The owner's personal lane, before promotion. */
export function personalLanePath(ownerUid: string, semanticModel: string): string {
  return `models/personal/${ownerUid}/semantic/${semanticModel}.yml`;
}

/** The `OS-Object` trailer value every metric commit carries. */
export function metricTrailerId(id: string): string {
  return `metric:${id}`;
}

/**
 * The repo location of one metric. BOTH lanes are returned, always: a promotion moves the file, and
 * a history that stopped at the move would hide every commit from before it.
 */
export function metricGitLocation(id: string, facts: MetricGitFacts): MetricGitLocation {
  return {
    domain: facts.domain,
    paths: [domainLanePath(facts.semanticModel), personalLanePath(facts.ownerUid, facts.semanticModel)],
    trailerId: metricTrailerId(id),
    ...(facts.name ? { name: facts.name } : {}),
  };
}
