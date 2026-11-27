/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { trace as gvTrace } from '@core/infra/agent-governed';
import { requirePrincipal } from '@tabs/data/lib/server';
import { apiError, withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { roleAtLeast } from '@core/kernel/session';
import { getPublicUser } from '@tabs/admin/lib/users';
import { type AlertRule, evaluateAlert } from '@tabs/metrics/lib/alerts';
import { deliverAlert } from '@tabs/dashboards/lib/delivery';
import { listAlertRules, saveAlertRule } from '@tabs/metrics/lib/alert-store';
import type { AlertCommit } from '@tabs/metrics/lib/git/alerts-commit';
import { alertsNativeEnabled } from '@core/infra/repo-layout';
import { resolveAlertValue } from '@tabs/metrics/lib/build/alert-eval';

export const dynamic = 'force-dynamic';

/**
 * Evaluate a metric alert. On breach it actually NOTIFIES the recipient (email when a
 * mailer is configured, else a persisted in-app notification) AND, if a governed agent
 * is configured, requests an agent run (event → LangGraph) — landed as a Langfuse trace
 * so the alert-triggered run is audited.
 *
 * `value` is now OPTIONAL. When omitted, the route resolves the live metric value through the
 * governed-SQL path (exploreMetric — Cube is off the read path, Phase 2), evaluated AS THE
 * CALLER (who owns the rule they are creating). HONESTY: an unreachable Trino → `{ unavailable:
 * true }` (evaluation SKIPPED, no fabricated value, no false alarm); a metric with no number
 * yet → `{ pending: true }`. Pass `value` explicitly to override (e.g. from an upstream
 * scheduler that already fetched the value).
 *
 * Rules are persisted by default (pass `persist: false` to skip). Governance: only a
 * Builder+ may trigger alert delivery.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const POST = withRoute<Record<string, string>, any>(async ({ user, body }) => {
  if (!roleAtLeast(user.role, 'builder')) {
    return apiError(403, 'not permitted to trigger alerts', 'metrics.alertsNotPermitted');
  }
  if (!body.rule) {
    return apiError(400, 'rule is required', 'metrics.ruleRequired');
  }

  let resolvedValue: number;

  if (typeof body.value === 'number') {
    resolvedValue = body.value;
  } else {
    // Resolve the value through the governed-SQL path AS THE CALLER (the rule's owner). The
    // member is matched against the caller's visible metrics; a Trino outage skips honestly.
    const record = { ...body.rule, owner: user.id, domain: user.domains[0] ?? 'default', createdAt: new Date().toISOString() };
    const resolved = await resolveAlertValue(record);
    if (resolved.status === 'unavailable') {
      return NextResponse.json({ unavailable: true, error: resolved.reason });
    }
    if (resolved.status !== 'ok') {
      return NextResponse.json({ pending: true, error: resolved.reason ?? 'Could not resolve live value — pass value explicitly or try again once the metric is computable.' });
    }
    resolvedValue = resolved.value;
  }

  // Persist the rule (default: yes). WP-50: with OS_ALERTS_NATIVE on, the domain's alerts are
  // committed to metrics/alerts/ (the dbt saved queries MetricFlow evaluates), authored as the user.
  let git: AlertCommit | null = null;
  if (body.persist !== false) {
    const domain = user.domains[0] ?? 'default';
    saveAlertRule(body.rule as AlertRule, user.id, domain);
    if (alertsNativeEnabled()) git = await (await import('@tabs/metrics/lib/git/alerts-commit')).commitDomainAlerts(domain, listAlertRules().filter((r) => r.domain === domain), user);
  }

  const evald = evaluateAlert(body.rule as AlertRule, resolvedValue);
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
  return NextResponse.json({ ...evald, delivery, traced, requestedBy: user.id, ...(saved ? { saved: true } : {}), ...(git ? { git: { sha: git.commit?.sha ?? null, pending: git.pending } } : {}) });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, parse: true });
