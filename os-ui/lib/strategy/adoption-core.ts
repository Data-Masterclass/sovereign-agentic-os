/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Artifact, ArtifactType } from '@/lib/artifact-model';
import type { Role } from '@/lib/session';
import { type ArtifactKind, ARTIFACT_KINDS } from './model.ts';

/**
 * PURE adoption tally (no server imports) — extracted from `adoption.ts` so the
 * by-domain promoted/certified derivation + the active-people split are unit
 * testable. `adoption.ts` supplies the live registry + user roster; this reduces
 * them to the scoreboard.
 */

export type TierCounts = { promoted: number; certified: number };

export type DomainAdoption = {
  domain: string;
  counts: Record<ArtifactKind, TierCounts>;
  /** The VIEWER's own personal-tier items in this domain, by kind (their workspace). */
  personal: Record<ArtifactKind, number>;
  activeCreators: number;
  activeBuilders: number;
};

export type AdoptionBoard = {
  generatedAt: string;
  windowDays: number;
  domains: DomainAdoption[];
  tenant: DomainAdoption;
};

export function emptyCounts(): Record<ArtifactKind, TierCounts> {
  const c = {} as Record<ArtifactKind, TierCounts>;
  for (const k of ARTIFACT_KINDS) c[k] = { promoted: 0, certified: 0 };
  return c;
}

export function emptyPersonal(): Record<ArtifactKind, number> {
  const c = {} as Record<ArtifactKind, number>;
  for (const k of ARTIFACT_KINDS) c[k] = 0;
  return c;
}

/** Map a registry artifact to one of the six scoreboard kinds (or null). */
export function kindOf(a: Pick<Artifact, 'type' | 'tags'>): ArtifactKind | null {
  // Allow an explicit override via tag (future software/ml registry rows).
  for (const k of ARTIFACT_KINDS) if (a.tags?.includes(`kind:${k}`)) return k;
  const byType: Partial<Record<ArtifactType, ArtifactKind>> = {
    dataset: 'data',
    transformation: 'data',
    metric: 'metric',
    dashboard: 'dashboard',
    agent: 'agent',
  };
  return byType[a.type] ?? null;
}

function isActive(a: Pick<Artifact, 'updatedAt'>, cutoff: number): boolean {
  const t = Date.parse(a.updatedAt);
  return Number.isFinite(t) && t >= cutoff;
}

/**
 * Reduce the registry + role map to the adoption board. `windowDays` defines the
 * "active" window; `cutoff` is its epoch-ms boundary; `domainFilter` restricts to
 * one domain (domain pillar). Certified-copies are excluded (not new authored
 * work). Tier: Shared → promoted, Certified → certified.
 */
export function tallyAdoption(
  artifacts: Artifact[],
  roleById: Map<string, Role>,
  opts: { windowDays: number; cutoff: number; domainFilter?: string; viewerId?: string },
): AdoptionBoard {
  const byDomain = new Map<string, DomainAdoption>();
  const ensure = (domain: string): DomainAdoption => {
    let d = byDomain.get(domain);
    if (!d) {
      d = { domain, counts: emptyCounts(), personal: emptyPersonal(), activeCreators: 0, activeBuilders: 0 };
      byDomain.set(domain, d);
    }
    return d;
  };

  const activeCreatorSet = new Map<string, Set<string>>();
  const activeBuilderSet = new Map<string, Set<string>>();

  for (const a of artifacts) {
    if (a.origin === 'certified-copy') continue;
    if (opts.domainFilter && a.domain !== opts.domainFilter) continue;
    const d = ensure(a.domain);

    const kind = kindOf(a);
    if (kind) {
      if (a.visibility === 'Shared') d.counts[kind].promoted += 1;
      else if (a.visibility === 'Certified') d.counts[kind].certified += 1;
      // The viewer's own personal-tier items — their private workspace, shown
      // alongside the company/domain counts so a person sees their own footprint.
      else if (a.visibility === 'Personal' && opts.viewerId && a.owner === opts.viewerId) {
        d.personal[kind] += 1;
      }
    }

    if (isActive(a, opts.cutoff)) {
      const role = roleById.get(a.owner) ?? 'creator';
      const set = role === 'creator' ? activeCreatorSet : activeBuilderSet;
      let s = set.get(a.domain);
      if (!s) { s = new Set(); set.set(a.domain, s); }
      s.add(a.owner);
    }
  }

  for (const [domain, set] of activeCreatorSet) ensure(domain).activeCreators = set.size;
  for (const [domain, set] of activeBuilderSet) ensure(domain).activeBuilders = set.size;

  const domains = [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));

  const tenantCounts = emptyCounts();
  const tenantPersonal = emptyPersonal();
  for (const d of domains) {
    for (const k of ARTIFACT_KINDS) {
      tenantCounts[k].promoted += d.counts[k].promoted;
      tenantCounts[k].certified += d.counts[k].certified;
      tenantPersonal[k] += d.personal[k];
    }
  }
  const tenantCreators = new Set<string>();
  const tenantBuilders = new Set<string>();
  for (const set of activeCreatorSet.values()) for (const u of set) tenantCreators.add(u);
  for (const set of activeBuilderSet.values()) for (const u of set) tenantBuilders.add(u);

  return {
    generatedAt: new Date().toISOString(),
    windowDays: opts.windowDays,
    domains,
    tenant: {
      domain: 'tenant',
      counts: tenantCounts,
      personal: tenantPersonal,
      activeCreators: tenantCreators.size,
      activeBuilders: tenantBuilders.size,
    },
  };
}
