/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { tenantSpendView } from '@tabs/monitoring/lib/spend';
import { getTenant, updateTenant } from '@tabs/admin/lib/tenant';
import { audit } from '@tabs/admin/lib/audit';

export const dynamic = 'force-dynamic';

/** Usage vs the tenant envelope. `tenantSpendView` is the ONE door that decides whether a
 * demo figure may stand in for a reading (review H1, 2026-11-18): this route used to call
 * `offlineSpend(tenant.envelopeEUR)` unconditionally and stamp `source: 'offline-mock'`, so the
 * deployed cluster showed 62% of its own envelope as spend. Refused ⇒ `source: 'unavailable'`
 * with null figures. Operational sub-caps stay in Governance; spend detail is in Monitoring. */
export async function GET() {
  try {
    const { tenant } = await adminCtx();
    const view = tenantSpendView(tenant.envelopeEUR, tenant.premiumCapEUR);
    return NextResponse.json({ billing: view, plan: tenant.plan });
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json();
    const patch: { envelopeEUR?: number; premiumCapEUR?: number; plan?: typeof tenant.plan } = {};
    if (body?.envelopeEUR !== undefined) patch.envelopeEUR = Math.max(0, Number(body.envelopeEUR));
    if (body?.premiumCapEUR !== undefined) patch.premiumCapEUR = Math.max(0, Number(body.premiumCapEUR));
    if (typeof body?.plan === 'string') patch.plan = body.plan;
    const next = updateTenant(patch);
    audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'billing.envelope', target: `tenant:${tenant.id}`, detail: `Set envelope €${next.envelopeEUR}/mo, premium cap €${next.premiumCapEUR}/mo, plan ${next.plan}` });
    return NextResponse.json({ tenant: getTenant() });
  } catch (e) {
    return fail(e);
  }
}
