/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { recompile } from '../_compile';
import { listDomains } from '@tabs/admin/lib/domains';
import { listAccess } from '@tabs/admin/lib/tenant-users';
import { tenantSpendView } from '@tabs/monitoring/lib/spend';
import { listRequests } from '@tabs/governance/lib/egress';
import { listBackups } from '@tabs/admin/lib/backups';
import { listAudit } from '@tabs/admin/lib/audit';
import { REGISTRY, listComponentsWithStatus } from '@tabs/admin/lib/platform';

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
    // Review H1 (2026-11-18): this used to be an unconditional `offlineSpend(...)` +
    // `source: 'offline-mock'`, and the alert below was raised off the invented number — a real
    // warning about a figure nobody had measured. One door decides now.
    const billing = tenantSpendView(tenant.envelopeEUR, tenant.premiumCapEUR);
    const { compiled, publish } = await recompile();
    const openEgress = listRequests().filter((r) => r.status === 'pending').length;
    const failedBackups = (await listBackups()).filter((t) => t.health === 'red').length;

    const alerts: { level: 'warn' | 'info'; text: string; href: string }[] = [];
    // NO ALERT off a figure that was not read. `pctUsed` is null when spend is unavailable, and
    // `null >= 80` is false in JS — but relying on that coercion is exactly how this kind of bug
    // survives a refactor, so the check is explicit.
    if (billing.pctUsed !== null && billing.pctUsed >= 80) {
      alerts.push({ level: 'warn', text: `Spend at ${billing.pctUsed}% of envelope`, href: '/monitoring#spend' });
    }
    if (openEgress > 0) alerts.push({ level: 'info', text: `${openEgress} egress request(s) awaiting approval`, href: '/governance?section=egress' });
    if (failedBackups > 0) alerts.push({ level: 'warn', text: `${failedBackups} backup(s) or restore drill(s) failed`, href: '/platform?section=backups' });
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
