/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Data panels — per dataset: Dagster run health and last success per job
 *             and schedule, dbt test / source-test results with the failing ones listed, the
 *             quality trend, and what is impacted downstream
 * USER STORY: As a data engineer I want to see, for my datasets, which job or schedule failed, when
 *             each last succeeded, which tests fail, whether quality is getting better or worse and
 *             which assets downstream are affected — as Dagster records it.
 * ARCHITECTURE:
 *   - Server-only, READ-ONLY. Datasets = the Data store's own scoped list (`listDatasets`).
 *     Dagster runs are kept only for those ids (`jobHealthOf` by the run's `os/dataset` tag);
 *     tests are the Data tab's `latestDqRuns` (Dagster asset checks — dagster-dbt maps each dbt test
 *     and source test to one — with the labelled OS fallback); the trend is
 *     `assetCheckExecutions` of the dataset's tested asset; downstream is the closure of Dagster's
 *     `dependedByKeys` from the dataset's own models.
 *   - Not available upstream (said in the payload): freshness vs an SLA (no Dagster FreshnessPolicy
 *     is declared on OS assets), Trino query errors (no read path to `system.runtime.queries` yet),
 *     storage growth (kubelet_stats runs without the volume group).
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { recentOsRuns } from '@core/infra/dagster';
import { checkExecutions, dependedByGraph, downstreamOf, jobHealthOf, type RunGroupHealth } from '@core/adapters/dagster/monitoring-read';
import { listDatasets, ensureHydrated } from '@tabs/data/lib/store';
import { latestDqRuns } from '@tabs/data/lib/dq-status-server';
import { projectSnapshot } from '@tabs/data/lib/dbt/snapshot';
import { datasetAssetKeys } from '@tabs/data/lib/dbt/asset-keys';
import { dataProjectGitEnabled } from '@tabs/data/lib/dbt/commit';
import { live, qualityTrend, unavailable, type NotUpstream, type SourceState, type TrendPoint } from '@tabs/monitoring/lib/panels/panels-core';

/** Dagster reads per page are bounded: runs scanned, datasets given a trend. */
const RUN_SCAN = 200;
const TREND_DATASETS = 25;

export type DatasetPanel = {
  id: string;
  name: string;
  domain: string;
  scope: 'mine' | 'domain' | 'marketplace';
  dataUrl: string;
  jobs?: (RunGroupHealth & { lastFailureUrl?: string })[];
  schedules?: RunGroupHealth[];
  /** Newest successful run end of any job of this dataset (Dagster), or null. */
  lastSuccessAt?: string | null;
  tests?: { source: 'dagster' | 'os' | null; ranAt: string | null; total: number; failing: { name: string; violations: number | null }[]; notRun: number };
  trend?: TrendPoint[];
  downstream?: { key: string; url?: string }[];
  testedAssetUrl?: string;
};

export type DataView = {
  view: 'data';
  generatedAt: string;
  sources: { dagsterRuns: SourceState; tests: SourceState; lineage: SourceState };
  links: { dagster?: string };
  datasets: DatasetPanel[];
  notUpstream: NotUpstream[];
};

const NOT_UPSTREAM: NotUpstream[] = [
  { panel: 'Freshness vs SLA', reason: 'The generated Dagster definitions declare no FreshnessPolicy, so Dagster has no SLA to evaluate. Shown: the last successful run per job, not an SLA verdict.' },
  { panel: 'Trino query errors and slow queries', reason: 'Trino documents system.runtime.queries, but the OS has no governed read path to Trino’s system catalog yet, and per-user visibility needs Trino query rules. Not in this release.' },
  { panel: 'Storage growth', reason: 'The Collector’s kubelet_stats receiver runs without the volume metric group, and per-table Iceberg $snapshots summaries would need one Trino query per table. Not in this release.' },
];

