/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Artifact } from '@/lib/core/artifact-model';
import type { Role } from '@/lib/core/session';

/**
 * PURE derivations for the Strategy tab's two adoption sections (no server
 * imports, so this is unit-testable and the server adapter stays a thin "fetch
 * the registry + roster, then reduce" wrapper).
 *
 *   • Self Service — how broadly the platform is ADOPTED: distinct people who
 *     have CREATED something in each capability area. "Created" = the artifact
 *     exists as a tile in its tab at ANY tier (draft+), not necessarily promoted.
 *     Plus the Builder/Creator population.
 *   • Foundations — the GOVERNED asset base: total Promoted + Certified artifacts
 *     per type (tier ≥ promoted). The shared, certified backbone every bet builds on.
 *
 * Both are derived live from the same registry the rest of the OS writes to, so
 * creating/promoting an artifact moves these numbers with NO manual edit.
 */

// --------------------------------------------------------- Self Service --------

/** A creation "area" a person can self-serve in (drives the distinct-creator tally). */
export type SelfServiceArea = 'analytics' | 'ai' | 'software';

export type SelfServiceCounts = {
  /** People in scope (the company/domain population). */
  totalUsers: number;
  /** Distinct people who created a dashboard, data product, or metric. */
  analytics: number;
  /** Distinct people who created an agent or an ML model. */
  ai: number;
  /** Distinct people who created a software app. */
  software: number;
  /** Builder-role people in scope. */
  builders: number;
  /** Creator-role people in scope. */
  creators: number;
};

/**
 * Which self-service area(s) an artifact counts toward. Uses the registry type,
 * with an explicit `kind:*` tag override for the kinds that have no native type
 * yet (software, ml). A single artifact only ever maps to one area.
 */
export function selfServiceArea(a: Pick<Artifact, 'type' | 'tags'>): SelfServiceArea | null {
  const tags = a.tags ?? [];
  if (tags.includes('kind:software')) return 'software';
  if (tags.includes('kind:ml') || tags.includes('kind:science')) return 'ai';
  switch (a.type) {
    case 'dashboard':
    case 'dataset':
    case 'transformation':
    case 'metric':
      return 'analytics';
    case 'agent':
      return 'ai';
    default:
      return null;
  }
}

// ---------------------------------------------------------- Foundations --------

/** The governed asset types the Foundations section tallies (tier ≥ promoted). */
export type FoundationType =
  | 'agent'
  | 'software'
  | 'science'
  | 'knowledge'
  | 'data'
  | 'metric'
  | 'files'
  | 'connection';

export const FOUNDATION_TYPES: FoundationType[] = [
  'agent',
  'software',
  'science',
  'knowledge',
  'data',
  'metric',
  'files',
  'connection',
];

export const FOUNDATION_LABEL: Record<FoundationType, string> = {
  agent: 'Agents',
  software: 'Software',
  science: 'Science',
  knowledge: 'Knowledge',
  data: 'Data',
  metric: 'Metrics',
  files: 'Files',
  connection: 'Connections',
};

/** Map an artifact to a Foundations type (or null). Tag overrides win. */
export function foundationType(a: Pick<Artifact, 'type' | 'tags'>): FoundationType | null {
  const tags = a.tags ?? [];
  if (tags.includes('kind:software')) return 'software';
  if (tags.includes('kind:ml') || tags.includes('kind:science')) return 'science';
  switch (a.type) {
    case 'agent':
      return 'agent';
    case 'knowledge':
      return 'knowledge';
    case 'dataset':
    case 'transformation':
      return 'data';
    case 'metric':
      return 'metric';
    case 'file':
      return 'files';
    case 'connection':
      return 'connection';
    default:
      return null; // dashboards are not a Foundation type
  }
}

export function emptyFoundations(): Record<FoundationType, number> {
  const c = {} as Record<FoundationType, number>;
  for (const t of FOUNDATION_TYPES) c[t] = 0;
  return c;
}

// ----------------------------------------------------------- Scorecard ---------

export type Scorecard = {
  generatedAt: string;
  /** Human label for the scope these counts cover (e.g. "Company" or a domain). */
  scopeLabel: string;
  selfService: SelfServiceCounts;
  foundations: Record<FoundationType, number>;
};

/** A user is "promoted-tier" authored work when its visibility is Shared/Certified. */
function isPromotedTier(a: Artifact): boolean {
  return a.visibility === 'Shared' || a.visibility === 'Certified';
}

/**
 * Reduce the (already domain-scoped) artifact set + user roster to the Strategy
 * scorecard. Certified-copies are excluded everywhere (not new authored work).
 *
 *   • Self Service distinct-creator counts span ALL tiers (draft/Personal+).
 *   • Foundations counts only tier ≥ promoted (Shared + Certified).
 */
export function buildScorecard(
  artifacts: Artifact[],
  users: { id: string; role: Role }[],
  opts: { scopeLabel?: string } = {},
): Scorecard {
  const analytics = new Set<string>();
  const ai = new Set<string>();
  const software = new Set<string>();
  const foundations = emptyFoundations();

  for (const a of artifacts) {
    if (a.origin === 'certified-copy') continue;

    const area = selfServiceArea(a);
    if (area === 'analytics') analytics.add(a.owner);
    else if (area === 'ai') ai.add(a.owner);
    else if (area === 'software') software.add(a.owner);

    if (isPromotedTier(a)) {
      const ft = foundationType(a);
      if (ft) foundations[ft] += 1;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    scopeLabel: opts.scopeLabel ?? 'Company',
    selfService: {
      totalUsers: users.length,
      analytics: analytics.size,
      ai: ai.size,
      software: software.size,
      builders: users.filter((u) => u.role === 'builder' || u.role === 'domain_admin').length,
      creators: users.filter((u) => u.role === 'creator').length,
    },
    foundations,
  };
}
