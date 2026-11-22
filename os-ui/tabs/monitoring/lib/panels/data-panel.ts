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
 *     `dependedByKeys` from the dataset's own models — named only when the asset belongs to a dataset in
 *     the viewer's scope, otherwise counted per domain.
 *   - Not available upstream (said in the payload): freshness vs an SLA (no Dagster FreshnessPolicy
 *     is declared on OS assets), Trino query errors (no read path to `system.runtime.queries` yet),
 *     storage growth (kubelet_stats runs without the volume group).
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { recentOsRuns } from '@core/infra/dagster';
import { checkExecutions, dependedByGraph, downstreamOf, jobHealthOf, laneAlertsOf, visibleModels, type LaneAlert, type RunGroupHealth } from '@core/adapters/dagster/monitoring-read';
import { monitoringSources, SOURCES_MISSING, type MonitoringSources } from '@tabs/monitoring/lib/panels/sources';
import { failingSince, live, qualityTrend, ruleStatusOf, ruleTrend, ruleTypeOf, splitDownstream, unavailable, type NotUpstream, type RuleStatus, type RuleTrendPoint, type RuleType, type SourceState, type TrendPoint } from '@tabs/monitoring/lib/panels/panels-core';

/** Dagster reads per page are bounded: runs scanned, datasets given a trend. */
const RUN_SCAN = 200;
const TREND_DATASETS = 25;
const ALERT_SCAN = 1000;

/** An alert with the model names the viewer may see; `hidden` counts the ones withheld. */
export type LaneAlertView = { runId: string; models: string[]; hidden: number; principal: string; at: string | null; url?: string };

const RULE_EXECUTIONS = 10;

/** One dbt test of a dataset, as Dagster's asset check records it. */
export type RulePanel = {
  name: string;
  type: RuleType;
  status: RuleStatus;
  /** Rows dbt reported failing (`dagster_dbt/failed_row_count`); absent when dbt reported none. */
  failingRows?: number;
  severity?: 'warn' | 'error';
  lastRunAt?: string;
  runId?: string;
  /** Dagster's run page for the latest evaluation. */
  runUrl?: string;
  /** Start of the current failing streak; `failingSinceExact` is false when it began before the history read. */
  failingSince?: string;
  failingSinceExact?: boolean;
  trend?: RuleTrendPoint[];
  /** Status `unavailable`: why Dagster's executions for this rule could not be read. No live field is shown then. */
  unavailableReason?: string;
  /** Status `unavailable`: the last value the OS recorded, labelled with when — never shown as the current status. */
  lastRecorded?: { status: 'pass' | 'fail' | 'not_run'; failingRows?: number; at: string | null };
};

export type DatasetPanel = {
  id: string;
  name: string;
  domain: string;
  scope: 'mine' | 'domain' | 'marketplace';
  dataUrl: string;
  jobs?: (RunGroupHealth & { lastFailureUrl?: string })[];
  schedules?: RunGroupHealth[];
  /** Runs that selected a model outside their owner's lane (alert; the model names are the viewer's own domain's). */
  laneAlerts?: LaneAlertView[];
  /** Newest successful run end of any job of this dataset (Dagster), or null. */
  lastSuccessAt?: string | null;
  tests?: { source: 'dagster' | 'os' | null; ranAt: string | null; total: number; failing: { name: string; violations: number | null }[]; notRun: number };
  trend?: TrendPoint[];
  /** Per-rule results (Dagster asset checks of the dataset's tested asset). Absent until a dbt test has run in Dagster. */
  rules?: RulePanel[];
  /** Downstream assets of datasets the viewer can see, by name. */
  downstream?: { key: string; url?: string }[];
  /** Downstream assets the viewer cannot see: a count per domain only, never their names. */
  /** Downstream consumers outside the viewer's scope — an aggregate count only, no names. */
  downstreamHidden?: { count: number };
  testedAssetUrl?: string;
};

export type DataView = {
  view: 'data';
  generatedAt: string;
  sources: { inventory: SourceState; dagsterRuns: SourceState; tests: SourceState; lineage: SourceState };
  links: { dagster?: string };
  datasets: DatasetPanel[];
  /** Hand-launched runs (no dataset) of the viewer's domains that reached beyond their owner's lane. */
  laneAlerts: LaneAlertView[];

  /** Datasets whose per-rule results were not read because the per-response limit (`TREND_DATASETS`) was reached. */
  rulesDatasetsOmitted: number;
  notUpstream: NotUpstream[];
};

