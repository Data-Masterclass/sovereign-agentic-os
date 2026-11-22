/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { getSettings, updateSettings } from '@tabs/admin/lib/settings';
import { audit } from '@tabs/admin/lib/audit';

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
    // The masking switch decides what leaves for Langfuse, so its new value is in the audit trail itself.
    if (body && typeof body === 'object' && 'langfuseMasking' in body) {
      const m = settings.langfuseMasking;
      audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'settings.langfuse-masking', target: `tenant:${tenant.id}`, detail: `Langfuse masking ${m.enabled ? `ON (${m.level})` : 'OFF'}` });
    }
    return NextResponse.json({ settings });
  } catch (e) {
    return fail(e);
  }
}
