/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getSystem } from '@/lib/agents/store';
import { listDatasets, ensureHydrated } from '@/lib/data/store';
import { listWorkflows, ensureHydrated as ensureWorkflowsHydrated } from '@/lib/knowledge/store';
import { listPersonalKnowledge, ensureHydrated as ensurePersonalHydrated } from '@/lib/knowledge/personal-store';
import { listMetrics } from '@/lib/metrics/store';
import { listConnectionsForUser } from '@/lib/connections';
import { listFiles, ensureHydrated as ensureFilesHydrated } from '@/lib/files/store';
import { listFolders, ensureHydrated as ensureFoldersHydrated, type FolderTab } from '@/lib/folders';

export const dynamic = 'force-dynamic';

/**
 * GET → the artifacts of a given `kind` the caller can actually see, so the
 * Grants & Routing picker can BROWSE + choose per-artifact access rather than
 * paste a raw id. Mirrors `app/api/big-bets/[id]/components/available`: every
 * item is produced by the SAME canView/role-scoped list the rest of the OS uses
 * (personal + own-domain shared + marketplace), so this never leaks another
 * user's private drafts or another domain's artifacts.
 *
 * Response: `{ items: [{ id, name, scope, folder? }], folders?: [{ path, scope }] }`.
 * DATA items additionally carry `layers` (which medallion layers are BUILT) so the
 * grant picker only ever offers a real, queryable Bronze/Silver/Gold choice. For the
 * FOLDERED kinds (data · knowledge · files) each item carries its `folder` path AND
 * the response returns the folder nodes for the personal + domain trees, so the
 * Wave-3 checkbox tree can render folders + items and emit folder grants. The feed is
 * ALREADY DLS-scoped, so a folder that holds ungrantable items simply shows fewer
 * items — the tree renders tri-state and the "grants N of M" honesty follows.
 */
// `connections` (plural) is the Simple-builder GrantKind spelling; `connection`
// (singular) is the original Grants-panel spelling — both resolve to the same list.
type Kind = 'data' | 'knowledge' | 'files' | 'connection' | 'connections' | 'metric';
const KINDS: Kind[] = ['data', 'knowledge', 'files', 'connection', 'connections', 'metric'];

/** The kinds that carry folders — the ones whose feed returns folder nodes. */
const FOLDER_TABS: Record<string, FolderTab> = { data: 'data', knowledge: 'knowledge', files: 'files' };

type Item = {
  id: string;
  name: string;
  scope: 'personal' | 'domain' | 'marketplace';
  /** DATA only: which medallion layers are built (so the picker offers real layers). */
  layers?: ('bronze' | 'silver' | 'gold')[];
  /** FOLDERED kinds only: the folder path this item lives in (normalised; `'/'` = root). */
  folder?: string;
};

type FolderNodeOut = { path: string; scope: 'personal' | 'domain' };

