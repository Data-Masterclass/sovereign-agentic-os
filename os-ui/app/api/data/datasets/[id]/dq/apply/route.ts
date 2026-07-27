/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
import { requireDatasetEditable, builtLayerFqn } from '@/lib/data/store';
import { queryRun, executeRun } from '@/lib/infra/governed';
import { applyFixes, type FixApplyInput } from '@/lib/data/dq-fix-server';

export const dynamic = 'force-dynamic';

/**
 * APPLY accepted DQ remediations for ONE rule (Validate stage) — the write door.
 *
 * POST { checkId, mode:'batch', sqlExpr } | { checkId, mode:'rows', fixes:[{pk,proposed}] }
 *
 * EDIT-GATED like every dataset mutation (requireDatasetEditable — owner, or in-domain
 * domain_admin/admin on a shared dataset; personal stays owner-only). The payload is
 * NEVER trusted: the expression re-passes the fix guard server-side, per-row values are
 * bound as escaped literals, and the ONE resulting MERGE runs through the governed
 * /execute AS THE SIGNED-IN USER — the query-tool re-validates statement shape and the
 * schema/role floor before Trino sees it. Nothing applies without this explicit call.
 *
 * The response is honest: `recheck` is the rule RE-RUN after the write (a fix that
 * didn't fix stays red), and `remediation` carries the audit record (batch id +
 * pre-apply Iceberg snapshot id — revert is via Console; no governed rollback exists).
 */
export const POST = withRoute<
  { id: string },
  { checkId?: string; mode?: string; sqlExpr?: string; fixes?: { pk?: unknown; proposed?: unknown }[] }
>(async ({ user, params, body }) => {
  const dataset = requireDatasetEditable(params.id, user); // edit gate (403/404)
  const checkId = (body.checkId ?? '').trim();
  const check = (dataset.checks ?? []).find((c) => c.id === checkId);
  if (!check) return NextResponse.json({ error: 'unknown check' }, { status: 404 });

  const resolved = builtLayerFqn(dataset, user);
  if (!resolved) return NextResponse.json({ error: 'nothing is built yet — there is no table to fix' }, { status: 409 });

  let input: FixApplyInput;
  if (body.mode === 'batch') {
    if (typeof body.sqlExpr !== 'string' || !body.sqlExpr.trim()) {
      return NextResponse.json({ error: 'batch mode needs a sqlExpr' }, { status: 400 });
    }
    input = { mode: 'batch', sqlExpr: body.sqlExpr };
  } else if (body.mode === 'rows') {
    const fixes = (Array.isArray(body.fixes) ? body.fixes : [])
      .map((f) => ({ pk: String(f?.pk ?? ''), proposed: typeof f?.proposed === 'string' ? f.proposed : String(f?.proposed ?? '') }))
      .filter((f) => f.pk.length > 0);
    if (fixes.length === 0) return NextResponse.json({ error: 'rows mode needs at least one accepted fix' }, { status: 400 });
    input = { mode: 'rows', fixes };
  } else {
    return NextResponse.json({ error: "mode must be 'batch' or 'rows'" }, { status: 400 });
  }

  const outcome = await applyFixes(dataset, check, input, {
    fqn: resolved.fqn,
    layer: resolved.layer,
    queryFn: (sql) => queryRun(sql, resolved.principal),
    // The governed WRITE runs AS the signed-in user — identity from the session,
    // never the body; the query-tool re-gates target schema + role floor.
    executeFn: (sql) =>
      executeRun(sql, { principal: resolved.principal, uid: user.id, domains: user.domains, role: user.role }),
    ranBy: user.id,
    domain: dataset.domain,
  });
  return NextResponse.json(outcome);
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
