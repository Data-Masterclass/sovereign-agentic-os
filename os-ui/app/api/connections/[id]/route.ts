/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getConnectionForUser, deleteConnection, setConnectionArchived } from '@/lib/connections';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const connection = await getConnectionForUser(id, user);
    return NextResponse.json({ connection });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST → connection lifecycle: `archive` (reversible soft-hide) or `unarchive`.
 * Edit-scoped (owner or domain admin) in the lib. The vault secret + OAuth token are
 * KEPT, so an archived connection reconnects with no re-auth.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    switch (body.action) {
      case 'archive':
        return NextResponse.json({ connection: await setConnectionArchived(id, user, true) });
      case 'unarchive':
        return NextResponse.json({ connection: await setConnectionArchived(id, user, false) });
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const physical = await deleteConnection(id, user);
    return NextResponse.json({ ok: true, physical });
  } catch (e) {
    return fail(e);
  }
}
