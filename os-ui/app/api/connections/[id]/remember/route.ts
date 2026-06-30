/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { approveAndRemember } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * "Approve & remember" (Mode A) — approve a held write AND create a bounded
 * standing policy so identical calls stop prompting. The owner or a domain
 * Builder/Admin only. Body: { tool, args? }.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json();
    const tool = String(body?.tool ?? '').trim();
    if (!tool) return NextResponse.json({ error: 'A tool name is required' }, { status: 400 });
    const out = await approveAndRemember(id, user, { tool, args: body?.args ?? {} });
    return NextResponse.json(out);
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
