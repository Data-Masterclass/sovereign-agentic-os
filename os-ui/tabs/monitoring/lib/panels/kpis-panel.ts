/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → KPIs panels — per governed metric: load errors, freshness of its dataset, and the
 *             alerts on it (firing now, last evaluation, evaluation failures)
 * USER STORY: As a KPI owner I want to know which of my metrics cannot be read, whether the data under them is
 *             fresh, and which alerts are firing or failing to evaluate.
 * ARCHITECTURE:
 *   - Server-only, READ-ONLY. Metrics = the Metrics tab's own scoped list; alert rules = the stored rules the
 *     viewer may see (creator own · builder own + domain · admin all). Both injected through `sources.ts`.
 *   - Freshness = Dagster runs of the metric's dataset (`jobHealthOf`, tag `os/dataset`): the newest successful run.
 *     No FreshnessPolicy exists upstream, so no SLA verdict is claimed.
 *   - Alert evaluation = Dagster runs tagged `os/alert=<rule id>` (MetricFlow runs as a Dagster job); a failed run is
 *     the real metric query error. "Firing" = the rule's last stored evaluation breached (written from that result).
 *   - A load error is the metric registry's own fail-soft reason for one metric (it could not read its dbt model).
 *   - Not available upstream (said in the payload): query errors of ad-hoc metric queries, SLA freshness.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { recentOsRuns } from '@core/infra/dagster';
import { alertRunHealthOf, jobHealthOf, type AlertRunHealth } from '@core/adapters/dagster/monitoring-read';
import { monitoringSources, SOURCES_MISSING, type AlertRuleRow, type MetricRow } from '@tabs/monitoring/lib/panels/sources';
import { live, unavailable, type NotUpstream, type SourceState } from '@tabs/monitoring/lib/panels/panels-core';

const RUN_SCAN = 300;

export type KpiAlertPanel = {
  id: string;
  member: string;
  condition: string;
  owner: string;
  domain: string;
  firing: boolean;
  /** Absent until the rule was evaluated once. */
  lastEvaluated?: string;
  lastValue?: number;
  /** Dagster evaluation runs; absent when Dagster did not answer. */
  evaluations?: Omit<AlertRunHealth, 'ruleId'> & { lastFailureUrl?: string };
};

export type KpiPanel = {
  id: string;
  name: string;
  datasetName: string;
  domain: string;
  scope: 'mine' | 'domain' | 'marketplace';
  kpisUrl: string;
  loadError?: string;
  /** Newest successful Dagster run of the metric's dataset: ISO, null = none in the run window; absent when Dagster did not answer. */
  dataLastSuccessAt?: string | null;
  alertsFiring: number;
};

export type KpisView = {
  view: 'kpis';
  generatedAt: string;
  sources: { inventory: SourceState; alerts: SourceState; dagster: SourceState };
  summary: { metrics: number; loadErrors: number; alertsFiring: number; alertsFailing: number } | null;
  metrics: KpiPanel[];
  alerts: KpiAlertPanel[];
  notUpstream: NotUpstream[];
};

const NOT_UPSTREAM: NotUpstream[] = [
  { panel: 'Metric query errors', reason: 'A metric read through the explorer or a dashboard leaves no error record upstream (Trino’s system.runtime.queries has no governed read path yet). Only committed alerts are evaluated as Dagster runs, so only their failures are shown.' },
  { panel: 'Freshness vs SLA', reason: 'The generated Dagster definitions declare no FreshnessPolicy. Shown: the last successful run of the dataset under the metric, not an SLA verdict.' },
];

function evaluationsOf(e: AlertRunHealth | undefined, dagsterUi: string): NonNullable<KpiAlertPanel['evaluations']> {
  if (!e) return { runs: 0, failures: 0, lastStatus: 'none', lastRunAt: null, lastFailureRunId: null };
  const { ruleId: _id, ...rest } = e;
  void _id;
  return { ...rest, ...(e.lastFailureRunId && dagsterUi ? { lastFailureUrl: `${dagsterUi}/runs/${encodeURIComponent(e.lastFailureRunId)}` } : {}) };
}

const SYMBOL: Record<string, string> = { lt: '<', lte: '≤', gt: '>', gte: '≥' };

