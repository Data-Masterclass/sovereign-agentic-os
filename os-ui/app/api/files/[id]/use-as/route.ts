/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { useAsKnowledge, useAsData } from '@/lib/files/use-as';

export const dynamic = 'force-dynamic';

/**
 * "Use as" handoff: distil a file into Knowledge (tacit/doc) or Data (Bronze
 * dataset). POST { target: 'knowledge' | 'data' }. Returns the derived artifact's
 * handle so the UI can open the matching tab (lineage recorded in OM).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { target?: string };
    if (body.target === 'knowledge') return NextResponse.json(await useAsKnowledge(id, user));
    if (body.target === 'data') return NextResponse.json(await useAsData(id, user));
    return NextResponse.json({ error: "target must be 'knowledge' or 'data'" }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}
