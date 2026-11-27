/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@tabs/data/lib/server';
import { apiError, withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { roleAtLeast } from '@core/kernel/session';
import { evaluateAlert } from '@tabs/metrics/lib/alerts';
import { listAlertRules, recordEvaluation, ensureHydrated } from '@tabs/metrics/lib/alert-store';
import { deliverAlert } from '@tabs/dashboards/lib/delivery';
import { getPublicUser } from '@tabs/admin/lib/users';
import { resolveAlertValue } from '@tabs/metrics/lib/build/alert-eval';
import { alertsNativeEnabled } from '@core/infra/repo-layout';
import { config } from '@core/kernel/config';

export const dynamic = 'force-dynamic';

/**
 * Evaluate ALL persisted alert rules against the live governed-SQL metric values (Phase 2:
 * through exploreMetric — Cube is off the read path). Each rule is evaluated AS ITS OWNER
 * (headless: the owner's delegated identity, per-viewer RLS), so a threshold fires on exactly
 * the number the owner sees.
 *
 * HONESTY: an unreachable Trino makes evaluation SKIP with status 'unavailable' — never a
 * fabricated value and never a false alarm. A metric with no number yet is 'pending' (skipped,
 * retried next tick). Only a genuinely computed value is compared to the threshold.
 *
 * Wire this to a Kubernetes CronJob — see
 * charts/sovereign-agentic-os/templates/metrics-alert-cronjob.yaml (chart follow-up).
 * A schedule of `* /5 * * * *` (every 5 minutes) is a reasonable starting point.
 *
 * WP-50 (`OS_ALERTS_NATIVE` on): the rule is read from its COMMITTED `metrics/alerts/*.yml` and the
 * number is MetricFlow's (`mf query --saved-query`, the Dagster image's alert job, run as the
 * owner). The OS's metric compiler is not called; the committed threshold decides.
 *
 * Governance: Builder+ only. Evaluating EVERY alert is for the scheduler's identity (the CronJob's
 * principal, `OS_ALERTS_SCHEDULER_PRINCIPAL`) and admins; any other builder evaluates only their
 * own alerts, so nobody triggers runs as another owner.
 */
export const GET = withRoute(async ({ user }) => {
  if (!roleAtLeast(user.role, 'builder')) {
    return apiError(403, 'not permitted to run alert evaluation', 'metrics.alertRunNotPermitted');
  }

  await ensureHydrated();
  const scheduler = config.alertsSchedulerPrincipal;
  // The CronJob logs in with its Secret's `username` (an id or an e-mail).
  const isScheduler = scheduler !== '' && (user.id === scheduler || (await getPublicUser(user.id))?.email?.toLowerCase() === scheduler.toLowerCase());
  const everyAlert = user.role === 'admin' || isScheduler;
  const rules = everyAlert ? listAlertRules() : listAlertRules(user.id);

  let evaluated = 0;
  let breached = 0;
  const results: { ruleId: string; owner: string; member: string; value: number | null; breached: boolean; status: 'ok' | 'pending' | 'unavailable' | 'orphaned' | 'refused' | 'error'; reason?: string }[] = [];

  for (const rule of rules) {
    try {
      // Resolve the value AS THE RULE'S OWNER: MetricFlow on the committed rule (WP-50), else the
      // governed-SQL path (interim).
      const native = alertsNativeEnabled() ? await (await import('@tabs/metrics/lib/build/alert-eval-metricflow')).evaluateCommittedAlert(rule) : null;
      const resolved = native ?? (await resolveAlertValue(rule));
      if (resolved.status !== 'ok') {
        // Unavailable (Trino outage) or pending (no number yet): SKIP — never fabricate, never
        // fire. Both are honest non-evaluations; the next tick retries.
        results.push({ ruleId: rule.id, owner: rule.owner, member: rule.member, value: null, breached: false, status: resolved.status, reason: resolved.reason });
        continue;
      }

      const evald = native && native.status === 'ok'
        ? evaluateAlert({ ...rule, comparator: native.committed.comparator, threshold: native.committed.threshold }, resolved.value)
        : evaluateAlert(rule, resolved.value);
      if (native && native.status === 'ok' && native.breached !== evald.breached) {
        throw new Error(`MetricFlow job and the committed threshold disagree for ${rule.id}`);
      }
      recordEvaluation(rule.id, resolved.value, evald.breached);
      evaluated++;

      if (evald.breached) {
        breached++;
        const email = (await getPublicUser(rule.owner))?.email;
        await deliverAlert(evald, rule.member, { userId: rule.owner, email });
      }

      results.push({ ruleId: rule.id, owner: rule.owner, member: rule.member, value: resolved.value, breached: evald.breached, status: 'ok' });
    } catch (e) {
      results.push({ ruleId: rule.id, owner: rule.owner, member: rule.member, value: null, breached: false, status: 'error', reason: (e as Error).message });
    }
  }

  // Every rule is evaluated (and delivered to ITS owner) whoever triggers the sweep, but the
  // values in the answer are each owner's own numbers, read with their row security. So the
  // caller sees the rows of their own rules; only an admin sees every rule's row.
  const visible = everyAlert ? results : results.filter((r) => r.owner === user.id);
  return NextResponse.json({ evaluated, breached, results: visible });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
