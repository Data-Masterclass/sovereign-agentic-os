/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { archiveUser, deleteUser, restoreUser, updateUser } from '@/lib/users';
import type { Role } from '@/lib/session';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const body = await req.json();
    if ('password' in (body as object)) {
      return NextResponse.json({ error: 'This endpoint does not handle passwords' }, { status: 400 });
    }
    // archive / restore shortcuts
    if (body?.archive) {
      const u = await archiveUser(id);
      return NextResponse.json({ user: u });
    }
    if (body?.restore) {
      const u = await restoreUser(id);
      return NextResponse.json({ user: u });
    }
    const user = await updateUser(id, {
      name: body?.name !== undefined ? String(body.name) : undefined,
      email: body?.email !== undefined ? String(body.email) : undefined,
      domains: Array.isArray(body?.domains) ? body.domains.map(String).filter(Boolean) : undefined,
      role: ['creator', 'builder', 'admin'].includes(body?.role) ? (body.role as Role) : undefined,
    });
    return NextResponse.json({ user });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;
    if (id === admin.id) {
      return NextResponse.json({ error: 'You cannot delete your own account' }, { status: 400 });
    }
    await deleteUser(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
