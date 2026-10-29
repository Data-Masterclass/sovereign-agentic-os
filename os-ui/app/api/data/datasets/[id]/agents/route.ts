/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { getSystemsUsingDataset, ensureHydrated } from '@tabs/agents/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Agent systems that use THIS dataset — the reverse list the Data tab's Publish stage
 * shows ("agent systems that consume this dataset", each linking to the Agents tab).
 * Read-only over the RLS-scoped system registry, filtered to a per-item data grant.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  await ensureHydrated();
  const { id } = params;
  return NextResponse.json({ systems: getSystemsUsingDataset(id, user) });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
