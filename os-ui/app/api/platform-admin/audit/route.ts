/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { ensureHydrated, listAudit } from '@/lib/platform-admin/audit';

export const dynamic = 'force-dynamic';

/** Platform-Admin slice of the shared audit record (same store Governance reads). */
export async function GET(req: Request) {
  try {
    await ensureHydrated();
    await adminCtx();
    const prefix = new URL(req.url).searchParams.get('prefix') ?? undefined;
    return NextResponse.json({ entries: listAudit({ limit: 100, prefix }) });
  } catch (e) {
    return fail(e);
  }
}