export async function kpisView(user: CurrentUser, nowMs = Date.now()): Promise<KpisView> {
  const src = monitoringSources();
  const p = { id: user.id, domains: user.domains, role: user.role };
  const missing = (what: string) => (src ? `the ${what} reader is not registered in this process (monitoring-sources.ts at boot)` : SOURCES_MISSING);
  const [metricsR, alertsR] = await Promise.all([
    src?.metrics ? src.metrics(p).then((rows) => ({ ok: true as const, rows }), (e: Error) => ({ ok: false as const, error: e.message })) : Promise.resolve({ ok: false as const, error: missing('Metrics') }),
    src?.alertRules ? src.alertRules(p).then((rows) => ({ ok: true as const, rows }), (e: Error) => ({ ok: false as const, error: e.message })) : Promise.resolve({ ok: false as const, error: missing('alert rules') }),
  ]);
  const metrics: MetricRow[] = metricsR.ok ? metricsR.rows : [];
  const rules: AlertRuleRow[] = alertsR.ok ? alertsR.rows : [];
  const runs = metrics.length || rules.length ? await recentOsRuns(RUN_SCAN, { timeoutMs: 5000 }) : ({ ok: true as const, data: [] });
  const dagsterUi = config.dagsterConsoleUrl || '';
  const datasetIds = [...new Set(metrics.map((m) => m.datasetId))];
  const health = runs.ok ? jobHealthOf(runs.data, datasetIds) : null;
  const evals = runs.ok ? alertRunHealthOf(runs.data, rules.map((r) => r.id)) : null;

  const firingMembers = new Map<string, number>();
  for (const r of rules) if (r.lastBreached === true) firingMembers.set(r.member, (firingMembers.get(r.member) ?? 0) + 1);

  const panels: KpiPanel[] = metrics.map((m) => ({
    id: m.id, name: m.name, datasetName: m.datasetName, domain: m.domain, scope: m.scope,
    kpisUrl: `/metrics?focus=${encodeURIComponent(m.id)}`,
    ...(m.error ? { loadError: m.error } : {}),
    ...(health ? { dataLastSuccessAt: (health.get(m.datasetId)?.jobs ?? []).map((j) => j.lastSuccessAt).filter((x): x is string => !!x).sort().at(-1) ?? null } : {}),
    alertsFiring: firingMembers.get(m.member) ?? 0,
  }));
  panels.sort((a, b) => (b.loadError ? 4 : 0) + b.alertsFiring * 2 - ((a.loadError ? 4 : 0) + a.alertsFiring * 2) || a.name.localeCompare(b.name));

  const alerts: KpiAlertPanel[] = rules.map((r) => {
    const e = evals?.get(r.id);
    return {
      id: r.id, member: r.member, condition: `${SYMBOL[r.comparator] ?? r.comparator} ${r.threshold}`, owner: r.owner, domain: r.domain,
      firing: r.lastBreached === true,
      ...(r.lastEvaluated ? { lastEvaluated: r.lastEvaluated } : {}),
      ...(typeof r.lastValue === 'number' ? { lastValue: r.lastValue } : {}),
      ...(evals ? { evaluations: evaluationsOf(e, dagsterUi) } : {}),
    };
  });
  alerts.sort((a, b) => Number(b.firing) - Number(a.firing) || (b.evaluations?.failures ? 1 : 0) - (a.evaluations?.failures ? 1 : 0));

  return {
    view: 'kpis',
    generatedAt: new Date(nowMs).toISOString(),
    sources: {
      inventory: metricsR.ok ? live : unavailable(`metrics: ${metricsR.error}`),
      alerts: alertsR.ok ? live : unavailable(`alert rules: ${alertsR.error}`),
      dagster: runs.ok ? live : unavailable(`Dagster: ${runs.error}`),
    },
    summary: metricsR.ok && alertsR.ok ? { metrics: panels.length, loadErrors: panels.filter((m) => m.loadError).length, alertsFiring: alerts.filter((a) => a.firing).length, alertsFailing: alerts.filter((a) => (a.evaluations?.lastStatus === 'FAILURE')).length } : null,
    metrics: panels,
    alerts,
    notUpstream: NOT_UPSTREAM,
  };
}
