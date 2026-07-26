/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getPillar } from '@/lib/strategy/pillars';
import { recordSnapshot } from '@/lib/strategy/snapshots';

export const dynamic = 'force-dynamic';

/** Capture a monthly actuals snapshot for the pillar (Builder/Admin, audited). */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const pillar = await getPillar(user, id);
  const snapshot = await recordSnapshot(user, pillar);
  return NextResponse.json({ snapshot });
}, { defaultStatus: 500 });
