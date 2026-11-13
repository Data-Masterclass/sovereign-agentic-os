/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { readProject } from '@tabs/data/lib/dbt/read';

export const dynamic = 'force-dynamic';

/**
 * GET /api/data/projects/<domain> → `{ domain, head, tree, log }` of the domain's generated dbt
 * project repository (engine rebuild B1). Domain membership is the gate (403 otherwise); a domain
 * with no repository yet (flag off / nothing committed) is an honest 404. `?limit=` caps the log.
 */
export const GET = withRoute<{ domain: string }>(async ({ user, params, req }) => {
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? '50') || 50;
  return NextResponse.json(await readProject(params.domain, user, { limit }));
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
