/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import { evaluateAlert } from '@/lib/metrics/alerts';
import { listAlertRules, recordEvaluation, ensureHydrated } from '@/lib/metrics/alert-store';
import { deliverAlert } from '@/lib/dashboards/delivery';
import { getPublicUser } from '@/lib/platform-admin/users';
import { resolveAlertValue } from '@/lib/metrics/build/alert-eval';

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
 * Governance: Builder+ only (same as single-rule evaluation).
 */
export const GET = withRoute(async ({ user }) => {
  if (!roleAtLeast(user.role, 'builder')) {
    return NextResponse.json({ error: 'not permitted to run alert evaluation' }, { status: 403 });
  }

  await ensureHydrated();
  const rules = listAlertRules();

  let evaluated = 0;
  let breached = 0;
  const results: { ruleId: string; member: string; value: number | null; breached: boolean; status: 'ok' | 'pending' | 'unavailable' | 'error'; reason?: string }[] = [];

  for (const rule of rules) {
    try {
      // Resolve the value AS THE RULE'S OWNER through the governed-SQL path.
      const resolved = await resolveAlertValue(rule);
      if (resolved.status !== 'ok') {
        // Unavailable (Trino outage) or pending (no number yet): SKIP — never fabricate, never
        // fire. Both are honest non-evaluations; the next tick retries.
        results.push({ ruleId: rule.id, member: rule.member, value: null, breached: false, status: resolved.status, reason: resolved.reason });
        continue;
      }

      const evald = evaluateAlert(rule, resolved.value);
      recordEvaluation(rule.id, resolved.value, evald.breached);
      evaluated++;

      if (evald.breached) {
        breached++;
        const email = (await getPublicUser(rule.owner))?.email;
        await deliverAlert(evald, rule.member, { userId: rule.owner, email });
      }

      results.push({ ruleId: rule.id, member: rule.member, value: resolved.value, breached: evald.breached, status: 'ok' });
    } catch (e) {
      results.push({ ruleId: rule.id, member: rule.member, value: null, breached: false, status: 'error', reason: (e as Error).message });
    }
  }

  return NextResponse.json({ evaluated, breached, results });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
