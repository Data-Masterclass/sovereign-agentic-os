/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { listReviewCards } from '@tabs/software/lib/review';
import { roleAtLeast } from '@core/kernel/session';

export const dynamic = 'force-dynamic';

/**
 * The Builder's deploy-review inbox — pending review cards for the caller's
 * domains. Only Builders/Admins decide them (enforced on POST), but the list is
 * visible so a creator can see their request is queued.
 */
export const GET = withRoute(async ({ user }) => {
  const cards = (await Promise.all(user.domains.map((d) => listReviewCards({ domain: d })))).flat();
  const canReview = roleAtLeast(user.role, 'builder');
  // May this viewer approve a deploy that has NO security verdict? ADMIN ONLY (2026-11-19) — the
  // audited hatch in `decideDeploy`. Decided here, server-side, so the card never renders a
  // control the server would refuse; `decideDeploy` re-checks it regardless, because a client
  // flag is a hint and never the gate.
  const canAcknowledgeNoScan = roleAtLeast(user.role, 'admin');
  return NextResponse.json({ user, cards, canReview, canAcknowledgeNoScan });
}, { defaultStatus: 500 });
