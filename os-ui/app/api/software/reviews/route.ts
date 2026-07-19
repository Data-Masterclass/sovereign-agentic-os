/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { listReviewCards } from '@/lib/software/review';
import { roleAtLeast } from '@/lib/core/session';

export const dynamic = 'force-dynamic';

/**
 * The Builder's deploy-review inbox — pending review cards for the caller's
 * domains. Only Builders/Admins decide them (enforced on POST), but the list is
 * visible so a creator can see their request is queued.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const cards = (await Promise.all(user.domains.map((d) => listReviewCards({ domain: d })))).flat();
    const canReview = roleAtLeast(user.role, 'builder');
    return NextResponse.json({ user, cards, canReview });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
