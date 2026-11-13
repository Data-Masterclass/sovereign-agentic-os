/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Lineage from the dbt manifest (through Dagster's asset graph), not from the OS ledger
 * USER STORY: As a data engineer I want the lineage the Data tab and `get_lineage` show to be the one
 *             dbt computed from my models' `ref()` and `source()` calls — so what I see is what will
 *             actually run, including the warehouse table upstream of a sync (checklist D16).
 * ARCHITECTURE:
 *   - PURE. `graphLineage(dataset, nodes, keys)` folds Dagster's `assetNodes { assetKey
 *     dependencyKeys }` — which dagster-dbt derives from `manifest.json`'s `parent_map` — into the
 *     SAME `LineageGraph` the registry path returns, so every consumer is unchanged. The impure half
 *     (one GraphQL call, the fallback) is `tabs/data/lib/lineage-server.ts`.
 *   - Why the asset graph and not `target/manifest.json` directly: the manifest lives in the Dagster
 *     pod's `/repos-checkout`, which os-ui cannot read (no shared volume, and the repo-sync status
 *     port has no Service). The asset graph is the SAME edges, over a path B2 already built and the
 *     OS already authenticates to (`core/infra/dagster.ts`).
 *   - Column-level lineage is NOT derived here: dbt's manifest carries it only with
 *     `--no-partial-parse` + the column-level-lineage work in dbt Cloud. Recorded as a follow-up;
 *     the per-node `columns` stay the OS's documented columns, exactly as before.
 *   - Returns `null` when the dataset has no model in the graph at all, which is the caller's signal
 *     to fall back instead of rendering an empty graph.
 */
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import type { Layer } from '@tabs/data/lib/dataset-schema';
import type { LineageGraph, LineageNode, LineageEdge } from '@tabs/data/lib/lineage';
import { transparencyGate } from '@tabs/data/lib/transparency';
import { viewName } from '@tabs/data/lib/metrics';
import type { DatasetAssetKeys } from '@tabs/data/lib/dbt/asset-keys';

/** The shape `core/infra/dagster.ts` `assetGraph()` returns (structural, so no core import here). */
export type GraphNode = { key: string[]; dependsOn: string[][]; group: string | null; description: string | null };

const LAYER_OF: Record<string, Layer> = { bronze: 'bronze', silver: 'silver', gold: 'gold' };

function keyId(key: string[]): string {
  return key.join('/');
}

/** `silver_orders` → `silver`; anything else → null (not one of the OS's layer models). */
export function layerOfModel(name: string): Layer | null {
  const prefix = name.split('_')[0];
  return LAYER_OF[prefix] ?? null;
}

/**
 * Fold the asset graph into the dataset's lineage. `keys` names the dataset's OWN assets (from the
 * same planner that generated the project), so "mine" and "upstream" is a fact, not a guess.
 */
export function graphLineage(d: Dataset, nodes: GraphNode[], keys: DatasetAssetKeys): LineageGraph | null {
  const byId = new Map(nodes.map((n) => [keyId(n.key), n]));
  const mine = keys.models.filter((m) => byId.has(keyId(m.key)));
  if (mine.length === 0) return null;

  const mineIds = new Set(mine.map((m) => keyId(m.key)));
  const columns = d.columns.map((c) => c.name);
  const graphNodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];

  for (const m of mine) {
    const node = byId.get(keyId(m.key))!;
    graphNodes.push({
      id: `v:${m.layer}`,
      kind: 'version',
      label: `${m.layer[0].toUpperCase()}${m.layer.slice(1)}`,
      // The artifact an engineer would open: the dbt model this layer IS.
      sublabel: `models/…/${m.name}.sql`,
      built: true,
      passThrough: d.versions[m.layer].passThrough,
      columns,
    });
    for (const dep of node.dependsOn) {
      const id = keyId(dep);
      if (mineIds.has(id)) {
        // Refinement edge between two of the dataset's own layers.
        const from = mine.find((x) => keyId(x.key) === id);
        if (from) edges.push({ from: `v:${from.layer}`, to: `v:${m.layer}`, kind: 'refinement' });
        continue;
      }
      // Anything else dbt says this model reads: another dataset's model, another domain's product,
      // or the federated warehouse table behind a sync (an observable source asset).
      const up = byId.get(id);
      const last = dep[dep.length - 1] ?? id;
      const upstreamId = `up:${id}`;
      if (!graphNodes.some((n) => n.id === upstreamId)) {
        const name = up ? modelNameOf(dep) : last;
        graphNodes.push({
          id: upstreamId,
          kind: 'upstream',
          label: name,
          sublabel: `dbt ${dep.length > 2 ? 'source' : 'model'} · ${dep.join('.')}`,
          built: true,
        });
      }
      edges.push({ from: upstreamId, to: `v:${m.layer}`, kind: 'join' });
    }
  }

  // Consumption axis stays the OS's own: a measure is an OS metric, not a dbt node.
  const gold = graphNodes.find((n) => n.id === 'v:gold');
  if (gold && d.measures.length > 0) {
    for (const measure of d.measures) {
      graphNodes.push({ id: `m:${measure.name}`, kind: 'metric', label: measure.name, sublabel: `Metric · ${viewName(d)} (${measure.type})`, built: true });
      edges.push({ from: 'v:gold', to: `m:${measure.name}`, kind: 'metric' });
    }
  }

  return {
    dataset: d.name,
    tier: d.tier,
    certification: d.certification,
    nodes: graphNodes,
    edges: dedupeEdges(edges),
    transparency: transparencyGate(d),
    source: 'dbt',
  };
}

/**
 * A dbt `manifest.json` → the same `{key, dependsOn}` nodes Dagster's asset graph reports.
 *
 * This is the equivalence the whole design rests on: dagster-dbt keys a model `[<name>]` and a
 * source `[<source_name>, <table>]`, prefixes both with the domain, and derives the edges from
 * `parent_map` — so a manifest fixture is a faithful stand-in for the live graph, and this function
 * is what the tests feed in. It is also the path to take if os-ui ever reads the manifest directly.
 */
export function assetNodesFromManifest(manifest: unknown, domain: string): GraphNode[] {
  const m = (manifest ?? {}) as {
    nodes?: Record<string, { resource_type?: string; name?: string; description?: string }>;
    sources?: Record<string, { source_name?: string; name?: string; description?: string }>;
    parent_map?: Record<string, string[]>;
  };
  const keyOf = (uid: string): string[] | null => {
    const node = m.nodes?.[uid];
    if (node && node.resource_type === 'model' && node.name) return [domain, node.name];
    const src = m.sources?.[uid];
    if (src?.source_name && src.name) return [domain, src.source_name, src.name];
    return null;
  };
  const out: GraphNode[] = [];
  for (const [uid, node] of Object.entries(m.nodes ?? {})) {
    if (node.resource_type !== 'model') continue;
    const key = keyOf(uid);
    if (!key) continue;
    out.push({
      key,
      dependsOn: (m.parent_map?.[uid] ?? []).map(keyOf).filter((k): k is string[] => Boolean(k)),
      group: domain,
      description: node.description ?? null,
    });
  }
  for (const [uid, src] of Object.entries(m.sources ?? {})) {
    const key = keyOf(uid);
    if (!key) continue;
    out.push({ key, dependsOn: [], group: domain, description: src.description ?? null });
  }
  return out.sort((a, b) => keyId(a.key).localeCompare(keyId(b.key)));
}

function modelNameOf(key: string[]): string {
  return key.length > 2 ? `${key[key.length - 2]}.${key[key.length - 1]}` : (key[key.length - 1] ?? '');
}

function dedupeEdges(edges: LineageEdge[]): LineageEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const k = `${e.from}>${e.to}:${e.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
