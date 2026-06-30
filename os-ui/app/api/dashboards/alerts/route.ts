/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { trace as gvTrace } from '@/lib/agent-governed';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { type AlertRule, evaluateAlert } from '@/lib/dashboards/alerts';

export const dynamic = 'force-dynamic';

/**
 * Evaluate a metric alert. On breach it NOTIFIES (the channels) AND, if a governed agent
 * is configured, requests an agent run (event → LangGraph) — which we land as a Langfuse
 * trace here so the alert-triggered run is audited, exactly like every other governed
 * tool call. `value` is the metric's current value (the same governed member a viewer
 * sees), passed by the caller/scheduler.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    const body = (await req.json().catch(() => ({}))) as { rule?: AlertRule; value?: number };
    if (!body.rule || typeof body.value !== 'number') {
      return NextResponse.json({ error: 'rule and a numeric value are required' }, { status: 400 });
    }
    const evald = evaluateAlert(body.rule, body.value);
    let traced = false;
    if (evald.agentRun) {
      traced = Boolean(await gvTrace({
        principal: `${evald.agentRun.systemId}:${evald.agentRun.agent}`,
        tool: 'alert_trigger',
        input: { member: body.rule.member, value: body.value, threshold: body.rule.threshold },
        output: { reason: evald.agentRun.reason, preset: evald.agentRun.preset },
        decision: 'allow',
      }));
    }
    return NextResponse.json({ ...evald, traced, requestedBy: user.id });
  } catch (e) {
    return errorResponse(e);
  }
}
