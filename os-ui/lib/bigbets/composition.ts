/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Composition-map adapter (builds-on-top-of graph).
 *
 * Distinct from the roadmap's build-ORDER dependencies, the composition map is
 * the runtime "builds-on-top-of" picture: which dashboards / agents / software /
 * ML models CONSUME which data products, knowledge, metrics and connections. It
 * is DERIVED from real lineage — the registry's consume-edges plus OpenMetadata
 * lineage (mocked for kind) — never hand-drawn, so it stays true as components
 * change. It doubles as the value-attribution graph: usage-based allocation and
 * upstream credit both ride on these same edges (see value.ts).
 *
 * We include not just a bet's directly-tagged components but the SHARED upstream
 * assets they build on (even if those aren't tagged to the bet) — that is how a
 * data product used by a dashboard + an agent becomes visible and earns credit.
 */

import { type Artifact, type Tab, UPSTREAM_TABS } from './model.ts';
import { resolveArtifact } from './sources.ts';

export type CompositionNode = {
  id: string;
  tab: Tab;
  title: string;
  /** Is this a shared upstream asset pulled in via lineage (not directly tagged). */
  upstream: boolean;
  omFqn?: string;
};

/** A builds-on edge: `from` (consumer/leaf) builds on `to` (upstream asset). */
export type CompositionEdge = { from: string; to: string };

export type CompositionMap = {
  nodes: CompositionNode[];
  edges: CompositionEdge[];
};

/**
 * Build the composition map for a set of the bet's component artifact ids. Walks
 * consume-edges upstream (transitively) so shared foundational assets appear.
 */
export function buildComposition(componentArtifactIds: string[]): CompositionMap {
  const tagged = new Set(componentArtifactIds);
  const nodes = new Map<string, CompositionNode>();
  const edges: CompositionEdge[] = [];
  const seen = new Set<string>();

  const visit = (artifactId: string) => {
    if (seen.has(artifactId)) return;
    seen.add(artifactId);
    const a = resolveArtifact(artifactId);
    if (!a) return;
    nodes.set(a.id, {
      id: a.id,
      tab: a.tab,
      title: a.title,
      upstream: !tagged.has(a.id) && UPSTREAM_TABS.includes(a.tab),
      omFqn: a.omFqn,
    });
    for (const up of a.consumes) {
      edges.push({ from: a.id, to: up });
      visit(up); // pull the shared upstream asset in, even if not tagged
    }
  };

  for (const cid of componentArtifactIds) visit(cid);

  // Drop edges whose target failed to resolve (lineage referencing a gone asset).
  const present = new Set(nodes.keys());
  const liveEdges = edges.filter((e) => present.has(e.from) && present.has(e.to));
  return { nodes: [...nodes.values()], edges: liveEdges };
}

/** Count of distinct downstream consumers for each node (drives upstream credit). */
export function downstreamCounts(map: CompositionMap): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of map.edges) counts.set(e.to, (counts.get(e.to) ?? 0) + 1);
  return counts;
}

/** Convenience: the artifact behind a node (for the value join). */
export function nodeArtifact(nodeId: string): Artifact | null {
  return resolveArtifact(nodeId);
}
