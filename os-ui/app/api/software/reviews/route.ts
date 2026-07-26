/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { listReviewCards } from '@/lib/software/review';
import { roleAtLeast } from '@/lib/core/session';

export const dynamic = 'force-dynamic';

/**
 * The Builder's deploy-review inbox — pending review cards for the caller's
 * domains. Only Builders/Admins decide them (enforced on POST), but the list is
 * visible so a creator can see their request is queued.
 */
export const GET = withRoute(async ({ user }) => {
  const cards = (await Promise.all(user.domains.map((d) => listReviewCards({ domain: d })))).flat();
  const canReview = roleAtLeast(user.role, 'builder');
  return NextResponse.json({ user, cards, canReview });
}, { defaultStatus: 500 });
