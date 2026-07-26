/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { importWarehouseTable } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * IMPORT a federated warehouse table as a governed data product — a registry
 * Dataset row is created and the copy lands at its canonical personal-lane Bronze
 * (`iceberg.personal_<uid>.bronze_<slug>`) through the governed write path as the
 * caller (re-gated in the lib). The response carries `datasetId` so the UI opens
 * the new dataset; it then refines Bronze → Silver → Gold like any other.
 */
export const POST = withRoute<{ id: string }, {
      schema?: string;
      table?: string;
      name?: string;
      targetDomain?: string;
    }>(async ({ user, params, body }) => {
    const { id } = params;
    const schema = (body.schema ?? '').trim();
    const table = (body.table ?? '').trim();
    if (!schema || !table) {
      return NextResponse.json({ error: 'schema and table are required' }, { status: 400 });
    }
    const result = await importWarehouseTable(id, user, {
      schema,
      table,
      name: body.name,
      targetDomain: body.targetDomain,
    });
    return NextResponse.json(result);
}, { parse: true, defaultStatus: 500 });
