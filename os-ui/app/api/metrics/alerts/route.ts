/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { trace as gvTrace } from '@/lib/infra/agent-governed';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { roleAtLeast } from '@/lib/core/session';
import { getPublicUser } from '@/lib/platform-admin/users';
import { type AlertRule, evaluateAlert } from '@/lib/metrics/alerts';
import { deliverAlert } from '@/lib/dashboards/delivery';

export const dynamic = 'force-dynamic';

/**
 * Evaluate a metric alert. On breach it actually NOTIFIES the recipient (email when a
 * mailer is configured, else a persisted in-app notification) AND, if a governed agent
 * is configured, requests an agent run (event → LangGraph) — landed as a Langfuse trace
 * so the alert-triggered run is audited. `value` is the metric's current value (the same
 * governed member a viewer sees), passed by the caller/scheduler. Governance: only a
 * Builder+ may trigger alert delivery.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    if (!roleAtLeast(user.role, 'builder')) {
      return NextResponse.json({ error: 'not permitted to trigger alerts' }, { status: 403 });
    }
    const body = (await req.json().catch(() => ({}))) as { rule?: AlertRule; value?: number };
    if (!body.rule || typeof body.value !== 'number') {
      return NextResponse.json({ error: 'rule and a numeric value are required' }, { status: 400 });
    }
    const evald = evaluateAlert(body.rule, body.value);
    const email = (await getPublicUser(user.id))?.email;
    const delivery = await deliverAlert(evald, body.rule.member, { userId: user.id, email });
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
    return NextResponse.json({ ...evald, delivery, traced, requestedBy: user.id });
  } catch (e) {
    return errorResponse(e);
  }
}
