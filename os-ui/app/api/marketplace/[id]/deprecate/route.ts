/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { requireAdmin } from '@/lib/core/auth';
import { publishAdapter, type Viewer } from '@/lib/marketplace';

export const dynamic = 'force-dynamic';

/** Lineage-aware deprecate (admin, owning domain). Returns the warned importers. */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const viewer: Viewer = { id: user.id, domains: user.domains, role: user.role };
  const result = await publishAdapter.deprecate(id, viewer);
  return NextResponse.json(result);
}, { gate: requireAdmin, defaultStatus: 500 });
