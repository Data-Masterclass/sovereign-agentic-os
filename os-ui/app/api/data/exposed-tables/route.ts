/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { roleAtLeast } from '@core/kernel/session';
import { listExposedTablesForUser } from '@tabs/connections/lib/exposed-tables';
import { config } from '@core/kernel/config';

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
 *
 * It also answers `scheduling`: `'dagster'` when `DATA_PROJECT_GIT` is on and `'off'` when it is
 * not — the adopt dialog offers a cadence BEFORE the dataset exists, so it has no sync status to
 * read the truth from, and a cadence picker that cannot say "nothing will run this" is a lie
 * (review M-7). One boolean of server state, not a capability endpoint of its own.
 */
export const GET = withRoute(async ({ user }) => {
  const scheduling = config.dataProjectGit ? 'dagster' : 'off';
  if (!roleAtLeast(user.role, 'domain_admin')) {
    return NextResponse.json({ connections: [], scheduling });
  }
  const connections = await listExposedTablesForUser(user);
  return NextResponse.json({ connections, scheduling });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
