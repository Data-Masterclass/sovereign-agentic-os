/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getAppForUser } from '@/lib/software/apps';
import { callAppTool } from '@/lib/software/app-tool-call';
import { recordActor } from '@/lib/software/app-records';

export const dynamic = 'force-dynamic';

/**
 * Call an app's AUTO-GENERATED MCP tool as an agent would (Software golden path
 * §4 + Agent golden path). The call funnels through the SAME governed spine as
 * every other agent tool: OPA-style authorize (here resolved from the app's
 * dynamic grant in the app-registry) + Langfuse trace. A tool the app's MCP did
 * not expose is denied — honest default-deny.
 *
 * EXECUTION honesty: when the app's runner pod is actually RUNNING, the call is
 * proxied to the app's real in-cluster Service per its committed OpenAPI and
 * labelled `source:'live-app'`. Otherwise deterministic seed data keeps the flow
 * demonstrable — ALWAYS labelled `source:'demo-seed'` with a visible note. That
 * live-or-seed execution is the SHARED executor (`executeAppTool`, app-records.ts)
 * the app's own by-slug records routes also call — one store, two doors.
 */

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  const { id } = await ctx.params;

  let body: { tool?: string; args?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let app;
  try {
    app = await getAppForUser(id, user);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 404 });
  }

  const tool = String(body?.tool ?? '');

  // The full governed spine (authorize → hold/deny → execute → trace) lives in
  // lib/software/app-tool-call.ts; the route only maps its result to HTTP.
  const { status, body: payload } = await callAppTool(app, tool, body.args, user.id, body, recordActor(user));
  return NextResponse.json(payload, { status });
}
