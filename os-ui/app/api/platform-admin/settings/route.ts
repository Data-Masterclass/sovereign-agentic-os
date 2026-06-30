/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { getSettings, updateSettings } from '@/lib/platform-admin/settings';
import { audit } from '@/lib/platform-admin/audit';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    return NextResponse.json({ settings: getSettings() });
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json();
    const settings = updateSettings(body ?? {}); // rejects raw-secret fields
    audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'settings.update', target: `tenant:${tenant.id}`, detail: `Updated tenant settings (${Object.keys(body ?? {}).join(', ')})` });
    return NextResponse.json({ settings });
  } catch (e) {
    return fail(e);
  }
}
