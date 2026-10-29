/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { roleAtLeast } from '@core/kernel/session';
import { listExposedTablesForUser } from '@tabs/connections/lib/exposed-tables';

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
