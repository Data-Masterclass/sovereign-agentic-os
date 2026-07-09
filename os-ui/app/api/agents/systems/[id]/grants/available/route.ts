/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getSystem } from '@/lib/agents/store';
import { listDatasets, ensureHydrated } from '@/lib/data/store';
import { listWorkflows } from '@/lib/knowledge/store';
import { listMetrics } from '@/lib/metrics/store';
import { listConnectionsForUser } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * GET → the artifacts of a given `kind` the caller can actually see, so the
 * Grants & Routing picker can BROWSE + choose per-artifact access rather than
 * paste a raw id. Mirrors `app/api/big-bets/[id]/components/available`: every
 * item is produced by the SAME canView/role-scoped list the rest of the OS uses
 * (personal + own-domain shared + marketplace), so this never leaks another
 * user's private drafts or another domain's artifacts.
 *
 * Response: `{ items: [{ id, name, scope: 'personal'|'domain'|'marketplace' }] }`.
 */
type Kind = 'data' | 'knowledge' | 'connection' | 'metric';
const KINDS: Kind[] = ['data', 'knowledge', 'connection', 'metric'];

type Item = { id: string; name: string; scope: 'personal' | 'domain' | 'marketplace' };

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
        ...g.mine.map((d) => ({ id: d.id, name: d.name, scope: 'personal' as const })),
        ...g.domain.map((d) => ({ id: d.id, name: d.name, scope: 'domain' as const })),
        ...g.marketplace.map((d) => ({ id: d.id, name: d.name, scope: 'marketplace' as const })),
      ];
    } else if (kind === 'knowledge') {
      const g = listWorkflows(principal);
      items = [
        ...g.mine.map((w) => ({ id: w.id, name: w.title, scope: 'personal' as const })),
        ...g.domain.map((w) => ({ id: w.id, name: w.title, scope: 'domain' as const })),
        ...g.marketplace.map((w) => ({ id: w.id, name: w.title, scope: 'marketplace' as const })),
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
      // connection — the async, already canView-scoped list.
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
