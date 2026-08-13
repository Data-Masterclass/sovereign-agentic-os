/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { generateAppSpecForApp } from '@/lib/software/appspec/generate-server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/apps/[id]/spec/generate — the "✨ Generate my app" build assistant (0.6.131).
 *
 * The Build stage used to drop the user into an EMPTY composer; there was no server-side generator.
 * This route BUILDS the app UP from the epics/user-stories/requirements the user designed, wired
 * ONLY to the app's granted data. All of that logic now lives in the SHARED governed server
 * function `generateAppSpecForApp` (so the `generate_app_spec` MCP tool and this route can't drift);
 * the route is a thin HTTP shell around it.
 *
 * It DOES NOT persist — the composer loads the returned spec as an editable draft; the user reviews
 * then Saves through the existing POST /api/apps/[id]/spec door. Returns `{ ok, spec }` or
 * `{ ok:false, error, issues? }` (always HTTP 200 so the client treats it as normal form state; the
 * gate/404 throws still fold to their tagged status via withRoute).
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const result = await generateAppSpecForApp(user, params.id);
  return NextResponse.json(result);
}, { defaultStatus: 500 });
