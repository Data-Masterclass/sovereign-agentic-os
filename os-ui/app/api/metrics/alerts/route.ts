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
import { saveAlertRule } from '@/lib/metrics/alert-store';
import { getDataset } from '@/lib/data/store';
import { delegatedToken } from '@/lib/infra/identity-server';
import { exploreMetric } from '@/lib/metrics/build/explore-server';
import { measureFromForm } from '@/lib/metrics/model';

export const dynamic = 'force-dynamic';

/**
 * Evaluate a metric alert. On breach it actually NOTIFIES the recipient (email when a
 * mailer is configured, else a persisted in-app notification) AND, if a governed agent
 * is configured, requests an agent run (event → LangGraph) — landed as a Langfuse trace
 * so the alert-triggered run is audited.
 *
 * `value` is now OPTIONAL. When omitted, the route resolves the live metric value from
 * Cube (via exploreMetric) using the rule's member. If the member hasn't synced yet
 * (pending), returns `{ pending: true }` rather than an error. Pass `value` explicitly
 * to override (e.g. from an upstream scheduler that already fetched the value).
 *
 * Rules are persisted by default (pass `persist: false` to skip). Governance: only a
 * Builder+ may trigger alert delivery.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    if (!roleAtLeast(user.role, 'builder')) {
      return NextResponse.json({ error: 'not permitted to trigger alerts' }, { status: 403 });
    }
    const body = (await req.json().catch(() => ({}))) as {
      rule?: AlertRule;
      value?: number;
      persist?: boolean;
    };
    if (!body.rule) {
      return NextResponse.json({ error: 'rule is required' }, { status: 400 });
    }

    let resolvedValue: number;

    if (typeof body.value === 'number') {
      resolvedValue = body.value;
    } else {
      // Resolve the live metric value from Cube via the member string.
      // member format: "<CubeView>.<measureName>", e.g. "Orders.revenue"
      // We need to derive the dataset + measure — attempt a governed explore.
      try {
        const { token } = await delegatedToken('domain');
        // Build a minimal synthetic dataset/measure from the member string so
        // exploreMetric can run — the member is already canonical.
        const [cubeName, measureName] = body.rule.member.split('.');
        const lastDot = body.rule.member.lastIndexOf('.');
        const datasetId = body.rule.member.slice(0, lastDot); // best-effort; may be ds_ id
        // Try to get the dataset first (may fail if member doesn't map 1:1 to a datasetId)
        let liveValue: number | null = null;
        try {
          const dataset = getDataset(datasetId, user);
          const measure = dataset.measures.find((m) => m.name === measureName);
          if (measure) {
            const result = await exploreMetric(dataset, measure, token, {});
            const total = result.rows.reduce((sum, row) => sum + Number(row[result.member] ?? 0), 0);
            liveValue = result.rows.length ? total : null;
          }
        } catch {
          // Dataset lookup failed — try creating a synthetic measure via member
          void cubeName; // referenced to avoid unused-var
          const measure = measureFromForm({ name: measureName ?? 'value', aggregation: 'sum', column: '', dimensions: [] });
          // Without a real dataset we cannot resolve — fall through to pending
          void measure;
        }
        if (liveValue === null) {
          return NextResponse.json({ pending: true, error: 'Could not resolve live value — pass value explicitly or try again once the metric has synced (~30 s).' });
        }
        resolvedValue = liveValue;
      } catch {
        return NextResponse.json({ pending: true, error: 'Could not resolve live value — pass value explicitly or try again once the metric has synced (~30 s).' });
      }
    }

    // Persist the rule (default: yes)
    if (body.persist !== false) {
      saveAlertRule(body.rule, user.id, user.domains[0] ?? 'default');
    }

    const evald = evaluateAlert(body.rule, resolvedValue);
    const email = (await getPublicUser(user.id))?.email;
    const delivery = await deliverAlert(evald, body.rule.member, { userId: user.id, email });
    let traced = false;
    if (evald.agentRun) {
      traced = Boolean(await gvTrace({
        principal: `${evald.agentRun.systemId}:${evald.agentRun.agent}`,
        tool: 'alert_trigger',
        input: { member: body.rule.member, value: resolvedValue, threshold: body.rule.threshold },
        output: { reason: evald.agentRun.reason, preset: evald.agentRun.preset },
        decision: 'allow',
      }));
    }
    const saved = body.persist !== false;
    return NextResponse.json({ ...evald, delivery, traced, requestedBy: user.id, ...(saved ? { saved: true } : {}) });
  } catch (e) {
    return errorResponse(e);
  }
}
