/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { importWarehouseTable } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * IMPORT a federated warehouse table as a governed data product — CTAS into
 * `iceberg.<domain>.<name>`, run through the governed query path as the caller.
 * Builder/Admin with edit rights on the connection (re-gated in the lib). The federated
 * table becomes a normal governed dataset in the Data tab.
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
