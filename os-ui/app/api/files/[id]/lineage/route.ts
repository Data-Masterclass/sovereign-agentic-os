/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/files/lib/server';
import { getFile } from '@tabs/files/lib/store';
import { listLineage } from '@tabs/files/lib/lineage';

export const dynamic = 'force-dynamic';

/** The file's lineage edges (promoted / certified / derived). */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  getFile(id, user); // view-scope guard
  return NextResponse.json({ edges: listLineage(id) });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
