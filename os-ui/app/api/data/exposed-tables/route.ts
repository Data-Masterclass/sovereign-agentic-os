/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
import { roleAtLeast } from '@/lib/core/session';
import { listExposedTablesForUser } from '@/lib/connections/exposed-tables';

export const dynamic = 'force-dynamic';

/**
 * The Adopt browse surface (lakehouse-import-exposure.md, Phase 2): every connection →
 * exposure → table the caller's domain(s) may adopt. Gated by `domain_admin` (roleAtLeast)
 * — the adoption floor. The external-connectors flag is NOT required: OPERATIONAL exposures
 * (Salesforce/Kajabi/OData/Workday) are user-facing without it, so blocking them on the
 * flag wrongly hid adoptable operational sources. `listExposedTablesForUser` only ever
 * returns warehouse (which can't exist without the flag) + operational exposures, so a
 * flag-off deployment simply sees only its operational sources — never a leak. A caller
 * below the role floor gets an empty list (the UI omits the card).
 */
export const GET = withRoute(async ({ user }) => {
  if (!roleAtLeast(user.role, 'domain_admin')) {
    return NextResponse.json({ connections: [] });
  }
  const connections = await listExposedTablesForUser(user);
  return NextResponse.json({ connections });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
