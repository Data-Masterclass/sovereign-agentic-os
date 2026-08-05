/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { describeTable } from '@/lib/connections/warehouse/catalog-snapshot';

export const dynamic = 'force-dynamic';

/**
 * GET the columns of ONE catalog table — a governed `DESCRIBE` run AS the connection's
 * domain, lazily, when the Expose browser expands a row (lakehouse-expose-experience.md,
 * Phase A). Deliberately NOT part of the snapshot (~1k tables would be expensive to
 * DESCRIBE eagerly). Same auth/visibility gate as the sibling `snapshot` route:
 * `describeTable` re-resolves the connection FOR THE CALLER (404s if not visible) before
 * touching Trino, so this route only forwards the caller through it.
 *
 * Columns carry name, type and Trino's per-column Comment (empty when the metastore has
 * none). An unreachable/unregistered catalog throws — folded into a 4xx/5xx here — never a
 * fabricated column list. `schema`/`table` arrive as query params
 * (`?schema=public&table=orders`); the lib validates them as bare identifiers.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const url = new URL(req.url);
  const schema = (url.searchParams.get('schema') ?? '').trim();
  const table = (url.searchParams.get('table') ?? '').trim();
  if (!schema || !table) {
    return NextResponse.json({ error: 'schema and table are required' }, { status: 400 });
  }
  const columns = await describeTable(params.id, user, { schema, table });
  return NextResponse.json({ columns });
}, { defaultStatus: 500 });
