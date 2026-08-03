/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getDashboard } from '@/lib/dashboards';
import { demoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

/** Revoke sharing one step: Marketplace → Domain (admin) → Personal (owner/in-domain
 *  Domain admin). Runs THROUGH the governed demote seam (role + audit); the store fn
 *  re-enforces the gate. Never deletes the dashboard — only lowers its tier. */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  await demoteThroughSeam('dashboard', id, user);
  const item = getDashboard(id, { id: user.id, domains: user.domains, role: user.role });
  return NextResponse.json({ item });
}, { defaultStatus: 500 });
