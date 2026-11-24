/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { getSettings, updateSettings, restoreSettings, maskingSwitchKnown } from '@tabs/admin/lib/settings';
import { audit } from '@tabs/admin/lib/audit';
import { langfuseMaskingStatus } from '@core/models/roles';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    // `langfuseMasking` is what the admin saved; `maskingStatus` says whether this process has READ it
    // (when it has not, the strictest level applies, see core/models/roles.ts).
    return NextResponse.json({ settings: getSettings(), maskingStatus: langfuseMaskingStatus() });
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json();
    // The write and its audit rows succeed together or fail together: when an audit row cannot be
    // written the settings write is undone, so a setting never changes without its trail.
    const previous = structuredClone(getSettings());
    const wasKnown = maskingSwitchKnown();
    const settings = updateSettings(body ?? {}); // rejects raw-secret fields (nothing is audited then)
    try {
      audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'settings.update', target: `tenant:${tenant.id}`, detail: `Updated tenant settings (${Object.keys(body ?? {}).join(', ')})` });
      // The masking switch decides what leaves for Langfuse, so its new value is in the audit trail itself.
      if (body && typeof body === 'object' && 'langfuseMasking' in body) {
        const m = settings.langfuseMasking;
        audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'settings.langfuse-masking', target: `tenant:${tenant.id}`, detail: `Langfuse masking ${m.enabled ? `ON (${m.level})` : 'OFF'}` });
      }
      // Who may certify personal data to every domain is a governance decision: old → new in the trail.
      if (body && typeof body === 'object' && 'personalDataBeforeCompany' in body) {
        audit({
          tenant: tenant.id,
          actor: user.id,
          role: user.role,
          action: 'settings.personal-data-rule',
          target: `tenant:${tenant.id}`,
          detail: `Personal data before Company certification: ${previous.personalDataBeforeCompany} → ${settings.personalDataBeforeCompany}`,
          data: { from: previous.personalDataBeforeCompany, to: settings.personalDataBeforeCompany },
        });
      }
    } catch (e) {
      restoreSettings(previous, wasKnown);
      throw new Error(`Settings were not changed: the audit trail could not be written (${e instanceof Error ? e.message : String(e)})`);
    }
    return NextResponse.json({ settings });
  } catch (e) {
    return fail(e);
  }
}
