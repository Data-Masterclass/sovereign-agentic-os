/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { roleAtLeast } from '@/lib/core/session';
import { evaluateAlert } from '@/lib/metrics/alerts';
import { listAlertRules, recordEvaluation, ensureHydrated } from '@/lib/metrics/alert-store';
import { deliverAlert } from '@/lib/dashboards/delivery';
import { getPublicUser } from '@/lib/platform-admin/users';
import { delegatedToken } from '@/lib/infra/identity-server';
import { getDataset } from '@/lib/data/store';
import { exploreMetric } from '@/lib/metrics/build/explore-server';

export const dynamic = 'force-dynamic';

/**
 * Evaluate ALL persisted alert rules against the live Cube metric values.
 *
 * Wire this to a Kubernetes CronJob — see
 * charts/sovereign-agentic-os/templates/metrics-alert-cronjob.yaml (chart follow-up).
 * A schedule of `* /5 * * * *` (every 5 minutes) is a reasonable starting point.
 *
 * Governance: Builder+ only (same as single-rule evaluation).
 */
export async function GET(req: Request) {
  try {
    await ensureHydrated();
    const user = await requirePrincipal();
    if (!roleAtLeast(user.role, 'builder')) {
      return NextResponse.json({ error: 'not permitted to run alert evaluation' }, { status: 403 });
    }

    const { token } = await delegatedToken('domain');
    const email = (await getPublicUser(user.id))?.email;
    const rules = listAlertRules();

    let evaluated = 0;
    let breached = 0;
    const results: { ruleId: string; member: string; value: number | null; breached: boolean; pending?: boolean; error?: string }[] = [];

    for (const rule of rules) {
      try {
        // Resolve live value for this rule's metric member
        const lastDot = rule.member.lastIndexOf('.');
        const datasetId = rule.member.slice(0, lastDot);
        const measureName = rule.member.slice(lastDot + 1);

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
          // Dataset not found or not accessible — skip this rule
        }

        if (liveValue === null) {
          results.push({ ruleId: rule.id, member: rule.member, value: null, breached: false, pending: true });
          continue;
        }

        const evald = evaluateAlert(rule, liveValue);
        recordEvaluation(rule.id, liveValue, evald.breached);
        evaluated++;

        if (evald.breached) {
          breached++;
          await deliverAlert(evald, rule.member, { userId: rule.owner, email });
        }

        results.push({ ruleId: rule.id, member: rule.member, value: liveValue, breached: evald.breached });
      } catch (e) {
        results.push({ ruleId: rule.id, member: rule.member, value: null, breached: false, error: (e as Error).message });
      }
    }

    void req; // unused
    return NextResponse.json({ evaluated, breached, results });
  } catch (e) {
    return errorResponse(e);
  }
}
