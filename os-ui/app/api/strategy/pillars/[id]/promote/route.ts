/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { promotePillar } from '@/lib/strategy/pillars';

export const dynamic = 'force-dynamic';

/**
 * Promote a pillar ONE tier up — the SAME shared <PromoteButton> contract every OS
 * tab speaks (Metrics/Dashboards/Science). Pillars promote DIRECTLY (role-gated in
 * `promotePillar`: Builder+ to Domain, Admin to Company) with no approval queue, so
 * there is never a pending request:
 *   • GET  → `{ request: null }` (the button pre-checks for a pending request).
 *   • POST → promotes in one shot → `{ item }`; a non-approver hits the store's 403.
 */
export const GET = withRoute<{ id: string }>(async () => {
  return NextResponse.json({ request: null });
}, { defaultStatus: 500 });

export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const item = await promotePillar(user, id);
  return NextResponse.json({ item });
}, { defaultStatus: 500 });
