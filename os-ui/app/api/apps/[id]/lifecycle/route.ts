/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { archiveApp, unarchiveApp, deleteApp, useAsData, consumeResource } from '@/lib/software/lifecycle';
import type { ConsumedResource } from '@/lib/software/model';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * App lifecycle + resource consumption (Software golden path §F): archive
 * (disable + retain), unarchive, lineage-aware delete, "Use as Data", and
 * consume a granted Connection/Data/Knowledge/app-MCP (no raw creds).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      resource?: ConsumedResource;
    };
    switch (body.action) {
      case 'archive':
        return NextResponse.json({ app: await archiveApp(id, user) });
      case 'unarchive':
        return NextResponse.json({ app: await unarchiveApp(id, user) });
      case 'delete':
        return NextResponse.json(await deleteApp(id, user));
      case 'use-as-data':
        return NextResponse.json({ app: await useAsData(id, user) });
      case 'consume': {
        const r = body.resource;
        if (!r || !r.kind || !r.ref) {
          return NextResponse.json({ error: 'A resource { kind, ref, label, scope } is required' }, { status: 400 });
        }
        return NextResponse.json({ app: await consumeResource(id, user, r) });
      }
      default:
        return NextResponse.json({ error: 'Unknown lifecycle action' }, { status: 400 });
    }
  } catch (e) {
    return fail(e);
  }
}
