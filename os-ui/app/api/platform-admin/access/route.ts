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
import type { Role } from '@/lib/session';

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

/** Invite a user via Ory — the password is generated server-side and NEVER
 * returned; only the PublicUser comes back. */
export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json();
    const role = (['creator', 'builder', 'admin'].includes(body?.role) ? body.role : 'creator') as Role;
    const domains = Array.isArray(body?.domains) ? body.domains.map(String).filter(Boolean) : [];
    const invited = await inviteUser({ id: String(body?.id ?? ''), name: body?.name ? String(body.name) : undefined, email: body?.email ? String(body.email) : undefined, domains, role });
    audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'user.invite', target: `user:${invited.id}`, detail: `Invited ${invited.id} as ${role} into ${domains.join(', ')} (via Ory; no password seen)` });
    const { publish } = await recompile();
    return NextResponse.json({ user: invited, publish }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
