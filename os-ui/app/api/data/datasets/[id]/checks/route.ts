/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal, errorResponse } from '@tabs/data/lib/server';
import { runWithSurface, uiSurfaceFor } from '@core/infra/request-surface';
import { getDataset, removeCheck, updateCheckDescriptions } from '@tabs/data/lib/store';
import { defineQualityRulesService, runQualityChecksService } from '@tabs/data/lib/mutations-server';

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
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const dataset = getDataset(id, user);
  return NextResponse.json({ checks: dataset.checks ?? [] });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

/**
 * SKIP: POST dispatches on body.action with per-branch gates — left hand-rolled.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    return await runWithSurface(uiSurfaceFor(req.url), async () => {
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
      descriptions?: unknown;
    };

    // ── Run the checks + monitors: compile → governed SELECT AS the owner → pass/fail ──
    if (body.action === 'run') {
      // `runQualityChecksService` is the SAME function MCP `run_quality_checks` calls
      // (checklist X8): the dataset's rules AND its heuristic monitors, run AS the owner for
      // a personal dataset (personal_<uid>) else the caller's domain principal — never
      // trusted from the body — and persisted as ONE run of the durable series.
      const outcome = await runQualityChecksService(user, id);
      return NextResponse.json({
        fqn: outcome.fqn,
        ranAt: outcome.ranAt,
        badge: outcome.badge,
        results: outcome.results,
        health: outcome.health,
      });
    }

    // ── Save edited/AI-drafted rule DESCRIPTIONS (text only; never the rule itself) ──
    if (body.action === 'describe') {
      const updates = Array.isArray(body.descriptions)
        ? (body.descriptions as unknown[])
            .map((u) => (u && typeof u === 'object' ? (u as Record<string, unknown>) : {}))
            .map((u) => ({ id: String(u.id ?? '').trim(), description: typeof u.description === 'string' ? u.description : '' }))
            .filter((u) => u.id)
        : [];
      const dataset = updateCheckDescriptions(id, user, updates);
      return NextResponse.json({ checks: dataset.checks ?? [] });
    }

    // ── Add a check (structured rule or legacy free-text) ──
    // ONE rule through `defineQualityRulesService` — the SAME function MCP
    // `define_quality_rules` calls with a list (checklist X8), so the validation
    // (`<rule> needs a column`, an unknown rule, `name is required`) is identical.
    const dataset = defineQualityRulesService(user, id, [
      { rule: body.rule, column: body.column, name: body.name, description: body.description, values: body.values, min: body.min, max: body.max },
    ]);
    const check = (dataset.checks ?? []).at(-1)!;
    return NextResponse.json({ check, checksCount: (dataset.checks ?? []).length });
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export const DELETE = withRoute<{ id: string }, { checkId?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  const checkId = (body.checkId ?? '').trim();
  if (!checkId) return NextResponse.json({ error: 'checkId is required' }, { status: 400 });
  const dataset = removeCheck(id, user, checkId);
  return NextResponse.json({ checks: dataset.checks ?? [] });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
