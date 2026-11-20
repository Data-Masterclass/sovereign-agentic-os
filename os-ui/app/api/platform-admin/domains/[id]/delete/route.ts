/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { adminCtx, fail } from '../../../_ctx';
import { deleteDomain, domainDeleteWiring } from '@core/kernel/domain-delete';
import { authorize } from '@core/infra/governed';
import { SESSION_COOKIE } from '@core/kernel/session';
import { assertHumanSession, consumeConfirmToken, issueConfirmToken } from '@tabs/admin/lib/domain-delete-confirm';

export const dynamic = 'force-dynamic';

/**
 * POST → delete a domain (Admin → Domains). Admin only (adminCtx: the cookie session), OPA asked.
 *   - `{}` or `{ dryRun: true }`: the plan (what goes, per component; what is KEPT and why;
 *     what BLOCKS the run).
 *   - `{ action: 'confirm', confirm: <domain id> }`: the typed id, from the signed-in browser
 *     session → a 2-minute, single-use token bound to (user, session, domain).
 *   - `{ dryRun: false, token, iHaveABackup? }`: the run. Needs that token from THIS session; any
 *     Authorization bearer (MCP, agent, app) is refused; no client-set header is trusted.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await adminCtx();
    // Governance first (GLUE-7): OPA must not deny the admin scope before anything is read.
    const decision = await authorize(`user:${user.id}`, 'admin');
    if (decision.policy === 'opa-deny') return NextResponse.json({ error: 'OPA denied the admin scope' }, { status: 403 });
    const { id } = await ctx.params;
    const text = await req.text();
    let body: { dryRun?: unknown; confirm?: unknown; iHaveABackup?: unknown; action?: unknown; token?: unknown } = {};
    if (text.trim()) {
      try { body = JSON.parse(text); } catch (e) { return NextResponse.json({ error: `Invalid JSON body: ${(e as Error).message}` }, { status: 400 }); }
    }
    const sessionCookie = (await cookies()).get(SESSION_COOKIE)?.value;
    const w = domainDeleteWiring();

    if (body.action === 'confirm') {
      assertHumanSession(req.headers, sessionCookie);
      if (typeof body.confirm !== 'string' || body.confirm.trim() !== id) {
        return NextResponse.json({ error: `Type the domain id "${id}" to confirm.` }, { status: 400 });
      }
      await w.validateTarget(id);
      return NextResponse.json(issueConfirmToken({ userId: user.id, sessionCookie: sessionCookie!, domainId: id }));
    }

    const run = body.dryRun === false;
    if (run) {
      assertHumanSession(req.headers, sessionCookie);
      consumeConfirmToken(typeof body.token === 'string' ? body.token : undefined, { userId: user.id, sessionCookie: sessionCookie!, domainId: id });
    }
    const report = await deleteDomain(
      id,
      // The token proves the typed id; the engine's own confirmation is satisfied by it.
      { dryRun: !run, confirm: run ? id : undefined, iHaveABackup: body.iHaveABackup === true },
      {
        actor: { id: user.id, role: user.role, domains: user.allDomains },
        components: w.components(),
        backup: w.backup,
        audit: w.audit({ id: user.id, role: user.role }),
        validateTarget: w.validateTarget,
        preflight: w.preflight,
        allowRun: true,
      },
    );
    const status = report.status === 'refused' ? 412 : report.status === 'failed' ? 502 : 200;
    return NextResponse.json(report, { status });
  } catch (e) {
    return fail(e);
  }
}
