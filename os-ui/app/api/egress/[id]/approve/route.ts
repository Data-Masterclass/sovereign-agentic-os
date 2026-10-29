/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@core/kernel/auth';
import { withRoute } from '@core/kernel/route-server';
import { decideEgress } from '@tabs/connections/lib/index';

export const dynamic = 'force-dynamic';

/**
 * An Administrator approves (or rejects) a Builder's egress request. Approving adds
 * the host to the allowlist so connections to it pass the egress check; all
 * outbound stays logged. Body: { decision?: 'approve' | 'reject' }.
 */
export const POST = withRoute<{ id: string }, { decision?: string }>(async ({ user: admin, params, body }) => {
  const { id } = params;
  const decision = body?.decision === 'reject' ? 'reject' : 'approve';
  const r = decideEgress(id, decision, admin.id);
  if (!r) return NextResponse.json({ error: 'Egress request not found' }, { status: 404 });
  return NextResponse.json({ request: r });
}, { parse: true, gate: requireAdmin, defaultStatus: 500 });
