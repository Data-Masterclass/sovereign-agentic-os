/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/experimental/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';

export const dynamic = 'force-dynamic';

/**
 * "Connect your own BI" surface for the Govern stage: the caller's default domain, which
 * scopes the Power BI / Tableau connection export against governed Trino. Dashboards are
 * rendered natively in the OS — there is no external BI console to link out to. No secrets
 * here.
 */
export const GET = withRoute(async ({ user }) => {
  return NextResponse.json({ domain: user.domains[0] ?? '' });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
