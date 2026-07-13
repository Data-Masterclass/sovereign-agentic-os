/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { recompile } from '../_compile';
import { listAccess, inviteUser } from '@/lib/platform-admin/tenant-users';
import { listDomains } from '@/lib/platform-admin/domains';
import { getSettings } from '@/lib/platform-admin/settings';
import { audit } from '@/lib/platform-admin/audit';
import { ROLES, type Role } from '@/lib/core/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    const [users] = await Promise.all([listAccess()]);
    const sso = getSettings().sso;
    const domains = listDomains().filter((d) => !d.archived).map((d) => d.id);
    return NextResponse.json({ users, domains, sso });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Invite a user with a REAL, hashed password so they can sign in immediately
 * (OS-native password auth). The admin may supply a password (validated for
 * strength server-side — empty/weak → 400) or leave it blank to have the server
 * generate one. The plaintext is returned ONCE (`tempPassword`) for the admin to
 * relay; only the scrypt hash is stored. `generated` is true when the admin left
 * it blank, so the UI knows to surface the generated password.
 */
export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json();
    const role = (ROLES.includes(body?.role) ? body.role : 'creator') as Role;
    const domains = Array.isArray(body?.domains) ? body.domains.map(String).filter(Boolean) : [];
    const { user: invited, tempPassword, generated } = await inviteUser({
      id: String(body?.id ?? ''),
      name: body?.name ? String(body.name) : undefined,
      email: body?.email ? String(body.email) : undefined,
      domains,
      role,
      password: body?.password ? String(body.password) : undefined,
    });
    audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'user.invite', target: `user:${invited.id}`, detail: `Invited ${invited.id} as ${role} into ${domains.join(', ')} (${generated ? 'server-generated' : 'admin-set'} password; hash only stored)` });
    const { publish } = await recompile();
    // tempPassword leaves the server ONCE here — the invitee replaces it on first login.
    return NextResponse.json({ user: invited, tempPassword, generated, publish }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
