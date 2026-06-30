/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getWorkflow } from '@/lib/knowledge/store';
import { scaffoldSystem, type Disposition } from '@/lib/knowledge/agent-scaffold';
import { createSystem } from '@/lib/agents/store';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

type Params = { params: Promise<{ id: string }> };

/**
 * POST → SUGGEST an agent-system scaffold from this workflow's steps (handover to
 * the Agents tab). Body: { dispositions?: {stepId: manual|augment|automate},
 * create?: boolean }. Without `create` we just return the proposed system.yaml +
 * the per-step preview; with `create` we materialise it in the Agents tab (the
 * whole workflow is attached as context via grants.knowledge) and return its id.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const view = getWorkflow(id, user);
    const body = await req.json().catch(() => ({}));
    const dispositions = (body?.dispositions ?? {}) as Record<string, Disposition>;

    const scaffold = scaffoldSystem(view.workflow, { dispositions, name: `${view.title} agent` });

    if (body?.create === true) {
      const rec = createSystem(
        { id: user.id, domains: user.domains, role: user.role },
        { name: scaffold.system.system.name, domain: view.domain, yaml: scaffold.yaml },
      );
      return NextResponse.json({
        created: true,
        systemId: rec.id,
        agentSteps: scaffold.agentSteps,
        manualSteps: scaffold.manualSteps,
      });
    }

    return NextResponse.json({
      created: false,
      yaml: scaffold.yaml,
      agentSteps: scaffold.agentSteps,
      manualSteps: scaffold.manualSteps,
    });
  } catch (e) {
    return fail(e);
  }
}
