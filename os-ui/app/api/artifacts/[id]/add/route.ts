/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { addFromMarketplace } from '@/lib/core/artifacts';

export const dynamic = 'force-dynamic';

/** Add a Certified Marketplace artifact into the caller's own workspace. */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const item = await addFromMarketplace(id, user);
  return NextResponse.json({ item }, { status: 201 });
}, { defaultStatus: 500 });
