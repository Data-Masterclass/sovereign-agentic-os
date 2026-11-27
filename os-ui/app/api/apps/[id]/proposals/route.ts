/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder B - the diff cards of an app, its unreviewed changes and its story lights
 * USER STORY: As anyone who can see the app I want to see every proposed story change (including the ones a git push
 *             created), which ones still block going live, and each story's test light.
 * ARCHITECTURE:
 *   - Thin shell over `listProposals` and `refreshStoryLights` (the same functions `list_requirement_proposals` calls).
 *     The App Builder guard runs first; the caller must be able to see the app. Read-only apart from re-deriving the
 *     light cache from the app's own check records.
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { listProposals } from '@tabs/software/lib/stories/proposals';
import { refreshStoryLights } from '@tabs/software/lib/stories/lights';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };
const STATUSES = ['pending', 'approved', 'rejected', 'superseded'] as const;

const get = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const status = new URL(req.url).searchParams.get('status');
  if (status !== null && !(STATUSES as readonly string[]).includes(status)) return NextResponse.json({ error: 'status must be pending, approved, rejected or superseded' }, { status: 400 });
  const out = await listProposals(params.id, user, status ? { status: status as (typeof STATUSES)[number] } : {});
  const lights = await refreshStoryLights(out.appId);
  return NextResponse.json({ ...out, lights: lights?.stories ?? {}, evidenceSha: lights?.sha ?? null, truncated: lights?.truncated ?? false });
}, { defaultStatus: 500 });

export async function GET(req: Request, ctx: Ctx) {
  return appBuilderDisabledResponse() ?? get(req, ctx);
}
