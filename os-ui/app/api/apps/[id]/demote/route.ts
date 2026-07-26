/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getAppForUser } from '@/lib/software/apps';
import { demoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

/**
 * Revoke sharing on an app (+ its data/files/connection) one step down:
 * Marketplace → Shared (Admin) → Personal (owner/in-domain Builder+). Runs THROUGH
 * the governed demote seam — role-gated AND LINEAGE-AWARE (blocked while another app
 * depends on this one). Never deletes the app; only lowers its visibility.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  await demoteThroughSeam('app', id, user);
  const app = await getAppForUser(id, user);
  return NextResponse.json({ app });
}, { defaultStatus: 500 });
