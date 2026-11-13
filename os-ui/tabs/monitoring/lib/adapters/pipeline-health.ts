/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Pipeline health (lens 2) — Dagster runs of the OS's own assets, read by `os/*` tags
 * USER STORY: As an operator I want Monitoring's pipeline lens to show the Dagster runs that
 *             materialise MY datasets — which dataset, which domain, which principal, from which
 *             commit — instead of anonymous job names, and nothing at all rather than a fake red
 *             alert when Dagster is unreachable.
 * ARCHITECTURE:
 *   - READ-ONLY through the ONE typed client (`core/infra/dagster.ts`): `recentOsRuns` →
 *     `runsOrError`. No launch/terminate mutation here.
 *   - A run tagged `os/dataset` is an OS data product's run: the title names the dataset, the
 *     domain comes from `os/domain`, the owner from `os/principal`. Untagged runs (the demo mart,
 *     a hand-launched job) keep the job name — honest, not hidden.
 *   - Dagster unreachable ⇒ the offline-mock ONLY where demo fixtures are enabled; a real deploy
 *     returns nothing rather than an alert no one can act on.
 *   - FLAG-IRRESPECTIVE, deliberately (review B2-review-M6a): the pre-B2 query asked for
 *     `pipelineName`, deprecated in the Dagster version this chart pins, so the old document was
 *     not a working fallback worth keeping behind the flag. The UNTAGGED title shape is preserved
 *     byte for byte (`<job> — Dagster run`), which is every run an install without
 *     `DATA_PROJECT_GIT` can produce — the `os/*` tags only exist once the `sovereign` code
 *     location runs. `STARTING` / `CANCELING` were added to the amber set: they are run statuses
 *     the old mapping fell through to `unknown`, which read as "no information" for a run that is
 *     plainly in flight.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { recentOsRuns, type DagsterRun } from '@core/infra/dagster';
import { MOCK_PIPELINES } from '@tabs/monitoring/lib/mock';
import type { Health, HealthItem } from '@tabs/monitoring/lib/types';

function runStatusHealth(status: string): Health {
  const s = status.toUpperCase();
  if (s === 'FAILURE' || s === 'CANCELED') return 'red';
  if (s === 'STARTED' || s === 'QUEUED' || s === 'STARTING' || s === 'CANCELING') return 'amber';
  if (s === 'SUCCESS') return 'green';
  return 'unknown';
}

/** One Dagster run → one pipeline health row. `os/*` tags name the OS object where present. */
export function runToItem(r: DagsterRun): HealthItem {
  const dataset = r.tags['os/dataset'];
  const domain = r.tags['os/domain'] ?? r.tags.domain ?? 'platform';
  const owner = r.tags['os/principal'] ?? r.tags.owner ?? domain;
  const action = r.tags['os/action'];
  const commit = r.tags['os/commit'];
  const title = dataset
    ? `${dataset} — ${action ?? 'Dagster run'}${commit ? ` @ ${commit.slice(0, 7)}` : ''}`
    : `${r.jobName || 'pipeline'} — Dagster run`;
  const detail = [
    `Dagster ${r.status.toLowerCase()} (job ${r.jobName || 'unknown'}).`,
    dataset ? `dbt build + tests for OS dataset ${dataset} as ${owner}.` : 'dbt tests / source freshness via run metadata.',
    r.assetSelection.length ? `Assets: ${r.assetSelection.slice(0, 6).join(', ')}${r.assetSelection.length > 6 ? ' …' : ''}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    id: `pl-${r.runId}`,
    lens: 'pipelines',
    title,
    health: runStatusHealth(r.status),
    detail,
    owner,
    domain,
    ts: r.startedAt ?? undefined,
    links: { pipelineId: `pl-${r.runId}`, ...(dataset ? { datasetId: dataset } : {}) },
    source: 'live',
  };
}

export async function collectPipelines(): Promise<HealthItem[]> {
  const runs = await recentOsRuns(25, { timeoutMs: 3000 });
  if (runs.ok && runs.data.length > 0) return runs.data.map(runToItem);
  // Offline-mock — the worked-example dbt freshness failure on mart_sales. Shown
  // only when demo fixtures are enabled (dev/test); a real deploy returns nothing
  // rather than a fake red alert no one can act on.
  return config.monitoringDemoFixtures ? [...MOCK_PIPELINES] : [];
}
