/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
import { getDataset } from '@/lib/data/store';
import { lineageFor } from '@/lib/data/lineage';

export const dynamic = 'force-dynamic';

/** End-to-end lineage (refinement + consumption + trust) + transparency-gate status. */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  return NextResponse.json(lineageFor(getDataset(id, user)));
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
