/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { roleAtLeast } from '@core/kernel/session';
import { listGovernedDatasets, builtLayerFqn } from '@tabs/data/lib/store';
import { queryRun } from '@core/infra/governed';
import { ensureHydrated, latestRun } from '@tabs/data/lib/dq-results';
import { runAndRecord, isNewFailure } from '@tabs/data/lib/dq-run-server';
import { deliverDqAlert } from '@tabs/dashboards/lib/delivery';
import { getPublicUser } from '@tabs/admin/lib/users';

export const dynamic = 'force-dynamic';

/**
 * POST /api/data/dq/run-all — the SCHEDULED data-quality sweep.
 *
 * For every GOVERNED dataset (shared assets + certified products), run its checks AND its
 * heuristic monitors through the SAME governed path the Validate stage uses, persist one
 * run to the durable time-series (`dq-results`), and on a NEW failure (a fresh transition
 * INTO `failing`) deliver a notification to the dataset owner via the existing alert
 * delivery boundary (email → else durable in-app; never a silent drop).
 *
 * Governance: Builder+ only — the SAME gate `/api/metrics/alerts/run` enforces. The DQ
 * CronJob calls this the only governed way: it logs in as a builder+ service principal
 * (credentials from a Secret) to obtain a session cookie, then POSTs here. No auth bypass
 * — a non-privileged principal is rejected 403 by this route, not by the Job.
 *
 * Honesty contract preserved end to end: a dataset with no built layer, or whose probes
 * throw, yields `not_run` results and never a fabricated pass; alerts fire only on a real
 * transition into failing, so a broken dataset notifies once, not on every sweep.
 */
export const POST = withRoute(async ({ user }) => {
  if (!roleAtLeast(user.role, 'builder')) {
    return NextResponse.json({ error: 'not permitted to run the data-quality sweep' }, { status: 403 });
  }

  const datasets = listGovernedDatasets();
  let ran = 0;
  let failing = 0;
  let alerted = 0;
  const results: { datasetId: string; badge: string; healthScore: number | null; alerted: boolean; error?: string }[] = [];

  for (const dataset of datasets) {
    try {
      // Prior badge BEFORE this run — the new-failure edge is measured against it.
      const prior = latestRun(dataset.id)?.badge ?? null;
      // Resolve the built layer AS the owner-aware principal (personal lane ⇒ owner;
      // governed ⇒ domain principal). The cron principal is builder+, so it reads the
      // governed domain copy — exactly what OPA permits for that identity.
      const resolved = builtLayerFqn(dataset, user);
      const outcome = await runAndRecord(dataset, {
        fqn: resolved?.fqn ?? null,
        queryFn: (sql) => queryRun(sql, resolved?.principal),
        ownerId: user.id,
      });
      ran++;
      if (outcome.badge === 'failing') failing++;

      let didAlert = false;
      if (isNewFailure(outcome.badge, prior)) {
        const failingLabels = outcome.results.filter((r) => r.status === 'fail').map((r) => r.label);
        const email = (await getPublicUser(dataset.owner))?.email;
        await deliverDqAlert(
          { datasetName: dataset.name, healthScore: outcome.health.score, failingLabels },
          { userId: dataset.owner, email },
        );
        didAlert = true;
        alerted++;
      }
      results.push({ datasetId: dataset.id, badge: outcome.badge, healthScore: outcome.health.score, alerted: didAlert });
    } catch (e) {
      results.push({ datasetId: dataset.id, badge: 'unknown', healthScore: null, alerted: false, error: (e as Error).message });
    }
  }

  return NextResponse.json({ ran, failing, alerted, results });
}, { hydrate: ensureHydrated, gate: requirePrincipal as () => Promise<CurrentUser> });
