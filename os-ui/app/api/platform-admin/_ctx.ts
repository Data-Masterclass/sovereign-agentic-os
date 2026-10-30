/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { requireAdmin } from '@core/kernel/auth';
import { authorize } from '@core/infra/governed';
import { assertTenantAccess, currentTenantId, type Tenant } from '@tabs/admin/lib/tenant';
import { ensureHydrated as ensureDomainsHydrated } from '@tabs/admin/lib/domains';
import { ensureHydrated as ensureModelsHydrated } from '@tabs/admin/lib/models';
import { ensureHydrated as ensureTenantUsersHydrated } from '@tabs/admin/lib/tenant-users';
import { ensureHydrated as ensureTenantHydrated } from '@tabs/admin/lib/tenant';
import { ensureHydrated as ensureSettingsHydrated } from '@tabs/admin/lib/settings';
import { ensureHydrated as ensureSecurityHydrated } from '@tabs/governance/lib/egress';
import { ensureHydrated as ensurePluginsHydrated } from '@tabs/admin/lib/plugins';
import { knownDomains } from '@tabs/admin/lib/users';
import type { CurrentUser } from '@core/kernel/auth';

/**
 * The single gate every Platform-Admin API route passes through. Three guards,
 * in order:
 *   1. Admin-only — `requireAdmin()` (401 if anon, 403 if not admin) is the
 *      AUTHORITATIVE gate: a Builder/User can never reach these routes.
 *   2. OPA scope — defense-in-depth `authorize('user:<id>','admin')` against the
 *      SAME default-deny decision API the rest of the platform uses, SURFACED as
 *      `opa` (the cockpit shows it). It is intentionally NON-FATAL: the admin
 *      grant is published to OPA *by* these routes (via the policy compiler), so
 *      blocking on `opa-deny` here would be a bootstrap deadlock — a live OPA
 *      that hasn't yet been seeded with the compiled grant would lock every
 *      admin out of the very routes that seed it. Role stays the hard gate; OPA
 *      is reported, matching `lib/governed.ts`'s fail-open-and-mark convention.
 *   3. Tenant isolation — `assertTenantAccess` pins the request to THIS tenant.
 */
export type AdminCtx = { user: CurrentUser; tenant: Tenant; opa: 'opa-allow' | 'opa-deny' | 'opa-unreachable' };

export async function adminCtx(): Promise<AdminCtx> {
  const user = await requireAdmin(); // authoritative: 401/403
  // Reflect the tenant's REAL domains: hydrate the registry (durable mirror +
  // derive-from-users) once before any admin read, so Admin → Domains is never 0.
  await ensureDomainsHydrated(knownDomains);
  await ensureModelsHydrated();
  await ensureTenantUsersHydrated();
  // Durable admin stores: hydrate the last-saved values before any admin read so a
  // redeployed pod restores them instead of reverting to defaults (settings flags,
  // egress allowlist, tenant budget/plan, plugin enablement + marketplace listing).
  await ensureTenantHydrated();
  await ensureSettingsHydrated();
  await ensureSecurityHydrated();
  await ensurePluginsHydrated();
  const decision = await authorize(`user:${user.id}`, 'admin'); // defense-in-depth, non-fatal
  const tenant = assertTenantAccess(currentTenantId());
  return { user, tenant, opa: decision.policy };
}

export function fail(e: unknown): NextResponse {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}
