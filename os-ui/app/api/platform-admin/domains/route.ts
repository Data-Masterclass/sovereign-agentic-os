/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { recompile } from '../_compile';
import { listDomains, createDomain, TEMPLATES } from '@/lib/platform-admin/domains';
import { audit } from '@/lib/platform-admin/audit';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    return NextResponse.json({ domains: listDomains(), templates: TEMPLATES });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json();
    const domain = createDomain({
      name: String(body?.name ?? ''),
      owner: String(body?.owner ?? user.id),
      template: body?.template ? String(body.template) : undefined,
    });
    audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'domain.create', target: `domain:${domain.id}`, detail: `Created domain "${domain.name}" (template ${domain.template})` });
    const { publish } = await recompile();
    return NextResponse.json({ domain, publish }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