const NOT_UPSTREAM: NotUpstream[] = [
  { panel: 'Freshness vs SLA', reason: 'The generated Dagster definitions declare no FreshnessPolicy, so Dagster has no SLA to evaluate. Shown: the last successful run per job, not an SLA verdict.' },
  { panel: 'Trino query errors and slow queries', reason: 'Trino documents system.runtime.queries, but the OS has no governed read path to Trino’s system catalog yet, and per-user visibility needs Trino query rules. Not in this release.' },
  { panel: 'Failing row counts where dbt reports none', reason: 'A rule’s failing-row count is dagster-dbt’s failed_row_count metadata, which dbt’s run_results records for a failing test. Where dbt reported no count the rule shows its status without one — the OS never counts rows itself.' },
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
  // Alerts are scanned wider than the health rows (an older violation must not fall off the page).
  const alertRuns = ids.length || user.domains.length ? await recentOsRuns(ALERT_SCAN, { timeoutMs: 8000 }) : { ok: true as const, data: [] };
  const laneAlerts = alertRuns.ok ? laneAlertsOf(alertRuns.data, ids, user.domains) : new Map<string, LaneAlert[]>();

  // The dataset's own asset keys (the generated dbt project). Unreadable ⇒ lineage unavailable.
  const keys = await src.assetKeys(all.map(({ d }) => ({ id: d.id, domain: d.domain }))).then((m) => ({ ok: true as const, m }), (e: Error) => ({ ok: false as const, error: e.message }));
  const keysOf = keys.ok ? keys.m : new Map<string, { tested: string[] | null; models: string[][] }>();

  // The asset keys of every dataset in the viewer's scope — the only downstream names they may see.
  const visibleKeys = [...keysOf.values()].flatMap((k) => k.models);
  const visibleNames = new Set(visibleKeys.map((k) => k[k.length - 1]));
  const view = (a: LaneAlert): LaneAlertView => {
    const v = visibleModels(a, visibleNames);
    return { runId: a.runId, models: v.models, hidden: v.hidden, principal: a.principal, at: a.at, ...(dagsterUi ? { url: `${dagsterUi}/runs/${encodeURIComponent(a.runId)}` } : {}) };
  };

  const datasets: DatasetPanel[] = [];
  let trends = 0;
  let omitted = 0;
  let rulesUnreadable = 0;
  let rulesAsked = 0;
  let firstUnreadable: string | null = null;
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
    if (laneAlerts.has(d.id)) p.laneAlerts = laneAlerts.get(d.id)!.map(view);
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
      if (rec?.source === 'dagster' && trends >= TREND_DATASETS && rec.results.length) omitted += 1;
      if (rec?.source === 'dagster' && trends < TREND_DATASETS && rec.results.length) {
        trends += 1;
        const ex = await Promise.all(rec.results.map((r) => checkExecutions(dk.tested!, r.id, RULE_EXECUTIONS, { timeoutMs: 4000 })));
        // A trend built from the executions that happened to answer would pass for the whole: shown only when all did.
        if (ex.every((e) => e.ok)) p.trend = qualityTrend(ex.flatMap((e) => (e.ok ? e.value : [])));
        rulesAsked += ex.length;
        // Per rule: the same executions, kept apart. Over the cap a rule keeps its latest status only.
        p.rules = rec.results.map((r, i) => {
          const e = ex[i];
          const hist = e.ok ? e.value : null;
          const latest = hist?.[0];
          if (!e.ok) {
            // Dagster could not be asked: the rule is unavailable. The recorded value is kept only as a labelled last-known one.
            rulesUnreadable += 1;
            firstUnreadable ??= e.detail;
            const recorded: 'pass' | 'fail' | 'not_run' = r.status === 'pass' ? 'pass' : r.status === 'fail' ? 'fail' : 'not_run';
            return {
              name: r.label,
              type: ruleTypeOf(r.id),
              status: 'unavailable' as const,
              unavailableReason: `Dagster: ${e.detail}`,
              lastRecorded: { status: recorded, ...(recorded === 'fail' && r.violations !== null ? { failingRows: r.violations } : {}), at: rec.ranAt },
            };
          }
          const status: RuleStatus = latest ? ruleStatusOf(latest) : r.status === 'pass' ? 'pass' : r.status === 'fail' ? 'fail' : 'not_run';
          const since = hist ? failingSince(hist, RULE_EXECUTIONS) : null;
          return {
            name: r.label,
            type: ruleTypeOf(r.id),
            status,
            ...(latest?.failedRows !== null && latest?.failedRows !== undefined && (status === 'fail' || status === 'warn') ? { failingRows: latest.failedRows } : status === 'fail' && r.violations !== null ? { failingRows: r.violations } : {}),
            ...(latest?.severity ? { severity: latest.severity === 'WARN' ? 'warn' as const : 'error' as const } : {}),
            ...(latest ? { lastRunAt: latest.at, runId: latest.runId, ...(dagsterUi && latest.runId ? { runUrl: `${dagsterUi}/runs/${encodeURIComponent(latest.runId)}` } : {}) } : {}),
            ...(since?.since ? { failingSince: since.since, failingSinceExact: since.exact } : {}),
            ...(hist ? { trend: ruleTrend(hist, RULE_EXECUTIONS) } : {}),
          };
        });
      }
    }
    if (graph.ok && dk) {
      const split = splitDownstream(downstreamOf(graph.value, dk.models), visibleKeys);
      p.downstream = split.visible.map((k) => ({ key: k.join('/'), url: assetUrl(k) }));
      if (split.hiddenCount) p.downstreamHidden = { count: split.hiddenCount };
    }
    datasets.push(p);
  }

  return {
    view: 'data',
    generatedAt: new Date(nowMs).toISOString(),
    sources: {
      inventory: listed.ok ? live : unavailable(`datasets: ${listed.error}`),
      dagsterRuns: runs.ok ? live : unavailable(`Dagster: ${runs.error}`),
      tests: !dq.ok ? unavailable(`quality: ${dq.error}`) : rulesUnreadable ? unavailable(`Dagster asset checks: ${rulesUnreadable} of ${rulesAsked} rules could not be read (${firstUnreadable}); their rows show unavailable with the last recorded value and its time`) : live,
      lineage: !graph.ok ? unavailable(`Dagster: ${graph.detail}`) : !keys.ok ? unavailable(`dbt project: ${keys.error}`) : live,
    },
    links: dagsterUi ? { dagster: dagsterUi } : {},
    datasets,
    laneAlerts: [...laneAlerts].filter(([k]) => k.startsWith('domain:')).flatMap(([, v]) => v.map(view)),

    rulesDatasetsOmitted: omitted,
    notUpstream: NOT_UPSTREAM,
  };
}
