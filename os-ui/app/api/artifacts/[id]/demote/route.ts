/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getArtifact } from '@/lib/core/artifacts';
import { demoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

/** Revoke sharing one step: Certified → Shared (admin) → Personal (owner/in-domain
 *  builder+). Runs THROUGH the governed demote seam (role + audit); the store fn
 *  re-enforces the gate. Never deletes the artifact — only lowers its tier. */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  await demoteThroughSeam('artifact', id, user);
  const item = await getArtifact(id);
  return NextResponse.json({ item });
}, { defaultStatus: 500 });
