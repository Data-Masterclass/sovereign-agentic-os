/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { listMetrics } from '@/lib/metrics/store';
import { appSlugFromRequest, grantedIdSet } from '@/lib/software/app-origin';

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
  const groups = listMetrics(user, { includeArchived });
  // LEAST-PRIVILEGE for app origins: narrow to (user access ∩ app grants). The OS UI
  // is untouched (appSlugFromRequest returns null with no I/O).
  const slug = appSlugFromRequest(req);
  if (slug) {
    const granted = await grantedIdSet(slug, 'metrics');
    const keep = <T extends { id: string }>(xs: T[]) => xs.filter((m) => granted.has(m.id));
    return NextResponse.json({ ...groups, mine: keep(groups.mine), domain: keep(groups.domain), marketplace: keep(groups.marketplace) });
  }
  return NextResponse.json(groups);
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
