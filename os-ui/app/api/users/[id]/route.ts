/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { deleteUser, updateUser } from '@/lib/users';
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
    const user = await updateUser(id, {
      name: body?.name !== undefined ? String(body.name) : undefined,
      password: body?.password ? String(body.password) : undefined,
      domains: Array.isArray(body?.domains) ? body.domains.map(String).filter(Boolean) : undefined,
      role: ['participant', 'builder', 'admin'].includes(body?.role) ? (body.role as Role) : undefined,
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
