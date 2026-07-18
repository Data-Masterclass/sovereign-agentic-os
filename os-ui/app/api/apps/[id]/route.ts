/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getAppForUser, updateAppDocs } from '@/lib/software/apps';
import { reconcileDeployApproval } from '@/lib/software/review';
import { getConnectionByApp } from '@/lib/infra/app-registry';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** One app's full home-of-record (design/data/docs/chat/pipeline/MCP). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const app = await getAppForUser(id, user);
    // SELF-HEAL: if this app is stuck in `review` but its deploy approval was
    // already decided (an orphan from before the approve→decideDeploy write-back),
    // reconcile it to its true state on load. Idempotent + fail-soft (never blocks
    // the load); mutates the same in-cache app object, so the response is healed.
    await reconcileDeployApproval(app);
    const connection = getConnectionByApp(app.id);
    return NextResponse.json({ user, app, connection });
  } catch (e) {
    return fail(e);
  }
}

/** Edit captured design decisions / data descriptions / docs (owner or domain admin). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json();
    const app = await updateAppDocs(id, user, {
      designDecisions: body?.designDecisions !== undefined ? String(body.designDecisions) : undefined,
      dataDescriptions: body?.dataDescriptions !== undefined ? String(body.dataDescriptions) : undefined,
      docs: body?.docs !== undefined ? String(body.docs) : undefined,
    });
    return NextResponse.json({ app });
  } catch (e) {
    return fail(e);
  }
}
