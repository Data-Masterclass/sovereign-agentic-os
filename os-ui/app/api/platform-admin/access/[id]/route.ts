/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { recompile } from '../../_compile';
import { deactivateUser, reactivateUser, setTenantAdmin, setMemberships, offboardUser } from '@/lib/platform-admin/tenant-users';
import { audit } from '@/lib/platform-admin/audit';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, tenant } = await adminCtx();
    const { id } = await ctx.params;
    const body = await req.json();
    const op = String(body?.op ?? '');
    if (id === user.id && op === 'deactivate') {
      return NextResponse.json({ error: 'You cannot deactivate your own account' }, { status: 400 });
    }
    let detail = '';
    let result: unknown;
    switch (op) {
      case 'deactivate':
        result = await deactivateUser(id);
        detail = `Deactivated ${id} (offboarding)`;
        break;
      case 'reactivate':
        result = await reactivateUser(id);
        detail = `Reactivated ${id}`;
        break;
      case 'tenant-admin':
        result = await setTenantAdmin(id, Boolean(body?.isAdmin));
        detail = `${body?.isAdmin ? 'Granted' : 'Revoked'} tenant Admin for ${id}`;
        break;
      case 'memberships':
        result = await setMemberships(id, Array.isArray(body?.domains) ? body.domains.map(String) : []);
        detail = `Set initial memberships for ${id}: ${(body?.domains ?? []).join(', ')}`;
        break;
      default:
        return NextResponse.json({ error: 'Unknown op' }, { status: 400 });
    }
    audit({ tenant: tenant.id, actor: user.id, role: user.role, action: `user.${op}`, target: `user:${id}`, detail });
    const { publish } = await recompile();
    return NextResponse.json({ result, publish });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, tenant } = await adminCtx();
    const { id } = await ctx.params;
    if (id === user.id) return NextResponse.json({ error: 'You cannot offboard your own account' }, { status: 400 });
    await offboardUser(id);
    audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'user.offboard', target: `user:${id}`, detail: `Offboarded ${id}` });
    const { publish } = await recompile();
    return NextResponse.json({ ok: true, publish });
  } catch (e) {
    return fail(e);
  }
}
