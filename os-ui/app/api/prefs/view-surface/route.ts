/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute, apiError } from '@core/kernel/route-server';
import { getViewSurface, setViewSurface, isViewSurface } from '@core/prefs/view-surface';
import { appBuilderEnabled } from '@core/kernel/app-builder-flag';

export const dynamic = 'force-dynamic';

/**
 * GET /api/prefs/view-surface → { surface } — the session user's Studio|Run choice. App Builder (F): adds
 * `appBuilder: true` ONLY when the switch is on, so the header labels the surfaces Dev | Prod; with it off the
 * response is exactly `{ surface }` as before.
 */
export const GET = withRoute(async ({ user }) => {
  const surface = await getViewSurface(user.id, user.role);
  return NextResponse.json(appBuilderEnabled() ? { surface, appBuilder: true } : { surface });
}, { defaultStatus: 500 });

/** PUT /api/prefs/view-surface { surface } — the user id always comes from the session. */
export const PUT = withRoute<Record<string, string>, Record<string, unknown>>(async ({ user, body }) => {
  const surface = body?.surface;
  if (!isViewSurface(surface)) {
    return apiError(400, 'surface must be "studio" or "run"', 'governance.prefs.viewSurfaceInvalid');
  }
  await setViewSurface(user.id, surface);
  return NextResponse.json({ ok: true, surface });
}, { parse: true, defaultStatus: 500 });
