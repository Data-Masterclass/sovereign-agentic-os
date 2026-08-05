/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { countEntity } from '@/lib/connections/warehouse/catalog-snapshot';

export const dynamic = 'force-dynamic';

/**
 * GET a REAL, cheap row count for ONE operational entity — on demand, only on row expand
 * (operational-system-connections.md, Phase 1: "record counts ONLY where cheaply real").
 * For Salesforce this is a single `SELECT COUNT() FROM <Object>` (bounded, no pages). The
 * count is NEVER estimated: an absent/unreachable count throws (folded to 4xx/5xx), so the
 * UI shows nothing rather than a fabricated number. Same auth/visibility gate as the
 * sibling `describe` route (`countEntity` re-resolves FOR THE CALLER, 404s if not visible).
 *
 * `?schema=salesforce&table=Account`. A warehouse (or count-less operational) template
 * returns `{ count: null }` honestly — counts are surfaced only where cheaply real.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const url = new URL(req.url);
  const schema = (url.searchParams.get('schema') ?? '').trim();
  const table = (url.searchParams.get('table') ?? '').trim();
  if (!schema || !table) {
    return NextResponse.json({ error: 'schema and table are required' }, { status: 400 });
  }
  void schema; // validated above; the count identifies an entity by its (pseudo-schema) name
  const count = await countEntity(params.id, user, { table });
  return NextResponse.json({ count });
}, { defaultStatus: 500 });
