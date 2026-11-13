/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { engineeringViewFor } from '@core/mcp/engineering-tools';

export const dynamic = 'force-dynamic';

/**
 * GET /api/engineering/<kind>/<id> → the `EngineeringView` the "Under the hood" panel renders.
 *
 * It calls the SAME function `get_engineering_view` calls, so the UI and the MCP cannot drift:
 * there is one governed path, one object gate (the owning tab's own), and one structure
 * (`core/engineering/types.ts`). A refusal keeps the status the tab's gate threw — 404 for an
 * object that does not exist, 403 for one the caller may not see.
 */
export const GET = withRoute<{ kind: string; id: string }>(async ({ user, params }) => {
  return NextResponse.json(await engineeringViewFor(user, params.kind, params.id));
}, { defaultStatus: 500 });
