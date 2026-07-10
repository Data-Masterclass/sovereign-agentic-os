/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { recompile } from '../_compile';
import { listDomains } from '@/lib/platform-admin/domains';
import { listAccess } from '@/lib/platform-admin/tenant-users';
import { billingView, offlineSpend } from '@/lib/platform-admin/billing';
import { listRequests } from '@/lib/platform-admin/security';
import { listTargets } from '@/lib/platform-admin/backups';
import { listAudit } from '@/lib/platform-admin/audit';
import { REGISTRY, listComponentsWithStatus } from '@/lib/platform-admin/platform';

export const dynamic = 'force-dynamic';

/** The admin cockpit aggregate — "is the platform healthy & within budget?" */
export async function GET() {
  try {
    const { tenant, opa } = await adminCtx();

    // Component health — best-effort; degrade to registry counts offline.
    let health = { total: REGISTRY.length, running: 0, source: 'offline' as 'live' | 'offline' };
    try {
      const comps = await listComponentsWithStatus();
      health = { total: comps.length, running: comps.filter((c) => c.status === 'running').length, source: 'live' };
    } catch { /* offline */ }

    const domains = listDomains();
    const users = await listAccess();
    const { spendEUR, premiumSpendEUR, trend } = offlineSpend(tenant.envelopeEUR);
    const billing = billingView({ envelopeEUR: tenant.envelopeEUR, premiumCapEUR: tenant.premiumCapEUR, spendEUR, premiumSpendEUR, trend, source: 'offline-mock' });
    const { compiled, publish } = await recompile();
    const openEgress = listRequests().filter((r) => r.status === 'pending').length;
    const failedBackups = listTargets().filter((t) => t.lastStatus === 'failed').length;

    const alerts: { level: 'warn' | 'info'; text: string; href: string }[] = [];
    if (billing.pctUsed >= 80) alerts.push({ level: 'warn', text: `Spend at ${billing.pctUsed}% of envelope`, href: '/platform/billing' });
    if (openEgress > 0) alerts.push({ level: 'info', text: `${openEgress} egress request(s) awaiting approval`, href: '/platform/security' });
    if (failedBackups > 0) alerts.push({ level: 'warn', text: `${failedBackups} backup target(s) failed last run`, href: '/platform/backups' });
    if (publish.status === 'opa-unreachable') alerts.push({ level: 'info', text: 'OPA offline — policy compiled locally', href: '/governance' });

    return NextResponse.json({
      tenant: { id: tenant.id, name: tenant.name, residency: tenant.residency, plan: tenant.plan },
      opa,
      health,
      counts: {
        domains: domains.length,
        domainsActive: domains.filter((d) => !d.archived).length,
        users: users.length,
        usersActive: users.filter((u) => u.active).length,
        admins: users.filter((u) => u.role === 'admin').length,
      },
      billing,
      policy: { principals: compiled.bundle.principals, tools: compiled.bundle.tools, bundle: compiled.bundle.version, publish },
      alerts,
      recentAudit: listAudit({ limit: 6 }),
    });
  } catch (e) {
    return fail(e);
  }
}
