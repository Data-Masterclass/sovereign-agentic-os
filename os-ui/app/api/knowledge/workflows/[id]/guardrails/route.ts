/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getWorkflow } from '@tabs/knowledge/lib/store';
import { compileGuardrails } from '@tabs/knowledge/lib/guardrails';
import { applyGuardrails } from '@tabs/knowledge/lib/guardrails-apply';
import { roleAtLeast } from '@core/kernel/session';

export const dynamic = 'force-dynamic';

/** GET → preview the compiled guardrails (hard rules → OPA) without applying. */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const view = getWorkflow(id, user);
    return NextResponse.json(compileGuardrails(view.workflow));
}, { defaultStatus: 500 });

/**
 * POST → compile + apply→verify the workflow's hard-rule guardrails to OPA.
 * Live-tries the OPA REST API; falls back to an honest in-process mock offline.
 * A row is ✓ only when BOTH apply AND verify pass.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    // Edit-scoped: applying a policy is an edit-level action, not a view.
    const view = getWorkflow(id, user);
    if (view.owner !== user.id && !roleAtLeast(user.role, 'builder')) {
      return NextResponse.json({ error: 'Not permitted to apply guardrails for this workflow' }, { status: 403 });
    }
    const result = await applyGuardrails(view.workflow);
    return NextResponse.json(result);
}, { defaultStatus: 500 });
