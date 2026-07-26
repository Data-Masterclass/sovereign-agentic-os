/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { rateListing, type Viewer } from '@/lib/marketplace';

export const dynamic = 'force-dynamic';

/** Rate a listing 1..5. Body: { stars }. */
export const POST = withRoute<{ id: string }, { stars?: number }>(async ({ user, params, body }) => {
  const { id } = params;
  const stars = Math.max(1, Math.min(5, Number(body.stars) || 0));
  if (!stars) return NextResponse.json({ error: 'stars must be 1..5' }, { status: 400 });
  const viewer: Viewer = { id: user.id, domains: user.domains, role: user.role };
  const agg = rateListing(id, viewer, stars);
  return NextResponse.json(agg);
}, { parse: true, defaultStatus: 500 });
