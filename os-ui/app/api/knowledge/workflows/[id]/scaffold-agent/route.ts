/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getWorkflow } from '@tabs/knowledge/lib/store';
import { scaffoldSystem, type Disposition } from '@tabs/knowledge/lib/agent-scaffold';
import { createSystem } from '@tabs/agents/lib/store';

export const dynamic = 'force-dynamic';

/**
 * POST → SUGGEST an agent-system scaffold from this workflow's steps (handover to
 * the Agents tab). Body: { dispositions?: {stepId: manual|augment|automate},
 * create?: boolean }. Without `create` we just return the proposed system.yaml +
 * the preview; with `create` we materialise it in the Agents tab (the whole
 * workflow is attached as context via grants.knowledge) and return its id.
 *
 * The preview has two lists: `actorAgents` — one agent per Agent ACTOR, carrying the
 * actor's long prompt plus the steps it owns — and `agentSteps`, the single-step agents
 * (an augmented/automated non-Agent step, or an Agent step whose actor is not in the
 * registry). `manualSteps` are the remaining human/software handoffs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const POST = withRoute<{ id: string }, any>(async ({ user, params, body }) => {
    const { id } = params;
    const view = getWorkflow(id, user);
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
        actorAgents: scaffold.actorAgents,
        agentSteps: scaffold.agentSteps,
        manualSteps: scaffold.manualSteps,
      });
    }

    return NextResponse.json({
      created: false,
      yaml: scaffold.yaml,
      actorAgents: scaffold.actorAgents,
      agentSteps: scaffold.agentSteps,
      manualSteps: scaffold.manualSteps,
    });
}, { parse: true, defaultStatus: 500 });
