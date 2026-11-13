/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { readProjectBlob } from '@tabs/data/lib/dbt/read';

export const dynamic = 'force-dynamic';

/** GET /api/data/projects/<domain>/blob?ref=<sha|main>&path=<file> → one file of the project at a ref. */
export const GET = withRoute<{ domain: string }>(async ({ user, params, req }) => {
  const q = new URL(req.url).searchParams;
  return NextResponse.json(await readProjectBlob(params.domain, user, q.get('ref') ?? undefined, q.get('path') ?? ''));
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
