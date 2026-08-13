/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { setAppSpec } from '@/lib/software/apps';

export const dynamic = 'force-dynamic';

/**
 * POST /api/apps/[id]/spec — the INTERNAL save door for the Build-stage COMPOSE UI (AppSpec Phase
 * 4a). It calls `setAppSpec` AS the signed-in user, i.e. the SAME governed write path the MCP tool
 * uses (owner-or-in-domain-builder authz, `parseAppSpec` structural gate + `validateAppSpec`
 * semantic gate). A spec with any BLOCKING issue is returned as `{ issues }` and NOT persisted (200
 * — the composer surfaces them inline); a clean spec is set, `serveMode` flips to 'spec', the app is
 * persisted, and any non-blocking `warnings` come back so the UI can caveat them. On success the
 * spec is live at `/apps/<slug>` immediately (same-origin OS render, no build).
 *
 * We deliberately return 200 with `{ issues }` (rather than 4xx) so the client treats validation
 * feedback as normal form state, not a transport error — `setAppSpec` only throws for authz/404/409.
 */
export const POST = withRoute<{ id: string }, { spec?: unknown }>(async ({ user, params, body }) => {
  const { app, issues, warnings, version } = await setAppSpec(params.id, body?.spec, user);
  return NextResponse.json({
    ok: issues.length === 0,
    issues,
    warnings,
    // Echo the served slug so the composer can link straight to the live app on success.
    slug: app.slug,
    serveMode: app.serveMode,
    // A governed author = a versioned publish (0.6.136): the snapshot for the version history.
    version,
  });
}, { parse: true, defaultStatus: 500 });
