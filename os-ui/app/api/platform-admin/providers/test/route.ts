/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * POST /api/platform-admin/providers/test — step 4: LiteLLM's own `/health/test_connection` with the
 * stored connection. A failure comes back as one clear sentence (wrong key, blocked host, unknown
 * deployment), never a stack trace.
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { authorize } from '@core/infra/governed';
import { testProviderConnection } from '@tabs/admin/lib/llm-providers';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { user } = await adminCtx();
    const authz = await authorize(`user:${user.id}`, 'admin');
    if (!authz.allowed) return NextResponse.json({ error: `Policy did not allow this admin action (${authz.policy}).`, code: 'policy_denied' }, { status: 403 });
    let b: Record<string, unknown>;
    try { b = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ error: 'The request body must be JSON' }, { status: 400 }); }
    const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
    const r = await testProviderConnection({
      preset: s('preset') ?? '', provider: s('provider'), connection: s('connection'), model: s('model') ?? '',
      mode: s('mode') === 'embedding' ? 'embedding' : 'chat',
    });
    if (r.ok) return NextResponse.json({ ok: true, model: r.model });
    return NextResponse.json({ ok: false, code: r.code, message: r.message }, { status: r.status === 200 ? 200 : r.status });
  } catch (e) {
    return fail(e);
  }
}
