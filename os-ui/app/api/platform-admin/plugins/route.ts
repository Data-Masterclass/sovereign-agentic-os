/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { listPlugins, installPlugin, approvePlugin, getRegistration, registerMarketplace } from '@/lib/platform-admin/plugins';
import { listDomains } from '@/lib/platform-admin/domains';
import { audit } from '@/lib/platform-admin/audit';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    return NextResponse.json({
      plugins: listPlugins(),
      registration: getRegistration(),
      domains: listDomains().filter((d) => !d.archived).map((d) => d.id),
    });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json();
    const op = String(body?.op ?? '');
    let detail = '';
    let payload: unknown;
    switch (op) {
      case 'install':
        payload = installPlugin(String(body?.id ?? ''));
        detail = `Installed plugin ${body?.id}`;
        break;
      case 'approve':
        payload = approvePlugin(String(body?.id ?? ''), Array.isArray(body?.domains) ? body.domains.map(String) : []);
        detail = `Approved plugin ${body?.id} for ${(body?.domains ?? []).join(', ')}`;
        break;
      case 'register':
        payload = registerMarketplace({ listingName: body?.listingName ? String(body.listingName) : undefined, partnerId: String(body?.partnerId ?? '') });
        detail = `Registered external STACKIT marketplace listing (${body?.partnerId})`;
        break;
      default:
        return NextResponse.json({ error: 'Unknown op' }, { status: 400 });
    }
    audit({ tenant: tenant.id, actor: user.id, role: user.role, action: `plugin.${op}`, target: `plugin:${body?.id ?? 'marketplace'}`, detail });
    return NextResponse.json({ ok: true, payload });
  } catch (e) {
    return fail(e);
  }
}
