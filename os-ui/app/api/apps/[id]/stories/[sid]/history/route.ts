/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - the version history of one epic or story (diff, author, source)
 * USER STORY: As a business user I want to see every version of a story: who changed it, when, from where, and what.
 * ARCHITECTURE:
 *   - Thin shell over `specHistory` (tabs/software/lib/stories/history.ts), the read `get_story_history` uses too.
 *     The App Builder guard runs first; the caller must be able to see the app. Read-only.
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { specHistory } from '@tabs/software/lib/stories/history';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; sid: string }> };

const get = withRoute<{ id: string; sid: string }>(async ({ user, params }) => {
  return NextResponse.json({ id: params.sid, versions: await specHistory(params.id, user, params.sid) });
}, { defaultStatus: 500 });

export async function GET(req: Request, ctx: Ctx) {
  return appBuilderDisabledResponse() ?? get(req, ctx);
}
