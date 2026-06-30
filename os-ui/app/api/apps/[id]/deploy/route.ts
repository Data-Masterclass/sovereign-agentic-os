/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { startPreview, requestDeploy } from '@/lib/software/review';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * Deploy surface (Software golden path §C/§D). `?action=preview` starts the free
 * private sandbox preview; the default action requests a domain deploy, which
 * opens the Builder review gate (or auto-deploys a routine in-envelope change).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    if (action === 'preview') {
      const app = await startPreview(id, user);
      return NextResponse.json({ app });
    }
    const result = await requestDeploy(id, user);
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
