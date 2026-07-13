/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { recompile } from '../../_compile';
import { deactivateUser, reactivateUser, setTenantAdmin, setMemberships, offboardUser, editUser, resetPassword, listAccess } from '@/lib/platform-admin/tenant-users';
import { audit } from '@/lib/platform-admin/audit';
import { ROLES, type Role } from '@/lib/core/session';

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
    // Never deactivate the last active admin — that would lock the tenant out.
    if (op === 'deactivate') {
      const access = await listAccess();
      const target = access.find((u) => u.id === id);
      if (target?.role === 'admin') {
        const activeAdmins = access.filter((u) => u.role === 'admin' && u.active);
        if (activeAdmins.length <= 1) {
          return NextResponse.json({ error: 'Cannot deactivate the last active admin' }, { status: 400 });
        }
      }
    }
    let detail = '';
    let result: unknown;
    switch (op) {
      case 'deactivate':
        result = await deactivateUser(id);
        detail = `Deactivated ${id} (offboarding)`;
        break;
      case 'reset-password': {
        const out = await resetPassword(id, body?.password ? String(body.password) : undefined);
        // tempPassword leaves the server ONCE here for the admin to relay.
        result = { user: out.user, tempPassword: out.tempPassword };
        detail = `Reset password for ${id} (hash only stored)`;
        break;
      }
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
      case 'edit': {
        const patch: { name?: string; email?: string; role?: Role; domains?: string[] } = {};
        if (body?.name !== undefined) patch.name = String(body.name);
        if (body?.email !== undefined) patch.email = String(body.email);
        if (ROLES.includes(body?.role)) patch.role = body.role as Role;
        if (Array.isArray(body?.domains)) patch.domains = body.domains.map(String).filter(Boolean);
        result = await editUser(id, patch);
        const parts: string[] = [];
        if (patch.name !== undefined) parts.push(`name="${patch.name}"`);
        if (patch.email !== undefined) parts.push(`email="${patch.email}"`);
        if (patch.role !== undefined) parts.push(`role=${patch.role}`);
        if (patch.domains !== undefined) parts.push(`domains=[${patch.domains.join(', ')}]`);
        detail = `Edited ${id}: ${parts.join(', ')}`;
        break;
      }
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

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, tenant } = await adminCtx();
    const { id } = await ctx.params;
    if (id === user.id) return NextResponse.json({ error: 'You cannot offboard your own account' }, { status: 400 });
    // Optional `reassignTo`: transfer the offboarded user's personal artifacts to
    // another owner before deletion (else they are deleted with the account).
    const body = await req.json().catch(() => ({} as { reassignTo?: unknown }));
    const reassignTo = body && typeof body.reassignTo === 'string' ? body.reassignTo.trim() : '';
    const report = await offboardUser(id, reassignTo || undefined);
    audit({
      tenant: tenant.id, actor: user.id, role: user.role, action: 'user.offboard', target: `user:${id}`,
      detail: reassignTo
        ? `Offboarded ${id}; reassigned ${report?.total ?? 0} personal artifacts to ${reassignTo}${report && Object.keys(report.failed).length ? ` (failed: ${Object.keys(report.failed).join(', ')})` : ''}`
        : `Offboarded ${id} (personal artifacts deleted with account)`,
    });
    const { publish } = await recompile();
    return NextResponse.json({ ok: true, report, publish });
  } catch (e) {
    return fail(e);
  }
}
