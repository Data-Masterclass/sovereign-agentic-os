/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getAppBySlugForUser } from '@/lib/software/apps';
import {
  RECORD_TOOLS,
  envelopeAllowsRecordTool,
  executeAppTool,
  recordActor,
} from '@/lib/software/app-records';

export const dynamic = 'force-dynamic';

/**
 * The deployed app's OWN records — the SECOND door onto the same governed record
 * store the app's MCP tools reach (`app/api/apps/[id]/tool/route.ts`). Keyed by the
 * frozen `slug` the app bakes in (`APP_SLUG`), since the deployed app never knows
 * the OS app id. Runs AS the signed-in OS user, so every call is scoped to what that
 * user may see — the app cannot widen its own reach.
 *
 * Two gates:
 *   • ENTRY — `getAppBySlugForUser` returns the app only when it is visible to the
 *     caller; otherwise 404 (identical to the members route).
 *   • ENVELOPE (writes only) — `add`/`export` require the tool in the app's
 *     Builder-APPROVED deploy envelope; otherwise 403 with an honest reason naming
 *     the governance path. Reads (`list`/`get`) are always-on once entry passes.
 *
 *   GET  → list the app's records (read)
 *   POST { record }  → add one record (write — envelope-gated)
 */
export const GET = withRoute<{ slug: string }>(async ({ user, params }) => {
  const app = await getAppBySlugForUser(params.slug, user);
  if (!app) return NextResponse.json({ error: 'App not found' }, { status: 404 });
  const result = await executeAppTool(app, RECORD_TOOLS.list, {}, recordActor(user));
  return NextResponse.json({ result });
}, { defaultStatus: 500 });

export const POST = withRoute<{ slug: string }, { record?: Record<string, unknown> }>(
  async ({ user, params, body }) => {
    const app = await getAppBySlugForUser(params.slug, user);
    if (!app) return NextResponse.json({ error: 'App not found' }, { status: 404 });
    const gate = envelopeAllowsRecordTool(app, RECORD_TOOLS.add);
    if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 403 });
    const record = (body?.record ?? {}) as Record<string, unknown>;
    const result = await executeAppTool(app, RECORD_TOOLS.add, record, recordActor(user));
    return NextResponse.json({ result });
  },
  { parse: true, defaultStatus: 500 },
);
