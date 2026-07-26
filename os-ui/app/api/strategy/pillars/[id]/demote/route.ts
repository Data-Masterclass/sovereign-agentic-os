/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { demotePillar } from '@/lib/strategy/pillars';

export const dynamic = 'force-dynamic';

/**
 * Revoke sharing on a pillar ONE tier down: Company → Domain (Admin) → My (owner /
 * in-domain Builder+ / Admin). Runs through the role-gated `demotePillar` (mirrors
 * the OS artifact demote ladder). Never deletes the pillar — only lowers its tier.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const item = await demotePillar(user, id);
  return NextResponse.json({ item });
}, { defaultStatus: 500 });
