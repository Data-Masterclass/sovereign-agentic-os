/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Layer } from './dataset-schema.ts';
import { transparencyGate, type GateResult } from './transparency.ts';
import { slug } from './store-fqn.ts';
import { cubeViewName, goldMartFqn } from './metrics.ts';

/**
 * End-to-end lineage for one dataset, assembled from the single source — spanning
 * BOTH axes (data-architecture-model.md §"Governance & lineage across the matrix"):
 *   • refinement: bronze → silver → gold (column-level, from the documented columns);
 *   • consumption: gold → metric(s) → dashboard (the dbt-exposure edges);
 *   • trust:       dataset → asset → product (the tier the dataset has reached).
 * Plus the transparency-gate status, enforced on every Build. Pure + tested so the
 * lineage panel and any catalog export share one graph.
 */

export type LineageKind = 'version' | 'metric' | 'dashboard';
export type EdgeKind = 'refinement' | 'metric' | 'dashboard';

export type LineageNode = {
  id: string;
  kind: LineageKind;
  label: string;
  /** FQN / artifact (the handover name) shown under the label. */
  sublabel: string;
  built: boolean;
  passThrough?: boolean;
  columns?: string[];
};

export type LineageEdge = { from: string; to: string; kind: EdgeKind };

export type LineageGraph = {
  dataset: string;
  tier: Dataset['tier'];
  certification?: Dataset['certification'];
  nodes: LineageNode[];
  edges: LineageEdge[];
  transparency: GateResult;
};

const LAYERS: Layer[] = ['bronze', 'silver', 'gold'];
const ARTIFACT: Record<Layer, (s: string) => string> = {
  bronze: (s) => `bronze/${s}.dlt.yml`,
  silver: (s) => `silver/stg_${s}.sql`,
  gold: (s) => `gold/mart_${s}.sql`,
};

export function lineageFor(d: Dataset): LineageGraph {
  const s = slug(d.name);
  const columns = d.columns.map((c) => c.name);
  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];

  // Refinement axis — one node per built version, column-level, chained.
  const builtLayers = LAYERS.filter((l) => d.versions[l].built);
  let prev: string | null = null;
  for (const l of builtLayers) {
    const id = `v:${l}`;
    nodes.push({
      id,
      kind: 'version',
      label: `${l[0].toUpperCase()}${l.slice(1)}`,
      sublabel: d.versions[l].artifact ?? ARTIFACT[l](s),
      built: true,
      passThrough: d.versions[l].passThrough,
      columns,
    });
    if (prev) edges.push({ from: prev, to: id, kind: 'refinement' });
    prev = id;
  }

  // Consumption axis — metric(s) on Gold, then a dashboard on the view.
  const goldId = d.versions.gold.built ? 'v:gold' : null;
  if (goldId && d.measures.length > 0) {
    for (const m of d.measures) {
      const id = `m:${m.name}`;
      nodes.push({ id, kind: 'metric', label: m.name, sublabel: `Cube · ${cubeViewName(d)} (${m.type})`, built: true });
      edges.push({ from: goldId, to: id, kind: 'metric' });
    }
    const dash = 'dash';
    nodes.push({ id: dash, kind: 'dashboard', label: `${cubeViewName(d)} Overview`, sublabel: 'Superset on Cube', built: false });
    for (const m of d.measures) edges.push({ from: `m:${m.name}`, to: dash, kind: 'dashboard' });
  }

  return {
    dataset: d.name,
    tier: d.tier,
    certification: d.certification,
    nodes,
    edges,
    transparency: transparencyGate(d),
  };
}

/** The governed mart FQN at the head of the consumption chain (handover contract). */
export function lineageRootFqn(d: Dataset): string {
  return goldMartFqn(d);
}
