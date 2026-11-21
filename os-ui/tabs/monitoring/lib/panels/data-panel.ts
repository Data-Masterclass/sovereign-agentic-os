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
 *   - Server-only, READ-ONLY. Datasets = the Data store's own scoped list (`listDatasets`, injected
 *     through `sources.ts` with the Data tab's quality and asset-key readers).
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
import { monitoringSources, SOURCES_MISSING, type MonitoringSources } from '@tabs/monitoring/lib/panels/sources';
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
  sources: { inventory: SourceState; dagsterRuns: SourceState; tests: SourceState; lineage: SourceState };
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
  const registered = monitoringSources();
  const listed = registered
    ? await registered.datasets({ id: user.id, domains: user.domains, role: user.role }).then((rows) => ({ ok: true as const, rows }), (e: Error) => ({ ok: false as const, error: e.message }))
    : { ok: false as const, error: SOURCES_MISSING };
  const all = (listed.ok ? listed.rows : []).map((d) => ({ d, scope: d.scope }));
  const src: Pick<MonitoringSources, 'latestTests' | 'assetKeys'> = registered ?? { latestTests: async () => new Map(), assetKeys: async () => new Map() };
  const ids = all.map((x) => x.d.id);
  const dagsterUi = config.dagsterConsoleUrl || '';
  const assetUrl = (key: string[]) => (dagsterUi ? `${dagsterUi}/assets/${key.map(encodeURIComponent).join('/')}` : undefined);

  const [runs, dq, graph] = await Promise.all([
    ids.length ? recentOsRuns(RUN_SCAN, { timeoutMs: 5000 }) : Promise.resolve({ ok: true as const, data: [] }),
    src.latestTests(all.map(({ d }) => ({ id: d.id, domain: d.domain }))).then((m) => ({ ok: true as const, m }), (e: Error) => ({ ok: false as const, error: e.message })),
    dependedByGraph({ timeoutMs: 5000 }),
  ]);
  const health = runs.ok ? jobHealthOf(runs.data, ids) : null;

  // The dataset's own asset keys (the generated dbt project). Unreadable ⇒ lineage unavailable.
  const keys = await src.assetKeys(all.map(({ d }) => ({ id: d.id, domain: d.domain }))).then((m) => ({ ok: true as const, m }), (e: Error) => ({ ok: false as const, error: e.message }));
  const keysOf = keys.ok ? keys.m : new Map<string, { tested: string[] | null; models: string[][] }>();

  const datasets: DatasetPanel[] = [];
  let trends = 0;
  for (const { d, scope } of all) {
    const h = health?.get(d.id);
    const rec = dq.ok ? dq.m.get(d.id) ?? null : null;
    const dk = keysOf.get(d.id);
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
    if (dk?.tested) {
      p.testedAssetUrl = assetUrl(dk.tested);
      if (rec?.source === 'dagster' && trends < TREND_DATASETS && rec.results.length) {
        trends += 1;
        const ex = await Promise.all(rec.results.map((r) => checkExecutions(dk.tested!, r.id, 10, { timeoutMs: 4000 })));
        p.trend = qualityTrend(ex.flatMap((e) => (e.ok ? e.value : [])));
      }
    }
    if (graph.ok && dk) {
      p.downstream = downstreamOf(graph.value, dk.models).map((k) => ({ key: k.join('/'), url: assetUrl(k) }));
    }
    datasets.push(p);
  }

  return {
    view: 'data',
    generatedAt: new Date(nowMs).toISOString(),
    sources: {
      inventory: listed.ok ? live : unavailable(`datasets: ${listed.error}`),
      dagsterRuns: runs.ok ? live : unavailable(`Dagster: ${runs.error}`),
      tests: dq.ok ? live : unavailable(`quality: ${dq.error}`),
      lineage: !graph.ok ? unavailable(`Dagster: ${graph.detail}`) : !keys.ok ? unavailable(`dbt project: ${keys.error}`) : live,
    },
    links: dagsterUi ? { dagster: dagsterUi } : {},
    datasets,
    notUpstream: NOT_UPSTREAM,
  };
}
