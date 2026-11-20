/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * POST /api/platform-admin/providers/connections — step 2: a provider connection (endpoint + key),
 * stored in LiteLLM's own credential store (`POST /credentials`, encrypted with LITELLM_SALT_KEY).
 * The egress check runs FIRST: a host the proxy would not let out is refused (422) with the exact
 * values change, and nothing is stored. The key is never stored by the OS, never logged, never returned.
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { authorize } from '@core/infra/governed';
import { connectProvider } from '@tabs/admin/lib/llm-providers';
import { audit } from '@tabs/admin/lib/audit';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const authz = await authorize(`user:${user.id}`, 'admin');
    if (!authz.allowed) return NextResponse.json({ error: `Policy did not allow this admin action (${authz.policy}).`, code: 'policy_denied' }, { status: 403 });
    let b: Record<string, unknown>;
    try { b = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ error: 'The request body must be JSON' }, { status: 400 }); }
    const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
    const r = await connectProvider({ preset: s('preset') ?? '', name: s('name') ?? '', provider: s('provider'), apiBase: s('apiBase'), apiVersion: s('apiVersion'), apiKey: s('apiKey') });
    audit({
      tenant: tenant.id, actor: user.id, role: user.role, action: 'llm.connection',
      target: `llm-connection:${s('name') ?? ''}`,
      detail: r.ok ? `Stored ${r.provider} connection in LiteLLM (host ${r.host}, ${r.route}); key never surfaced.` : `Refused: ${r.code}${r.host ? ` (${r.host})` : ''}.`,
    });
    if (!r.ok) return NextResponse.json({ error: r.message, code: r.code, host: r.host, guidance: r.guidance }, { status: r.status });
    return NextResponse.json({ connection: { name: r.name, provider: r.provider, host: r.host, route: r.route } }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
