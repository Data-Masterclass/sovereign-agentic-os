/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getViewSurface, setViewSurface, isViewSurface } from '@core/prefs/view-surface';

export const dynamic = 'force-dynamic';

/** GET /api/prefs/view-surface → { surface } — the session user's Studio|Run choice. */
export const GET = withRoute(async ({ user }) => {
  const surface = await getViewSurface(user.id, user.role);
  return NextResponse.json({ surface });
}, { defaultStatus: 500 });

/** PUT /api/prefs/view-surface { surface } — the user id always comes from the session. */
export const PUT = withRoute<Record<string, string>, Record<string, unknown>>(async ({ user, body }) => {
  const surface = body?.surface;
  if (!isViewSurface(surface)) {
    return NextResponse.json({ error: 'surface must be "studio" or "run"' }, { status: 400 });
  }
  await setViewSurface(user.id, surface);
  return NextResponse.json({ ok: true, surface });
}, { parse: true, defaultStatus: 500 });
