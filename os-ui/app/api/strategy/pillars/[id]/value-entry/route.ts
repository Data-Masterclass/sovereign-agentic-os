/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { addValueEntry } from '@/lib/strategy/pillars';

export const dynamic = 'force-dynamic';

/**
 * Record a manual monthly value for the pillar's value metric (mode='manual').
 * The newest entry is the headline total; the series feeds the value-history
 * chart. Builder (domain) / Admin (tenant); audited.
 */
export const POST = withRoute<{ id: string }, Record<string, unknown>>(async ({ user, params, body }) => {
  const { id } = params;
  const value = Number(body?.value);
  const month = typeof body?.month === 'string' ? body.month : undefined;
  const item = await addValueEntry(user, id, { value, month });
  return NextResponse.json({ item });
}, { parse: true, defaultStatus: 500 });
