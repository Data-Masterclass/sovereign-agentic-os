/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { getDataset } from '@/lib/data/store';
import { lineageFor } from '@/lib/data/lineage';
import { getDashboard } from '@/lib/dashboards/store';
import { getModel } from '@/lib/science/model-service';
import { getBet, canViewComponentDetail } from '@/lib/bigbets/store';
import { buildComposition } from '@/lib/bigbets/composition';
import { getAppForUser } from '@/lib/apps';
import { listingAdapter } from '@/lib/marketplace';

/**
 * `get_lineage(ref)` — ONE normalized lineage graph across every artifact kind
 * (mcp-v2 P0.3). A THIN dispatcher: it parses `kind:id` and routes to the EXISTING
 * per-artifact collector, then normalizes to `{nodes, edges}`. It re-implements no
 * collector. canView is enforced at the ROOT (an unseeable root is not_found) and
 * PER NODE for the cross-scope kinds (bet components, marketplace importers) —
 * unviewable nodes render as `{redacted:true, kind}` (existence without content).
 */

export type UnifiedNode = { id: string; kind: string; label: string; redacted?: boolean };
export type UnifiedEdge = { from: string; to: string; rel: string };
export type UnifiedLineage = { ref: string; kind: LineageRefKind; id: string; nodes: UnifiedNode[]; edges: UnifiedEdge[] };

export type LineageRefKind = 'dataset' | 'metric' | 'dashboard' | 'model' | 'listing' | 'bet' | 'app';
const REF_KINDS: readonly LineageRefKind[] = ['dataset', 'metric', 'dashboard', 'model', 'listing', 'bet', 'app'];

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
        const metricId = c.metric;
        out.nodes.push({ id: metricId, kind: 'metric', label: metricId });
        out.edges.push({ from: dash.id, to: metricId, rel: 'reads' });
      }
      return out;
    }
    case 'model': {
      const m = getModel(id);
      const canSee = m && (m.owner === user.id || user.role === 'admin' || (m.tier !== 'Personal' && user.domains.includes(m.domain)));
      if (!m || !canSee) fail('Model not found', 404);
      out.nodes.push({ id: m.model, kind: 'model', label: `${m.name} (${m.tier})` });
      for (const v of m.versions) {
        const vid = `${m.model}@${v.version}`;
        out.nodes.push({ id: vid, kind: 'model-version', label: `v${v.version} · ${v.stage}` });
        out.edges.push({ from: vid, to: m.model, rel: 'version' });
      }
      return out;
    }
    case 'listing': {
      const detail = await listingAdapter.get(id, { id: user.id, domains: user.domains, role: user.role });
      if (!detail) fail('Listing not found', 404);
      out.nodes.push({ id: detail.id, kind: 'listing', label: detail.name });
      for (const n of detail.lineage) {
        const rel = n.relation === 'importer' ? 'imported-by' : 'built-from';
        out.nodes.push({ id: n.id, kind: n.type, label: n.name });
        if (n.relation === 'importer') out.edges.push({ from: detail.id, to: n.id, rel });
        else out.edges.push({ from: n.id, to: detail.id, rel });
      }
      return out;
    }
    case 'bet': {
      const bet = getBet(id, p); // throws 403/404
      out.nodes.push({ id: bet.id, kind: 'bet', label: bet.name });
      const comp = buildComposition(bet.components.map((c) => c.artifactId));
      const byArtifact = new Map(bet.components.map((c) => [c.artifactId, c]));
      for (const n of comp.nodes) {
        const ref = byArtifact.get(n.id);
        // Per-node redaction: a component whose detail this caller may not see
        // renders as existence-without-content.
        const visible = !ref || canViewComponentDetail(bet, ref, p);
        out.nodes.push(visible ? { id: n.id, kind: n.tab, label: n.title } : { id: n.id, kind: n.tab, label: '', redacted: true });
        out.edges.push({ from: bet.id, to: n.id, rel: n.upstream ? 'depends-on' : 'component' });
      }
      for (const e of comp.edges) out.edges.push({ from: e.from, to: e.to, rel: 'builds-on' });
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
