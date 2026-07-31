/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
import { getDataset, listJoinable } from '@/lib/data/store';

export const dynamic = 'force-dynamic';

/**
 * The Gold join picker's source: the OTHER datasets the caller may REUSE. Identity is
 * from the signed session; {@link listJoinable} is `canView`- AND active-domain-scoped,
 * so a non-visible or other-domain dataset can never appear here. `getDataset(id)`
 * first re-checks the base is viewable.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  getDataset(id, user); // view-scope guard on the base dataset
  return NextResponse.json({ datasets: listJoinable(user, id) });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
