/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { apiError, withRoute } from '@core/kernel/route-server';
import { requireAdmin } from '@core/kernel/auth';
import { deleteUser, updateUser } from '@tabs/admin/lib/users';
import { deactivateUser, reactivateUser } from '@tabs/admin/lib/tenant-users';
import { recompile } from '@/app/api/platform-admin/_compile';
import { ROLES, type Role } from '@core/kernel/session';

export const dynamic = 'force-dynamic';

export const PATCH = withRoute<{ id: string }>(async ({ params, req }) => {
    const { id } = params;
    // Bare body read on purpose: an unparseable body throws the SyntaxError to
    // the wrapper's catch → 500 with the parse-error message, exactly as before.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json();
    if ('password' in (body as object)) {
      return apiError(400, 'This endpoint does not handle passwords', 'users.noPasswordsHere');
    }
    // archive / restore shortcuts: the SAME deactivate / reactivate as Platform Admin → Users &
    // Access, so the directory flag and the Access status never disagree (one definition of active).
    if (body?.archive) {
      try {
        const u = await deactivateUser(id);
        await recompile();
        return NextResponse.json({ user: u });
      } catch (e) {
        if ((e as { deactivationStands?: boolean })?.deactivationStands) await recompile();
        throw e;
      }
    }
    if (body?.restore) {
      const u = await reactivateUser(id);
      await recompile();
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
    return apiError(400, 'You cannot delete your own account', 'users.cannotDeleteSelf');
  }
  await deleteUser(id);
  return NextResponse.json({ ok: true });
}, { gate: requireAdmin, defaultStatus: 500 });
