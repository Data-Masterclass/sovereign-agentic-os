/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { requireUser } from '@/lib/core/auth';
import { getDataset, addCheck, removeCheck, builtLayerFqn } from '@/lib/data/store';
import { queryRun } from '@/lib/infra/governed';
import { runAndRecord } from '@/lib/data/dq-run-server';
import { omDqAppenderFor } from '@/lib/connections/openmetadata';
import { DATA_CHECK_RULES, type DataCheckRule } from '@/lib/data';

export const dynamic = 'force-dynamic';

/**
 * Data-quality checks for a dataset — the dropdown-driven DQ editor's backend.
 *
 * GET   — list the checks the caller may see (canView gate via getDataset).
 * POST  — add a check (canEdit gate). A STRUCTURED rule (rule + column + args) is
 *         executable; a bare name/description is a legacy free-text intention.
 *         `action:'run'` compiles every structured rule to a governed COUNT-of-
 *         violations SQL and runs it AS THE OWNER (builtLayerFqn) — a REAL pass/fail
 *         per rule + an aggregate badge. A rule that can't run is "not run", never a
 *         fake pass. (dbt-core test integration is the future path.)
 * DELETE — remove a check by id (canEdit gate).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const dataset = getDataset(id, user);
    return NextResponse.json({ checks: dataset.checks ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      name?: string;
      description?: string;
      rule?: string;
      column?: string;
      values?: unknown;
      min?: number;
      max?: number;
    };

    // ── Run the checks + monitors: compile → governed SELECT AS the owner → pass/fail ──
    if (body.action === 'run') {
      const dataset = getDataset(id, user); // canView gate (403/404)
      const resolved = builtLayerFqn(dataset, user); // { fqn, principal } | null
      // Runs the dataset's rules AND its heuristic monitors, then persists ONE run to the
      // durable time-series. Run AS the owner for a personal dataset (personal_<uid>), else
      // the caller's domain principal — NEVER trusted from the body; the same resolver
      // preview/profile use, so OPA governs exactly what the owner may read.
      // Best-effort OM DQ result-appender (null unless the flag is on AND an OM is
      // connected). Non-blocking: it never throws and never fakes success, so the DQ run
      // succeeds regardless of OM's state. `requireUser` gives the CurrentUser the OM
      // connection lookup needs (same session as the `requirePrincipal` above).
      const omAppend = await omDqAppenderFor(await requireUser(), dataset).catch(() => null);
      const outcome = await runAndRecord(dataset, {
        fqn: resolved?.fqn ?? null,
        queryFn: (sql) => queryRun(sql, resolved?.principal),
        ownerId: user.id,
        omAppend: omAppend ?? undefined,
      });
      return NextResponse.json({
        fqn: outcome.fqn,
        ranAt: outcome.ranAt,
        badge: outcome.badge,
        results: outcome.results,
        health: outcome.health,
      });
    }

    // ── Add a check (structured rule or legacy free-text) ──
    const rule = typeof body.rule === 'string' && (DATA_CHECK_RULES as string[]).includes(body.rule)
      ? (body.rule as DataCheckRule)
      : undefined;
    if (rule) {
      const column = (body.column ?? '').trim();
      if (!column) return NextResponse.json({ error: `${rule} needs a column` }, { status: 400 });
      const values = Array.isArray(body.values) ? body.values.map((x) => String(x)) : undefined;
      const dataset = addCheck(id, user, {
        name: body.name || `${rule}(${column})`,
        description: body.description ?? '',
        rule,
        column,
        values,
        min: numOrUndef(body.min),
        max: numOrUndef(body.max),
      });
      const check = (dataset.checks ?? []).at(-1)!;
      return NextResponse.json({ check, checksCount: (dataset.checks ?? []).length });
    }

    // Legacy free-text intention.
    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    const dataset = addCheck(id, user, { name: body.name, description: body.description ?? '' });
    const check = (dataset.checks ?? []).at(-1)!;
    return NextResponse.json({ check, checksCount: (dataset.checks ?? []).length });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { checkId?: string };
    const checkId = (body.checkId ?? '').trim();
    if (!checkId) return NextResponse.json({ error: 'checkId is required' }, { status: 400 });
    const dataset = removeCheck(id, user, checkId);
    return NextResponse.json({ checks: dataset.checks ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}
