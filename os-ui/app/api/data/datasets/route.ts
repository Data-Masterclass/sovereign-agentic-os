/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { listDatasets } from '@tabs/data/lib/store';
import { createDatasetService } from '@tabs/data/lib/mutations-server';
import { appSlugFromRequest, grantedIdSet } from '@tabs/software/lib/app-origin';

export const dynamic = 'force-dynamic';

/** The dataset registry: GET lists tiles (grouped mine/domain/marketplace);
 *  `?archived=1` includes soft-archived datasets (for the Archived view).
 *  POST creates a new private dataset (a Bronze→Silver→Gold spine). */
export const GET = withRoute(async ({ user, req }) => {
  const includeArchived = new URL(req.url).searchParams.get('archived') === '1';
  const groups = listDatasets(user, { includeArchived });
  // LEAST-PRIVILEGE for app origins: narrow the list to (user access ∩ app grants).
  // Non-app requests (the OS UI) are untouched — appSlugFromRequest returns null.
  const slug = appSlugFromRequest(req);
  if (slug) {
    const granted = await grantedIdSet(slug, 'data');
    const keep = <T extends { id: string }>(xs: T[]) => xs.filter((d) => granted.has(d.id));
    return NextResponse.json({ ...groups, mine: keep(groups.mine), domain: keep(groups.domain), marketplace: keep(groups.marketplace) });
  }
  return NextResponse.json(groups);
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

export const POST = withRoute<Record<string, string>, { name?: string; domain?: string; origin?: string }>(async ({ user, body }) => {
  // TWO-PATH create: 'curated' marks a dataset born from EXISTING governed datasets
  // (the Gold join path). Anything else — absent, 'ingest', garbage — is classic ingest.
  // `createDatasetService` is the SAME function MCP `create_dataset` calls (checklist X8),
  // so both doors validate alike and produce the same commit.
  const d = createDatasetService(user, { name: body.name, domain: body.domain, origin: body.origin });
  return NextResponse.json({ dataset: d }, { status: 201 });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
