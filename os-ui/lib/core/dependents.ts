/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';

/**
 * dependentsOf — the ONE cross-tab dependency primitive for the graceful lifecycle spine
 * (0.6.98). Given an artifact id it walks the EXISTING reference edges and returns every
 * artifact that would lose access if this one were demoted / archived / deleted, so the
 * shared lifecycle confirm dialog can WARN before it happens (warn-then-allow) and so a
 * later audit can reason about blast radius.
 *
 * It is a READ-ONLY walk over the same governed stores the tabs read — no mutation, no new
 * persistence. It is deliberately UNSCOPED (it uses each store's `…Internal` enumerator):
 * the warning must count EVERY dependent, not only the ones the actor happens to see, or the
 * warn would under-report the very breakage it exists to prevent. The route that surfaces it
 * (`GET /api/artifacts/[id]/dependents`) is gated to signed-in users; the *count* is not a
 * data leak, and callers must not render cross-domain detail beyond {kind,name,tab}.
 *
 * Edges covered (0.6.98 scope — the reported crash path + the highest-value edges):
 *   • dataset  → metrics    (a metric IS a measure on the dataset — its members)
 *   • dataset  → dashboards (a panel references a metric member on that dataset's view)
 *   • dataset  → apps        (app.grants.data includes the id)
 *   • dataset  → agents      (agent grants.data includes the id, per-item)
 *   • metric   → dashboards  (a panel uses that metric's member)
 *   • knowledge/file/connection → apps + agents (grants include the id)
 * // TODO: extend for transformation→dataset lineage and knowledge/file→dashboard edges.
 */

import { datasetForScheduler } from '@/lib/data/store';
import { measureMember } from '@/lib/metrics/model';
import { listAllDashboardsInternal } from '@/lib/dashboards/store';
import { panelMetrics } from '@/lib/dashboards/model';
import { listAllAppsInternal } from '@/lib/software/apps';
import { isGranted, type ContextKind } from '@/lib/core/context-grants';
import { listAllSystemsInternal } from '@/lib/agents/store';
import type { ArtifactGrant } from '@/lib/agents/system-schema';
import { type Dependent, type DependentTab, dependentsSummary } from '@/lib/core/dependents-shared';

// Re-export the client-safe shape + summary so server callers have one import.
export { type Dependent, type DependentTab, dependentsSummary };

/** The context-grant kind an artifact id targets when granted to an app/agent. Datasets are
 *  `data`; the others map 1:1. A metric is not grant-targetable by a demote break (a metric
 *  IS its dataset), so metric queries only walk the dashboard edge. */
function grantKindFor(prefix: string): ContextKind | null {
  if (prefix === 'ds' || prefix === 'dataset') return 'data';
  if (prefix === 'knowledge' || prefix === 'kb') return 'knowledge';
  if (prefix === 'file') return 'files';
  if (prefix === 'connection' || prefix === 'conn') return 'connections';
  if (prefix === 'metric') return 'metrics';
  return null;
}

/** An id's leading `prefix_` token (the artifacts `id()` scheme is `${prefix}_${base36}`). */
function prefixOf(id: string): string {
  const i = id.indexOf('_');
  return i === -1 ? id : id.slice(0, i);
}

/** The agent-grant lists that hold per-item ids, keyed by the context-grant kind. */
function agentGrantList(grants: { data: ArtifactGrant[]; knowledge: ArtifactGrant[]; metrics: ArtifactGrant[]; connections: ArtifactGrant[]; files: ArtifactGrant[] }, kind: ContextKind): ArtifactGrant[] {
  switch (kind) {
    case 'data': return grants.data;
    case 'knowledge': return grants.knowledge;
    case 'metrics': return grants.metrics;
    case 'connections': return grants.connections;
    case 'files': return grants.files;
  }
}

/**
 * The governed metric MEMBERS (`View.measure`) a dataset exposes — the strings a dashboard
 * panel references. Resolved unscoped from the dataset's own measures so a demoted dataset's
 * members are still derivable while we compute its blast radius. Empty if the dataset is gone.
 */
function datasetMembers(datasetId: string): string[] {
  const d = datasetForScheduler(datasetId);
  if (!d) return [];
  return d.measures.map((m) => measureMember(d, m));
}

/** Does any panel member reference the queried metric/dataset? A member is `View.measure`. */
function dashboardsReferencing(members: Set<string>): Dependent[] {
  if (members.size === 0) return [];
  const out: Dependent[] = [];
  for (const d of listAllDashboardsInternal()) {
    const used = d.spec.charts.some((panel) => panelMetrics(panel).some((m) => members.has(m)));
    if (used) out.push({ kind: 'dashboard', id: d.id, name: d.name, tab: 'dashboards' });
  }
  return out;
}

/**
 * Every artifact that depends on `artifactId`, deduped by (tab,id). Walks the reference edges
 * above; unknown/unfound ids simply yield an empty list (never throws). The queried artifact's
 * KIND is inferred from its id prefix, which selects the right edges.
 */
export async function dependentsOf(artifactId: string): Promise<Dependent[]> {
  const prefix = prefixOf(artifactId);
  const out: Dependent[] = [];

  // METRIC id (`datasetId.measure`) — only the dashboard edge (a metric IS its dataset).
  const lastDot = artifactId.lastIndexOf('.');
  const looksLikeMetric = lastDot > 0 && grantKindFor(prefixOf(artifactId.slice(0, lastDot))) === 'data';
  if (looksLikeMetric) {
    const datasetId = artifactId.slice(0, lastDot);
    const measureName = artifactId.slice(lastDot + 1);
    const d = datasetForScheduler(datasetId);
    const measure = d?.measures.find((m) => m.name === measureName);
    if (d && measure) out.push(...dashboardsReferencing(new Set([measureMember(d, measure)])));
    return dedupe(out);
  }

  const kind = grantKindFor(prefix);

  // DATASET → dashboards (via its members) + metrics count. A metric is not a separate
  // dependent to list (it vanishes WITH the dataset), but the dashboards + apps/agents that
  // point at it are the ones that break.
  if (prefix === 'ds' || prefix === 'dataset') {
    out.push(...dashboardsReferencing(new Set(datasetMembers(artifactId))));
  }

  // GRANT edges — apps + agents that were granted this id directly (dataset/knowledge/file/
  // connection). Metrics-as-grant are covered via the dashboard walk above.
  if (kind) {
    for (const app of await listAllAppsInternal()) {
      if (isGranted(app.grants, kind, artifactId)) {
        out.push({ kind: 'app', id: app.id, name: app.name, tab: 'software' });
      }
    }
    for (const sys of listAllSystemsInternal()) {
      if (agentGrantList(sys.grants, kind).some((g) => g.id === artifactId && !g.folder)) {
        out.push({ kind: 'agent', id: sys.id, name: sys.name, tab: 'agents' });
      }
    }
  }

  return dedupe(out);
}

function dedupe(list: Dependent[]): Dependent[] {
  const seen = new Set<string>();
  const out: Dependent[] = [];
  for (const d of list) {
    const key = `${d.tab}:${d.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}
