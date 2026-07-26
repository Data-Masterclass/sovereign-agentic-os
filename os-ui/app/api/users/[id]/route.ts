/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { requireAdmin } from '@/lib/core/auth';
import { archiveUser, deleteUser, restoreUser, updateUser } from '@/lib/platform-admin/users';
import { ROLES, type Role } from '@/lib/core/session';

export const dynamic = 'force-dynamic';

export const PATCH = withRoute<{ id: string }>(async ({ params, req }) => {
    const { id } = params;
    // Bare body read on purpose: an unparseable body throws the SyntaxError to
    // the wrapper's catch → 500 with the parse-error message, exactly as before.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json();
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
      role: ROLES.includes(body?.role) ? (body.role as Role) : undefined,
    });
    return NextResponse.json({ user });
}, { gate: requireAdmin, defaultStatus: 500 });

export const DELETE = withRoute<{ id: string }>(async ({ user: admin, params }) => {
  const { id } = params;
  if (id === admin.id) {
    return NextResponse.json({ error: 'You cannot delete your own account' }, { status: 400 });
  }
  await deleteUser(id);
  return NextResponse.json({ ok: true });
}, { gate: requireAdmin, defaultStatus: 500 });
