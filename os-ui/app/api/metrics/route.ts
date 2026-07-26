/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { listMetrics } from '@/lib/metrics/store';

export const dynamic = 'force-dynamic';

/**
 * The governed metric registry — every measure the user can see, grouped Mine / Domain /
 * Marketplace, each with its canonical Cube member (the single source of the number that
 * the explorer, dashboards and the agent `metrics` tool all resolve). Derived read-only
 * from the Data tab's datasets, so defining a measure is the single write.
 */
export const GET = withRoute(async ({ user, req }) => {
  // ?archived=1 additionally returns soft-archived metrics (their own section),
  // so an archived metric stays openable → its detail exposes Restore + Delete.
  const includeArchived = new URL(req.url).searchParams.get('archived') === '1';
  return NextResponse.json(listMetrics(user, { includeArchived }));
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
