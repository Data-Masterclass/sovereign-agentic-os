/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { listTargets, listRestores, restore, restorePhrase } from '@/lib/platform-admin/backups';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    return NextResponse.json({
      targets: listTargets().map((t) => ({ ...t, restorePhrase: restorePhrase(t.id) })),
      restores: listRestores(),
    });
  } catch (e) {
    return fail(e);
  }
}

/** Admin-triggered GUARDED restore. `restore()` throws 412 unless `confirm`
 * echoes "restore <targetId>", and writes the audit entry itself. */
export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json();
    const { job, audit: entry } = restore({
      targetId: String(body?.targetId ?? ''),
      confirm: body?.confirm,
      tenant: tenant.id,
      actor: user.id,
      role: user.role,
    });
    return NextResponse.json({ job, auditId: entry.id }, { status: 202 });
  } catch (e) {
    return fail(e);
  }
}