export async function dataView(user: CurrentUser, nowMs = Date.now()): Promise<DataView> {
  await ensureHydrated();
  const groups = listDatasets({ id: user.id, domains: user.domains, role: user.role });
  const all = [
    ...groups.mine.map((d) => ({ d, scope: 'mine' as const })),
    ...groups.domain.map((d) => ({ d, scope: 'domain' as const })),
    ...groups.marketplace.map((d) => ({ d, scope: 'marketplace' as const })),
  ];
  const ids = all.map((x) => x.d.id);
  const dagsterUi = config.dagsterConsoleUrl || '';
  const assetUrl = (key: string[]) => (dagsterUi ? `${dagsterUi}/assets/${key.map(encodeURIComponent).join('/')}` : undefined);

  const [runs, dq, graph] = await Promise.all([
    ids.length ? recentOsRuns(RUN_SCAN, { timeoutMs: 5000 }) : Promise.resolve({ ok: true as const, data: [] }),
    latestDqRuns(all.map(({ d }) => ({ id: d.id, domain: d.domain }))).then((m) => ({ ok: true as const, m }), (e: Error) => ({ ok: false as const, error: e.message })),
    dependedByGraph({ timeoutMs: 5000 }),
  ]);
  const health = runs.ok ? jobHealthOf(runs.data, ids) : null;

  // The dataset's own asset keys (the generated dbt project), once per domain.
  const keysOf = new Map<string, ReturnType<typeof datasetAssetKeys>>();
  if (dataProjectGitEnabled()) {
    for (const domain of new Set(all.map(({ d }) => d.domain).filter(Boolean))) {
      const snap = await projectSnapshot(domain).catch(() => null);
      if (!snap) continue;
      for (const { d } of all) if (d.domain === domain) keysOf.set(d.id, datasetAssetKeys(snap, d.id));
    }
  }

  const datasets: DatasetPanel[] = [];
  let trends = 0;
  for (const { d, scope } of all) {
    const h = health?.get(d.id);
    const rec = dq.ok ? dq.m.get(d.id) ?? null : null;
    const keys = keysOf.get(d.id);
    const p: DatasetPanel = { id: d.id, name: d.name, domain: d.domain, scope, dataUrl: `/data?focus=${encodeURIComponent(d.id)}` };
    if (health) {
      p.jobs = (h?.jobs ?? []).map((j) => ({ ...j, ...(j.lastFailureRunId && dagsterUi ? { lastFailureUrl: `${dagsterUi}/runs/${encodeURIComponent(j.lastFailureRunId)}` } : {}) }));
      p.schedules = h?.schedules ?? [];
      p.lastSuccessAt = (h?.jobs ?? []).map((j) => j.lastSuccessAt).filter((x): x is string => !!x).sort().at(-1) ?? null;
    }
    if (dq.ok) {
      const results = rec?.results ?? [];
      p.tests = {
        source: rec?.source === 'dagster' || rec?.source === 'os' ? rec.source : null,
        ranAt: rec?.ranAt ?? null,
        total: results.length,
        failing: results.filter((r) => r.status === 'fail').map((r) => ({ name: r.label, violations: r.violations })),
        notRun: results.filter((r) => r.status === 'not_run').length,
      };
    }
    if (keys?.tested) {
      p.testedAssetUrl = assetUrl(keys.tested);
      if (rec?.source === 'dagster' && trends < TREND_DATASETS && rec.results.length) {
        trends += 1;
        const ex = await Promise.all(rec.results.map((r) => checkExecutions(keys.tested!, r.id, 10, { timeoutMs: 4000 })));
        p.trend = qualityTrend(ex.flatMap((e) => (e.ok ? e.data : [])));
      }
    }
    if (graph.ok && keys) {
      p.downstream = downstreamOf(graph.data, keys.models.map((m) => m.key)).map((k) => ({ key: k.join('/'), url: assetUrl(k) }));
    }
    datasets.push(p);
  }

  return {
    view: 'data',
    generatedAt: new Date(nowMs).toISOString(),
    sources: {
      dagsterRuns: runs.ok ? live : unavailable(`Dagster: ${runs.error}`),
      tests: dq.ok ? live : unavailable(`quality: ${dq.error}`),
      lineage: graph.ok ? live : unavailable(`Dagster: ${graph.error}`),
    },
    links: dagsterUi ? { dagster: dagsterUi } : {},
    datasets,
    notUpstream: NOT_UPSTREAM,
  };
}
