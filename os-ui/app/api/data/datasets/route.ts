/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
import { listDatasets, createDataset } from '@/lib/data/store';

export const dynamic = 'force-dynamic';

/** The dataset registry: GET lists tiles (grouped mine/domain/marketplace);
 *  `?archived=1` includes soft-archived datasets (for the Archived view).
 *  POST creates a new private dataset (a Bronze→Silver→Gold spine). */
export const GET = withRoute(async ({ user, req }) => {
  const includeArchived = new URL(req.url).searchParams.get('archived') === '1';
  return NextResponse.json(listDatasets(user, { includeArchived }));
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

export const POST = withRoute<Record<string, string>, { name?: string; domain?: string; origin?: string }>(async ({ user, body }) => {
  if (!body.name || !body.name.trim()) {
    return NextResponse.json({ error: 'a dataset needs a name' }, { status: 400 });
  }
  // TWO-PATH create: 'curated' marks a dataset born from EXISTING governed datasets
  // (the Gold join path). Anything else — absent, 'ingest', garbage — is classic ingest.
  const d = createDataset(user, { name: body.name, domain: body.domain, origin: body.origin === 'curated' ? 'curated' : undefined });
  return NextResponse.json({ dataset: d }, { status: 201 });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
