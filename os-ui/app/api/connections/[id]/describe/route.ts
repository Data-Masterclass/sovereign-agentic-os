/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { describeEntity } from '@/lib/connections/warehouse/catalog-snapshot';

export const dynamic = 'force-dynamic';

/**
 * GET the columns/fields of ONE catalog entity — dispatched per connection template
 * (operational-system-connections.md, Phase 1). A WAREHOUSE connection describes through
 * the governed Trino `DESCRIBE` AS its domain; an OPERATIONAL connection (Salesforce)
 * describes its object's fields through the connector API, returning {name, type, label}
 * (the business label rides the `comment` slot the CatalogBrowser already renders). Lazy —
 * only on row expand (~1k entities would be expensive to describe eagerly). Same
 * auth/visibility gate as the sibling `snapshot` route: `describeEntity` re-resolves the
 * connection FOR THE CALLER (404s if not visible) before touching any backend.
 *
 * An unreachable/unregistered source throws — folded into a 4xx/5xx here — never a
 * fabricated field list. `schema`/`table` arrive as query params
 * (`?schema=salesforce&table=Account`); the lib validates them.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const url = new URL(req.url);
  const schema = (url.searchParams.get('schema') ?? '').trim();
  const table = (url.searchParams.get('table') ?? '').trim();
  if (!schema || !table) {
    return NextResponse.json({ error: 'schema and table are required' }, { status: 400 });
  }
  const columns = await describeEntity(params.id, user, { schema, table });
  return NextResponse.json({ columns });
}, { defaultStatus: 500 });
