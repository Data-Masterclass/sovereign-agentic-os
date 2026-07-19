/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getAppForUser, updateAppDocs, patchAppDesign, type AppEpic } from '@/lib/software/apps';
import { normalizeContextGrants } from '@/lib/core/context-grants';
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

/**
 * Edit the app's captured docs (design decisions / data descriptions / docs) AND its
 * Define/Design surfaces (purpose · epics · context grants). Both go through the same
 * owner-or-domain-admin edit-scope in the lib layer. A body carrying only design/data/
 * docs keeps the historic behaviour; purpose/epics/grants patch the new fields.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json();

    // Define/Design fields, when present, persist through patchAppDesign.
    const hasDesign =
      body?.purpose !== undefined || body?.epics !== undefined || body?.grants !== undefined;
    if (hasDesign) {
      const app = await patchAppDesign(id, user, {
        purpose: body?.purpose !== undefined ? String(body.purpose) : undefined,
        epics: body?.epics !== undefined ? (body.epics as AppEpic[]) : undefined,
        grants: body?.grants !== undefined ? normalizeContextGrants(body.grants) : undefined,
      });
      return NextResponse.json({ app });
    }

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
