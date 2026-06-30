/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { listReviewCards } from '@/lib/software/review';

export const dynamic = 'force-dynamic';

/**
 * The Builder's deploy-review inbox — pending review cards for the caller's
 * domains. Only Builders/Admins decide them (enforced on POST), but the list is
 * visible so a creator can see their request is queued.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const cards = user.domains.flatMap((d) => listReviewCards({ domain: d }));
    const canReview = user.role === 'builder' || user.role === 'admin';
    return NextResponse.json({ user, cards, canReview });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
