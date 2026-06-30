/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { authorize } from '@/lib/governed';
import { assertTenantAccess, currentTenantId, type Tenant } from '@/lib/platform-admin/tenant';
import type { CurrentUser } from '@/lib/auth';

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
  const decision = await authorize(`user:${user.id}`, 'admin'); // defense-in-depth, non-fatal
  const tenant = assertTenantAccess(currentTenantId());
  return { user, tenant, opa: decision.policy };
}

export function fail(e: unknown): NextResponse {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}
