/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { homeFeed } from '@/lib/home/feed';

export const dynamic = 'force-dynamic';

/** The signed-in viewer's full Home feed — OPA/RLS-scoped (see lib/home/feed). */
export async function GET() {
  try {
    const user = await requireUser();
    const feed = await homeFeed(user);
    return NextResponse.json({ user, feed });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
