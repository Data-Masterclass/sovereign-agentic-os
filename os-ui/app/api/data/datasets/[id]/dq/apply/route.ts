/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { apiError, withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { requireDatasetEditable, builtLayerFqn } from '@tabs/data/lib/store';
import { queryRun, executeRun } from '@core/infra/governed';
import { routeFor } from '@core/infra/trino-source';
import { applyFixes, type FixApplyInput } from '@tabs/data/lib/dq-fix-server';

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
  if (!check) return apiError(404, 'unknown check', 'data.unknownCheck');

  const resolved = builtLayerFqn(dataset, user);
  if (!resolved) return apiError(409, 'nothing is built yet — there is no table to fix', 'data.nothingBuilt');

  let input: FixApplyInput;
  if (body.mode === 'batch') {
    if (typeof body.sqlExpr !== 'string' || !body.sqlExpr.trim()) {
      return apiError(400, 'batch mode needs a sqlExpr', 'data.batchNeedsSqlExpr');
    }
    input = { mode: 'batch', sqlExpr: body.sqlExpr };
  } else if (body.mode === 'rows') {
    const fixes = (Array.isArray(body.fixes) ? body.fixes : [])
      .map((f) => ({ pk: String(f?.pk ?? ''), proposed: typeof f?.proposed === 'string' ? f.proposed : String(f?.proposed ?? '') }))
      .filter((f) => f.pk.length > 0);
    if (fixes.length === 0) return apiError(400, 'rows mode needs at least one accepted fix', 'data.rowsNeedFix');
    input = { mode: 'rows', fixes };
  } else {
    return apiError(400, "mode must be 'batch' or 'rows'", 'data.modeInvalid');
  }

  const outcome = await applyFixes(dataset, check, input, {
    fqn: resolved.fqn,
    layer: resolved.layer,
    queryFn: (sql) => queryRun(sql, resolved.principal, routeFor(user, 'data-dq', dataset.domain)),
    // The governed WRITE runs AS the signed-in user — identity from the session,
    // never the body; the query-tool re-gates target schema + role floor.
    executeFn: (sql) =>
      executeRun(
        sql,
        { principal: resolved.principal, uid: user.id, domains: user.domains, role: user.role },
        routeFor(user, 'data-dq', dataset.domain),
      ),
    ranBy: user.id,
    domain: dataset.domain,
  });
  return NextResponse.json(outcome);
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
