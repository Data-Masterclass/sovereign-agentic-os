/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../../_ctx';
import { audit } from '@tabs/admin/lib/audit';
import { ensureMirrorsHydrated, getProjectMirror, setProjectMirror, clearProjectMirror, pushProjectMirror } from '@tabs/data/lib/dbt/mirror';

export const dynamic = 'force-dynamic';

/** GET → the domain's mirror config (URL + token Secret REFERENCE, never the token) and push status. */
export async function GET(_req: Request, ctx: { params: Promise<{ domain: string }> }) {
  try {
    await adminCtx();
    await ensureMirrorsHydrated();
    const { domain } = await ctx.params;
    return NextResponse.json({ mirror: getProjectMirror(domain) });
  } catch (e) {
    return fail(e);
  }
}

/**
 * PUT `{ url, tokenSecretRef: { name, key } }` → configure the push mirror of a domain's data-project
 * repo (admin only); `{ mirror: null }` clears it. The token itself is never accepted here — store it
 * through the secrets helper first and pass its reference. `?push=1` pushes once right away and
 * reports the outcome (a failed push is reported, never a 5xx).
 */
export async function PUT(req: Request, ctx: { params: Promise<{ domain: string }> }) {
  try {
    const { user, tenant } = await adminCtx();
    await ensureMirrorsHydrated();
    const { domain } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { mirror?: null; url?: string; tokenSecretRef?: { name: string; key: string } };
    if (body.mirror === null) {
      const removed = clearProjectMirror(domain);
      audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'data-project.mirror.clear', target: `domain:${domain}`, detail: removed ? 'Mirror removed' : 'No mirror was configured' });
      return NextResponse.json({ mirror: null, removed });
    }
    const rec = setProjectMirror(domain, { url: body.url ?? '', tokenSecretRef: body.tokenSecretRef as { name: string; key: string } }, user);
    audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'data-project.mirror.set', target: `domain:${domain}`, detail: `Mirror → ${rec.url} (token secret ${rec.tokenSecretRef.name}/${rec.tokenSecretRef.key})` });
    const push = new URL(req.url).searchParams.get('push') === '1' ? await pushProjectMirror(domain) : null;
    return NextResponse.json({ mirror: getProjectMirror(domain), push });
  } catch (e) {
    return fail(e);
  }
}
