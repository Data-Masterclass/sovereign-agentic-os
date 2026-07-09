/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getWorkflow } from '@/lib/knowledge/store';
import { compileGuardrails } from '@/lib/knowledge/guardrails';
import { applyGuardrails } from '@/lib/knowledge/guardrails-apply';
import { roleAtLeast } from '@/lib/core/session';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

type Params = { params: Promise<{ id: string }> };

/** GET → preview the compiled guardrails (hard rules → OPA) without applying. */
export async function GET(_req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const view = getWorkflow(id, user);
    return NextResponse.json(compileGuardrails(view.workflow));
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST → compile + apply→verify the workflow's hard-rule guardrails to OPA.
 * Live-tries the OPA REST API; falls back to an honest in-process mock offline.
 * A row is ✓ only when BOTH apply AND verify pass.
 */
export async function POST(_req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    // Edit-scoped: applying a policy is an edit-level action, not a view.
    const view = getWorkflow(id, user);
    if (view.owner !== user.id && !roleAtLeast(user.role, 'builder')) {
      return NextResponse.json({ error: 'Not permitted to apply guardrails for this workflow' }, { status: 403 });
    }
    const result = await applyGuardrails(view.workflow);
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
