/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { startPreview, requestDeploy, reconcileDeployStatus } from '@/lib/software/review';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * Live runner status. Polls the app's REAL in-cluster Deployment and reconciles
 * the served URL + `deploying → running → failed` transition off actual pod
 * state (not a timer). The client can poll this after a preview/go-live to watch
 * the app come up. Offline (no cluster) it reports `offline` and mutates nothing.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const { app, status } = await reconcileDeployStatus(id, user);
    return NextResponse.json({ app, status });
  } catch (e) {
    return fail(e);
  }
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
