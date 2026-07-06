/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getBet } from '@/lib/bigbets/store';
import { principal } from '@/lib/bigbets/server';
import { sourceFor } from '@/lib/bigbets/sources';
import { type Tab } from '@/lib/bigbets/model';

export const dynamic = 'force-dynamic';

const TABS: Tab[] = ['data', 'metric', 'dashboard', 'software', 'agent', 'ml', 'knowledge', 'files', 'connection'];

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * GET → list artifacts the caller can see for a given tab, so the component
 * picker can browse and choose rather than paste a raw id.
 *
 * canView-scoped: admin sees all; others see non-personal artifacts OR artifacts
 * whose domain is in their own domains (the same visibility gate that governs
 * the rest of the BigBets surface — never trust the client id; attachment is
 * still re-resolved server-side by the POST /components route).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const p = principal(user);

    // Scope gate: confirm the caller can view this bet.
    getBet(id, p);

    const url = new URL(req.url);
    const tab = url.searchParams.get('tab') as Tab | null;
    if (!tab || !TABS.includes(tab)) {
      return NextResponse.json({ error: `tab must be one of: ${TABS.join(', ')}` }, { status: 400 });
    }

    const all = sourceFor(tab).list();

    // canView filter: admin sees everything; others see shared/certified/marketplace
    // artifacts, or personal artifacts that live in their own domain.
    const visible = p.role === 'admin'
      ? all
      : all.filter((a) => a.visibility !== 'personal' || p.domains.includes(a.domain));

    return NextResponse.json({
      artifacts: visible.map((a) => ({
        id: a.id,
        title: a.title,
        tab: a.tab,
        lifecycle: a.lifecycle,
        visibility: a.visibility,
      })),
    });
  } catch (e) {
    return fail(e);
  }
}
