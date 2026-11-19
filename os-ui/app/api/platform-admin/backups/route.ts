/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { listTargets, restore, BACKUP_STATUS_NOTE } from '@tabs/admin/lib/backups';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    return NextResponse.json({ targets: listTargets(), note: BACKUP_STATUS_NOTE });
  } catch (e) {
    return fail(e);
  }
}

/** Restore is not available from the UI: `restore()` refuses with 501 and records nothing. */
export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json().catch(() => ({}));
    restore({ targetId: String(body?.targetId ?? ''), confirm: body?.confirm, tenant: tenant.id, actor: user.id, role: user.role });
    return NextResponse.json({ error: 'unreachable' }, { status: 500 });
  } catch (e) {
    return fail(e);
  }
}
