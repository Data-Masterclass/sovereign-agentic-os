/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getWorkflow } from '@tabs/knowledge/lib/store';
import { compileGuardrails } from '@tabs/knowledge/lib/guardrails';
import { applyGuardrails } from '@tabs/knowledge/lib/guardrails-apply';
import { verifyGuardrails } from '@tabs/knowledge/lib/guardrails-data';
import { config } from '@core/kernel/config';
import { roleAtLeast } from '@core/kernel/session';

export const dynamic = 'force-dynamic';

/** GET → preview the compiled guardrails (hard rules → OPA) without applying. */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const view = getWorkflow(id, user);
    return NextResponse.json(compileGuardrails(view.workflow));
}, { defaultStatus: 500 });

/**
 * POST → check that OPA enforces the workflow's hard-rule guardrails. A row is ✓ only when OPA
 * answers with them; an unreachable OPA is a failure (no fallback).
 *   - `OS_GUARDRAILS_DATA` on (WP-30): nothing is uploaded — the committed guardrails.json reaches
 *     OPA in the os-data bundle; this verifies OPA has them active.
 *   - off (interim): upload the generated module + data, then verify.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    // Edit-scoped: applying a policy is an edit-level action, not a view.
    const view = getWorkflow(id, user);
    if (view.owner !== user.id && !roleAtLeast(user.role, 'builder')) {
      return NextResponse.json({ error: 'Not permitted to apply guardrails for this workflow' }, { status: 403 });
    }
    const result = config.guardrailsData ? await verifyGuardrails(view.workflow) : await applyGuardrails(view.workflow);
    return NextResponse.json(result);
}, { defaultStatus: 500 });
