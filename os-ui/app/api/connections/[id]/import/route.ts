/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { importWarehouseTable } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * IMPORT a federated warehouse table as a governed data product — a registry
 * Dataset row is created and the copy lands at its canonical personal-lane Bronze
 * (`iceberg.personal_<uid>.bronze_<slug>`) through the governed write path as the
 * caller (re-gated in the lib). The response carries `datasetId` so the UI opens
 * the new dataset; it then refines Bronze → Silver → Gold like any other.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
      schema?: string;
      table?: string;
      name?: string;
      targetDomain?: string;
    };
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
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
