/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { getDataset } from '@tabs/data/lib/store';
import { lineageFor } from '@tabs/data/lib/lineage';
import { getDashboard } from '@tabs/dashboards/lib/store';
import { panelMetrics } from '@tabs/dashboards/lib/model';
import { getAppForUser } from '@tabs/software/lib/apps';

/**
 * `get_lineage(ref)` — ONE normalized lineage graph across every artifact kind
 * (mcp-v2 P0.3). A THIN dispatcher: it parses `kind:id` and routes to the EXISTING
 * per-artifact collector, then normalizes to `{nodes, edges}`. It re-implements no
 * collector. canView is enforced at the ROOT (an unseeable root is not_found);
 * unviewable nodes render as `{redacted:true, kind}` (existence without content).
 */

export type UnifiedNode = { id: string; kind: string; label: string; redacted?: boolean };
export type UnifiedEdge = { from: string; to: string; rel: string };
export type UnifiedLineage = { ref: string; kind: LineageRefKind; id: string; nodes: UnifiedNode[]; edges: UnifiedEdge[] };

export type LineageRefKind = 'dataset' | 'metric' | 'dashboard' | 'app';
const REF_KINDS: readonly LineageRefKind[] = ['dataset', 'metric', 'dashboard', 'app'];

function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}

/** Parse `kind:id`. */
export function parseRef(ref: string): { kind: LineageRefKind; id: string } {
  const idx = ref.indexOf(':');
  if (idx <= 0) fail(`ref must be "<kind>:<id>", e.g. "dataset:ds_ab12cd" (got "${ref}")`, 400);
  const kind = ref.slice(0, idx);
  const id = ref.slice(idx + 1).trim();
  if (!REF_KINDS.includes(kind as LineageRefKind)) fail(`unknown lineage kind "${kind}" — one of ${REF_KINDS.join(', ')}`, 400);
  if (!id) fail('ref is missing an id after the ":"', 400);
  return { kind: kind as LineageRefKind, id };
}

export async function getLineage(ref: string, user: CurrentUser): Promise<UnifiedLineage> {
  const { kind, id } = parseRef(ref);
  const p = { id: user.id, domains: user.domains, role: user.role };
  const out: UnifiedLineage = { ref, kind, id, nodes: [], edges: [] };

  switch (kind) {
    case 'dataset':
    case 'metric': {
      // metric:<id> resolves to the gold dataset that carries the measure; both
      // render the dataset's version→metric→dashboard→upstream graph.
      const d = getDataset(id, p); // throws 403/404 → not_found at the root
      const g = lineageFor(d);
      for (const n of g.nodes) out.nodes.push({ id: n.id, kind: n.kind, label: n.label });
      for (const e of g.edges) out.edges.push({ from: e.from, to: e.to, rel: e.kind });
      return out;
    }
    case 'dashboard': {
      const dash = getDashboard(id, p); // throws 403/404
      out.nodes.push({ id: dash.id, kind: 'dashboard', label: dash.spec.name });
      for (const c of dash.spec.charts) {
        for (const metricId of panelMetrics(c)) {
          out.nodes.push({ id: metricId, kind: 'metric', label: metricId });
          out.edges.push({ from: dash.id, to: metricId, rel: 'reads' });
        }
      }
      return out;
    }

    case 'app': {
      const app = await getAppForUser(id, user); // throws 403/404
      out.nodes.push({ id: app.id, kind: 'app', label: app.name });
      for (const c of app.consumes) {
        out.nodes.push({ id: c.ref, kind: c.kind, label: c.label });
        out.edges.push({ from: app.id, to: c.ref, rel: 'consumes' });
      }
      return out;
    }
    default:
      fail(`unsupported lineage kind ${kind}`, 400);
  }
}
