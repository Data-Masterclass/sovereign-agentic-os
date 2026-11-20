/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../../_ctx';
import { deleteDomain, domainDeleteWiring } from '@core/kernel/domain-delete';
import { authorize } from '@core/infra/governed';

export const dynamic = 'force-dynamic';

/**
 * POST → delete a domain (Admin → Domains). `{ dryRun }` defaults to TRUE: the response is the
 * plan (every object per component that will go, and every object KEPT because something outside
 * the domain maps to it). A run needs `{ dryRun:false, confirm:<domain id> }` and a backup from
 * the last 2 h (or `iHaveABackup:true`). Admin only (adminCtx), every step audited.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await adminCtx();
    // Governance first (GLUE-7): OPA must not deny the admin scope before anything is read.
    const decision = await authorize(`user:${user.id}`, 'admin');
    if (decision.policy === 'opa-deny') return NextResponse.json({ error: 'OPA denied the admin scope' }, { status: 403 });
    const { id } = await ctx.params;
    const text = await req.text();
    let body: { dryRun?: unknown; confirm?: unknown; iHaveABackup?: unknown } = {};
    if (text.trim()) {
      try { body = JSON.parse(text); } catch (e) { return NextResponse.json({ error: `Invalid JSON body: ${(e as Error).message}` }, { status: 400 }); }
    }
    const run = body.dryRun === false;
    // A RUN is a person's act: the cookie session (adminCtx) of a browser on this origin. MCP and
    // agent bearers never reach this route; the Fetch Metadata header is set by the browser.
    if (run && req.headers.get('sec-fetch-site') !== 'same-origin') {
      return NextResponse.json({ error: 'A delete run is accepted only from Admin → Domains in a signed-in browser session' }, { status: 403 });
    }
    const w = domainDeleteWiring();
    const report = await deleteDomain(
      id,
      { dryRun: body.dryRun !== false, confirm: typeof body.confirm === 'string' ? body.confirm : undefined, iHaveABackup: body.iHaveABackup === true },
      {
        actor: { id: user.id, role: user.role, domains: user.allDomains },
        components: w.components(),
        backup: w.backup,
        audit: w.audit({ id: user.id, role: user.role }),
        validateTarget: w.validateTarget,
        allowRun: true,
      },
    );
    const status = report.status === 'refused' ? 412 : report.status === 'failed' ? 502 : 200;
    return NextResponse.json(report, { status });
  } catch (e) {
    return fail(e);
  }
}
