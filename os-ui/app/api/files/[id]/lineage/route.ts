/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/files/server';
import { getFile } from '@/lib/files/store';
import { listLineage } from '@/lib/files/lineage';

export const dynamic = 'force-dynamic';

/** The file's OpenMetadata lineage edges (promoted / certified / derived). */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  getFile(id, user); // view-scope guard
  return NextResponse.json({ edges: listLineage(id) });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
