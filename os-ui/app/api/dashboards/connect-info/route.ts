/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';

export const dynamic = 'force-dynamic';

/**
 * Tier-2 "connected tools" surface for the Govern stage: the caller's default domain (for
 * the Power BI / Tableau connection export) and the OPTIONAL external Superset console URL.
 * `supersetUrl` is returned ONLY when the operator configured a non-empty console URL — the
 * UI hides the "Open in Superset" link otherwise (no dead link). No secrets here.
 */
export const GET = withRoute(async ({ user }) => {
  const supersetUrl = (config.supersetUrl ?? '').trim();
  return NextResponse.json({
    domain: user.domains[0] ?? '',
    supersetUrl: supersetUrl || null,
  });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
