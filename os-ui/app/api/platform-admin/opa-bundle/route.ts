/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Platform Admin: see a refused os-data bundle and acknowledge it.
 * USER STORY: As an admin I want a real large removal (many users or tables deleted at once) to
 *             reach OPA only after I have looked at exactly what is removed and said yes.
 * ARCHITECTURE:
 *   - Thin: the logic is `tabs/admin/lib/opa-bundle-admin.ts` (a test cannot import a route).
 *   - GET: the bundle status, the refused compile with WHAT it removes and adds, each removed
 *     user's state, the alert and the history. POST {hash, reason}: one-shot acceptance of exactly
 *     that content (core/policy/bundle.ts); a changed hash → 409. Both: admin only (requireAdmin)
 *     AND a fatal OPA decision (`authorize('user:<id>', 'admin')`). Every acknowledgement is audited
 *     with a confirmed write before it takes effect. Same-origin/CSRF: unchanged (middleware.ts).
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@core/kernel/auth';
import { authorize } from '@core/infra/governed';
import { acknowledgeOsDataBundle, osDataBundleStatus, recompileOsData } from '@core/policy/bundle';
import { audit, auditConfirmed, ensureHydrated as ensureAuditHydrated, listAudit } from '@tabs/admin/lib/audit';
import { currentTenantId } from '@tabs/admin/lib/tenant';
import { listAccess, recordedAccessStatus, tenantStatusAuthoritative } from '@tabs/admin/lib/tenant-users';
import { userDirectoryAuthoritative } from '@tabs/admin/lib/users';
import { AUDIT_PREFIX, handleBundleAcknowledge, handleBundleGet, type BundleAdminDeps } from '@tabs/admin/lib/opa-bundle-admin';

export const dynamic = 'force-dynamic';

const deps: BundleAdminDeps = {
  authorize,
  status: osDataBundleStatus,
  acknowledge: acknowledgeOsDataBundle,
  recompile: recompileOsData,
  directory: async () => {
    // Both the directory and the Access status store must be the durable truth, else annotate nothing.
    if (!(await tenantStatusAuthoritative()) || !(await userDirectoryAuthoritative())) return null;
    return (await listAccess()).map((u) => ({ id: u.id, domains: u.domains, disabled: u.disabled, active: u.active, status: recordedAccessStatus(u.id) }));
  },
  auditFeed: async () => {
    await ensureAuditHydrated();
    return listAudit({ prefix: AUDIT_PREFIX, limit: 50 });
  },
  audit,
  auditConfirmed,
};

function fail(e: unknown): Response {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
}

export async function GET(): Promise<Response> {
  try {
    const user = await requireAdmin();
    // The FATAL OPA decision, taken here and handed to the handler (which refuses on deny).
    const authz = await authorize(`user:${user.id}`, 'admin');
    const r = await handleBundleGet({ user, tenant: { id: currentTenantId() } }, { ...deps, authorize: async () => authz });
    return NextResponse.json(r.body, { status: r.status, headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await requireAdmin();
    // The FATAL OPA decision before any effect, handed to the handler (which refuses on deny).
    const authz = await authorize(`user:${user.id}`, 'admin');
    let body: unknown;
    try {
      body = await req.json();
    } catch (err) {
      return NextResponse.json({ error: 'not JSON', detail: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }
    const r = await handleBundleAcknowledge({ user, tenant: { id: currentTenantId() } }, body, { ...deps, authorize: async () => authz });
    return NextResponse.json(r.body, { status: r.status });
  } catch (e) {
    return fail(e);
  }
}
