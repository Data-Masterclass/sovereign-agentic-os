/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { billingView, offlineSpend } from '@/lib/platform-admin/billing';
import { getTenant, updateTenant } from '@/lib/platform-admin/tenant';
import { audit } from '@/lib/platform-admin/audit';

export const dynamic = 'force-dynamic';

/** Usage vs the tenant envelope. Live spend is read from LiteLLM in a real
 * deploy; offline we use a deterministic mock so the envelope view renders.
 * Operational sub-caps stay in Governance; live spend detail is in Monitoring. */
export async function GET() {
  try {
    const { tenant } = await adminCtx();
    const { spendEUR, premiumSpendEUR, trend } = offlineSpend(tenant.envelopeEUR);
    const view = billingView({
      envelopeEUR: tenant.envelopeEUR,
      premiumCapEUR: tenant.premiumCapEUR,
      spendEUR,
      premiumSpendEUR,
      trend,
      source: 'offline-mock',
    });
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