/** The built medallion layers of a dataset summary, from its B/S/G dots. */
function builtLayers(dots: { bronze: boolean; silver: boolean; gold: boolean }): ('bronze' | 'silver' | 'gold')[] {
  const out: ('bronze' | 'silver' | 'gold')[] = [];
  if (dots.bronze) out.push('bronze');
  if (dots.silver) out.push('silver');
  if (dots.gold) out.push('gold');
  return out;
}

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const principal = { id: user.id, domains: user.domains, role: user.role };

    // Scope gate: confirm the caller can view this system (throws 403/404).
    getSystem(id, principal);

    const kind = new URL(req.url).searchParams.get('kind') as Kind | null;
    if (!kind || !KINDS.includes(kind)) {
      return NextResponse.json({ error: `kind must be one of: ${KINDS.join(', ')}` }, { status: 400 });
    }

    let items: Item[] = [];
    if (kind === 'data') {
      await ensureHydrated();
      const g = listDatasets(principal);
      items = [
        ...g.mine.map((d) => ({ id: d.id, name: d.name, scope: 'personal' as const, layers: builtLayers(d.dots), folder: d.folder })),
        ...g.domain.map((d) => ({ id: d.id, name: d.name, scope: 'domain' as const, layers: builtLayers(d.dots), folder: d.folder })),
        ...g.marketplace.map((d) => ({ id: d.id, name: d.name, scope: 'marketplace' as const, layers: builtLayers(d.dots), folder: d.folder })),
      ];
    } else if (kind === 'knowledge') {
      // Hydrate both knowledge stores before listing (best-effort; OS-mirror backed).
      await Promise.all([ensureWorkflowsHydrated(), ensurePersonalHydrated()]);
      const wf = listWorkflows(principal);
      const pk = listPersonalKnowledge(principal);
      items = [
        // Workflows (wf_xxx) — no folder support ⇒ live at root.
        ...wf.mine.map((w) => ({ id: w.id, name: w.title, scope: 'personal' as const, folder: '/' })),
        ...wf.domain.map((w) => ({ id: w.id, name: w.title, scope: 'domain' as const, folder: '/' })),
        ...wf.marketplace.map((w) => ({ id: w.id, name: w.title, scope: 'marketplace' as const, folder: '/' })),
        // Personal knowledge entries (pk_xxx) — same canView scoping, separate store; foldered.
        ...pk.mine.map((p) => ({ id: p.id, name: p.title, scope: 'personal' as const, folder: p.folder })),
        ...pk.domain.map((p) => ({ id: p.id, name: p.title, scope: 'domain' as const, folder: p.folder })),
        ...pk.marketplace.map((p) => ({ id: p.id, name: p.title, scope: 'marketplace' as const, folder: p.folder })),
      ];
    } else if (kind === 'files') {
      await ensureFilesHydrated();
      const g = listFiles(principal);
      items = [
        ...g.mine.map((f) => ({ id: f.id, name: f.name, scope: 'personal' as const, folder: f.folder })),
        ...g.domain.map((f) => ({ id: f.id, name: f.name, scope: 'domain' as const, folder: f.folder })),
        ...g.marketplace.map((f) => ({ id: f.id, name: f.name, scope: 'marketplace' as const, folder: f.folder })),
      ];
    } else if (kind === 'metric') {
      await ensureHydrated();
      const g = listMetrics(principal);
      const nm = (m: { datasetName: string; name: string }) => `${m.datasetName} · ${m.name}`;
      items = [
        ...g.mine.map((m) => ({ id: m.id, name: nm(m), scope: 'personal' as const })),
        ...g.domain.map((m) => ({ id: m.id, name: nm(m), scope: 'domain' as const })),
        ...g.marketplace.map((m) => ({ id: m.id, name: nm(m), scope: 'marketplace' as const })),
      ];
    } else {
      // connection / connections — the async, already canView-scoped list.
      const conns = await listConnectionsForUser(user);
      items = conns.map((c) => ({
        id: c.id,
        name: c.name,
        scope:
          c.visibility === 'Certified' ? 'marketplace' : c.visibility === 'Shared' ? 'domain' : 'personal',
      }));
    }

    // For the foldered kinds, also return the folder nodes (personal + domain trees)
    // so the Wave-3 checkbox tree can render folders alongside items. The SAME governed
    // `listFolders(viewer, tab, scope)` the tabs use — never another user's private tree.
    let folders: FolderNodeOut[] | undefined;
    const tab = FOLDER_TABS[kind];
    if (tab) {
      await ensureFoldersHydrated();
      const viewer = { id: user.id, role: user.role, domains: user.domains };
      folders = [
        ...listFolders(viewer, tab, 'personal').map((f) => ({ path: f.path, scope: 'personal' as const })),
        ...listFolders(viewer, tab, 'domain').map((f) => ({ path: f.path, scope: 'domain' as const })),
      ];
    }

    return NextResponse.json(folders ? { items, folders } : { items });
  } catch (e) {
    return fail(e);
  }
}
