/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { reconcileDomainTablesLive } from '@/lib/experimental/data/reconcile-server';
import type { Principal } from '@/lib/experimental/data/store';

export const dynamic = 'force-dynamic';

/**
 * Admin-triggered SELF-HEAL sweep for the "domain gold table not materialized" drift
 * (#96 / #151 — the Northpeak class). Enumerates the promoted domain tables the caller
 * governs (optionally scoped to `{ domain }`), probes each physical Iceberg table, and
 * re-materializes any that are MISSING or STALE via the SAME stored-plan re-materialize
 * the Data tab runs. Best-effort per dataset (one failure never aborts the sweep); the
 * honest per-dataset report is returned. Admin-gated by `adminCtx` (the platform-admin
 * surface); the sweep's own governance floor (Builder+ in the domain, or Admin tenant-wide)
 * is re-enforced inside `reconcileDomainTables`.
 */
export async function POST(req: Request) {
  try {
    const { user } = await adminCtx();
    const body = (await req.json().catch(() => ({}))) as { domain?: string };
    const operator: Principal = { id: user.id, domains: user.domains, role: user.role };
    const domain = typeof body?.domain === 'string' && body.domain.trim() ? body.domain.trim() : undefined;
    const report = await reconcileDomainTablesLive(operator, domain ? { domain } : {});
    return NextResponse.json({ report });
  } catch (e) {
    return fail(e);
  }
}
