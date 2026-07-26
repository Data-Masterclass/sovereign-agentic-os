/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { homeFeed } from '@/lib/home/feed';

export const dynamic = 'force-dynamic';

/** The signed-in viewer's full Home feed — OPA/RLS-scoped (see lib/home/feed). */
export const GET = withRoute(async ({ user }) => {
  const feed = await homeFeed(user);
  return NextResponse.json({ user, feed });
}, { defaultStatus: 500 });
