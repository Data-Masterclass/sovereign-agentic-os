/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { addComponent } from '@/lib/bigbets/store';
import { actor } from '@/lib/bigbets/server';
import { type Tab } from '@/lib/bigbets/model';

export const dynamic = 'force-dynamic';

const TABS: Tab[] = ['data', 'metric', 'dashboard', 'software', 'agent', 'ml', 'knowledge', 'files', 'connection'];

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * POST → add a component to the bet. Either links an existing artifact (`artifactId`)
 * or scaffolds a new one via the tab's governed create flow (`scaffold:{title}`),
 * tagging it with the bet id. Reuse, never fork.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const b = await req.json().catch(() => ({}));
    if (!TABS.includes(b.tab)) return NextResponse.json({ error: `tab must be one of ${TABS.join(', ')}` }, { status: 400 });
    if (!b.plannedReady) return NextResponse.json({ error: 'plannedReady (yyyy-mm-dd) is required' }, { status: 400 });
    const { ref } = addComponent(id, actor(user), {
      tab: b.tab,
      artifactId: typeof b.artifactId === 'string' ? b.artifactId : undefined,
      scaffold: b.scaffold?.title ? { title: b.scaffold.title, consumes: b.scaffold.consumes } : undefined,
      start: b.start,
      plannedReady: b.plannedReady,
      dependsOn: Array.isArray(b.dependsOn) ? b.dependsOn : undefined,
      weight: typeof b.weight === 'number' ? b.weight : undefined,
    });
    return NextResponse.json({ refId: ref.id, artifactId: ref.artifactId });
  } catch (e) {
    return fail(e);
  }
}
