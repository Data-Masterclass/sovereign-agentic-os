/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { listDatasets, ensureHydrated as ensureDataHydrated } from '@/lib/data/store';
import { listWorkflows, ensureHydrated as ensureWorkflowsHydrated } from '@/lib/knowledge/store';
import { listPersonalKnowledge, ensureHydrated as ensurePersonalHydrated } from '@/lib/knowledge/personal-store';
import { listMetrics } from '@/lib/metrics/store';
import { listConnectionsForUser } from '@/lib/connections';
import { listFiles, ensureHydrated as ensureFilesHydrated } from '@/lib/files/store';

export const dynamic = 'force-dynamic';

/**
 * TAB-AGNOSTIC available-artifacts feed for the core ContextGrants picker
 * (components/core/ContextGrants.tsx). Returns the artifacts of a given CONTEXT
 * KIND — connections · data · knowledge · files · metrics — the caller can
 * actually see, so ANY tab (Software today, Wave-2 tabs after) can browse + grant
 * rather than paste a raw id. Every item comes from the SAME canView/RLS-scoped
 * list the owning tab uses (personal + own-domain shared + marketplace), so it
 * never leaks another user's drafts or another domain's artifacts. This is the
 * non-system-scoped sibling of the Agents `…/grants/available` route.
 *
 * Response: `{ items: [{ id, name, scope }] }`.
 */
type Kind = 'connections' | 'data' | 'knowledge' | 'files' | 'metrics';
const KINDS: Kind[] = ['connections', 'data', 'knowledge', 'files', 'metrics'];

type Item = { id: string; name: string; scope: 'personal' | 'domain' | 'marketplace' };

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const principal = { id: user.id, domains: user.domains, role: user.role };

    const kind = new URL(req.url).searchParams.get('kind') as Kind | null;
    if (!kind || !KINDS.includes(kind)) {
      return NextResponse.json({ error: `kind must be one of: ${KINDS.join(', ')}` }, { status: 400 });
    }

    let items: Item[] = [];
    if (kind === 'data') {
      await ensureDataHydrated();
      const g = listDatasets(principal);
      items = [
        ...g.mine.map((d) => ({ id: d.id, name: d.name, scope: 'personal' as const })),
        ...g.domain.map((d) => ({ id: d.id, name: d.name, scope: 'domain' as const })),
        ...g.marketplace.map((d) => ({ id: d.id, name: d.name, scope: 'marketplace' as const })),
      ];
    } else if (kind === 'knowledge') {
      await Promise.all([ensureWorkflowsHydrated(), ensurePersonalHydrated()]);
      const wf = listWorkflows(principal);
      const pk = listPersonalKnowledge(principal);
      items = [
        ...wf.mine.map((w) => ({ id: w.id, name: w.title, scope: 'personal' as const })),
        ...wf.domain.map((w) => ({ id: w.id, name: w.title, scope: 'domain' as const })),
        ...wf.marketplace.map((w) => ({ id: w.id, name: w.title, scope: 'marketplace' as const })),
        ...pk.mine.map((p) => ({ id: p.id, name: p.title, scope: 'personal' as const })),
        ...pk.domain.map((p) => ({ id: p.id, name: p.title, scope: 'domain' as const })),
        ...pk.marketplace.map((p) => ({ id: p.id, name: p.title, scope: 'marketplace' as const })),
      ];
    } else if (kind === 'files') {
      await ensureFilesHydrated();
      const g = listFiles(principal);
      items = [
        ...g.mine.map((f) => ({ id: f.id, name: f.name, scope: 'personal' as const })),
        ...g.domain.map((f) => ({ id: f.id, name: f.name, scope: 'domain' as const })),
        ...g.marketplace.map((f) => ({ id: f.id, name: f.name, scope: 'marketplace' as const })),
      ];
    } else if (kind === 'metrics') {
      await ensureDataHydrated();
      const g = listMetrics(principal);
      const nm = (m: { datasetName: string; name: string }) => `${m.datasetName} · ${m.name}`;
      items = [
        ...g.mine.map((m) => ({ id: m.id, name: nm(m), scope: 'personal' as const })),
        ...g.domain.map((m) => ({ id: m.id, name: nm(m), scope: 'domain' as const })),
        ...g.marketplace.map((m) => ({ id: m.id, name: nm(m), scope: 'marketplace' as const })),
      ];
    } else {
      // connections — the async, already canView-scoped list.
      const conns = await listConnectionsForUser(user);
      items = conns.map((c) => ({
        id: c.id,
        name: c.name,
        scope:
          c.visibility === 'Certified' ? 'marketplace' : c.visibility === 'Shared' ? 'domain' : 'personal',
      }));
    }

    return NextResponse.json({ items });
  } catch (e) {
    return fail(e);
  }
}
