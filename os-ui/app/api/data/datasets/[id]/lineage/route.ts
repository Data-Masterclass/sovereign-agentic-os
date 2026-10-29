/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { getDataset } from '@tabs/data/lib/store';
import { lineageFor } from '@tabs/data/lib/lineage';

export const dynamic = 'force-dynamic';

/** End-to-end lineage (refinement + consumption + trust) + transparency-gate status. */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  return NextResponse.json(lineageFor(getDataset(id, user)));
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
