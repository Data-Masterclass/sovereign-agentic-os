/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    API — Platform → Tool consoles: list the consoles, switch one on or off
 * USER STORY: As a platform admin I read each tool console's switch, status, address and warning,
 *             and switch one at a time; a non-admin gets 403 and changes nothing.
 * ARCHITECTURE: thin — `adminCtx()` is the gate (401/403, tenant pin, settings hydrated); every
 *             decision and the audit row are in tabs/admin/lib/tool-consoles.ts.
 */
import { NextResponse } from 'next/server';
import { authorize } from '@core/infra/governed';
import { adminCtx, fail } from '../_ctx';
import { listToolConsoles, setToolConsole } from '@tabs/admin/lib/tool-consoles';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    return NextResponse.json({ consoles: await listToolConsoles() });
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    // Exposing a console is a governed write: the governance decision must allow it (unlike the
    // adminCtx() read, which only reports OPA). Unreachable OPA follows OPA_FAIL_OPEN.
    const authz = await authorize(`user:${user.id}`, 'admin');
    if (!authz.allowed) return NextResponse.json({ error: 'forbidden', policy: authz.policy }, { status: 403 });
    let body: { key?: unknown; exposed?: unknown } | null;
    try {
      body = (await req.json()) as typeof body;
    } catch (err) {
      return NextResponse.json({ error: 'not JSON', detail: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }
    const result = await setToolConsole({ key: body?.key, exposed: body?.exposed, actor: { id: user.id, role: user.role }, tenantId: tenant.id });
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
