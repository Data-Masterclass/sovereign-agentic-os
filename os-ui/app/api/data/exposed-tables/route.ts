/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
import { roleAtLeast } from '@/lib/core/session';
import { config } from '@/lib/core/config';
import { listExposedTablesForUser } from '@/lib/connections/exposed-tables';

export const dynamic = 'force-dynamic';

/**
 * The Adopt browse surface (lakehouse-import-exposure.md, Phase 2): every connection →
 * exposure → table the caller's domain(s) may adopt. Gated by the external-connectors
 * flag AND `domain_admin` (roleAtLeast) — the adoption floor. A caller below the floor,
 * or with the flag off, gets an empty list (the UI simply doesn't offer the card), never
 * a leak of what's exposed elsewhere.
 */
export const GET = withRoute(async ({ user }) => {
  if (!config.externalConnectorsEnabled || !roleAtLeast(user.role, 'domain_admin')) {
    return NextResponse.json({ connections: [] });
  }
  const connections = await listExposedTablesForUser(user);
  return NextResponse.json({ connections });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
