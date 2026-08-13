/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { publishApp } from '@/lib/software/apps';

export const dynamic = 'force-dynamic';

/**
 * POST /api/apps/[id]/publish — PROMOTE the autosaved `draftSpec` to LIVE (os-ui 0.6.135, the
 * ONE explicit go-live gate). Calls `publishApp` AS the signed-in user: the draft is validated
 * with the FULL serving gate (parse + validate); a blocking draft comes back as `{ issues }`
 * (200 — the composer surfaces them inline) with NOTHING promoted, and a clean draft goes live at
 * `/apps/<slug>` immediately (same-origin OS render) while a version is snapshotted with an auto
 * name + deterministic change summary.
 *
 * We return 200 with `{ ok, issues }` (not 4xx) so the client treats validation as normal form
 * state, not a transport error — `publishApp` only throws for authz/404/409.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { app, issues, warnings, version } = await publishApp(params.id, user);
  return NextResponse.json({
    ok: issues.length === 0,
    issues,
    warnings,
    slug: app.slug,
    serveMode: app.serveMode,
    version: version ? { version: version.version, name: (version.state as { name?: string })?.name, summary: version.summary } : null,
  });
}, { defaultStatus: 500 });
