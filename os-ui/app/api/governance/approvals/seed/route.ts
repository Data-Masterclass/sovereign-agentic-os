/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { seedGovernanceDemo } from '@/lib/governance/seed';
import { roleAtLeast } from '@/lib/core/session';

export const dynamic = 'force-dynamic';

/**
 * Demo source seeding (mock adapters) so the inbox can be exercised on `kind`.
 * Builder/Admin only; seeds into one of the caller's own domains. The real
 * sources (Software/Agents/Data/Connections) replace this at consolidation.
 */
export const POST = withRoute<Record<string, string>, { domain?: unknown }>(async ({ user, body }) => {
  if (!roleAtLeast(user.role, 'builder')) {
    return NextResponse.json({ error: 'Seeding the demo queue needs a Builder or Admin' }, { status: 403 });
  }
  let domain = user.domains[0] ?? 'sales';
  if (body?.domain && user.domains.includes(String(body.domain))) domain = String(body.domain);
  const seeded = seedGovernanceDemo(domain);
  return NextResponse.json({ seeded: seeded.length, ids: seeded.map((a) => a.id) }, { status: 201 });
}, { parse: true, defaultStatus: 401 });
