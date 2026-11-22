/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Platform panels (admin only) — component health from each component's
 *             own probe, resource pressure from VictoriaMetrics, error-log rate from VictoriaLogs,
 *             backup status and the operational alerts firing now
 * USER STORY: As an operator I want one screen that tells me which component is down, which node or
 *             pod is under memory/CPU/disk pressure, where errors are being logged and whether the
 *             backups ran — read live from the components themselves.
 * ARCHITECTURE:
 *   - Server-only, READ-ONLY, ADMIN ONLY (tenant/cluster signals — the `cluster: true` rule):
 *     a non-admin gets a 403 before anything is read.
 *   - COMPONENT_HEALTH (core/adapters/health) — every component's own health()/version endpoint.
 *   - VictoriaMetrics PromQL and VictoriaLogs LogsQL: the exact queries in panels-core.ts.
 *   - Backups and alerts: the existing WP-56 / WP-05 readers and the overview's operational alerts.
 *   - Alert firing HISTORY is not available upstream: no Alertmanager or vmalert is deployed.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { COMPONENT_HEALTH } from '@core/adapters/health/index';
import { promInstant } from '@core/adapters/victoria-metrics/query';
import { logsQuery } from '@core/adapters/victoria-logs/query';
import { scopeForUser } from '@tabs/monitoring/lib/scope';
import { buildOverview } from '@tabs/monitoring/lib/aggregate';
import { domainsMissingOwnedFiles } from '@core/infra/owned-files';
import { readTrinoCatalogs } from '@core/adapters/trino/catalogs';
import { queryRun } from '@core/infra/governed';
import { routeFor } from '@core/infra/trino-source';
import { monitoringSources } from '@tabs/monitoring/lib/panels/sources';
import { dataSourceRows, type DataSourceRow } from '@tabs/monitoring/lib/data-sources-core';
import { readIcebergTables } from '@core/adapters/trino/tables';
import { unregisteredTableAlerts } from '@tabs/monitoring/lib/unregistered-tables-core';
import { collectBackups } from '@tabs/monitoring/lib/adapters/backup-health';
import type { Alert, HealthItem } from '@tabs/monitoring/lib/types';
import { ERROR_LOG_QUERY, PROMQL, errorLogRows, live, nodePressure, podUse, unavailable, type ErrorLogRow, type NodePressure, type NotUpstream, type PodUse, type SourceState } from '@tabs/monitoring/lib/panels/panels-core';

export type ComponentProbe = { id: string; status: 'ready' | 'degraded' | 'down'; version: string | null; detail: string; at: string };

/** Domains whose repo lacks os/owned-files.yml: the receive gate fails closed for models/ and tests/ there. */
export type RepoGate = { state: SourceState; missing: string[] };

export type PlatformView = {
  view: 'platform';
  generatedAt: string;
  components: ComponentProbe[];
  pressure: { state: SourceState; nodes: NodePressure[]; topMemory: PodUse[]; topCpu: PodUse[]; queries: typeof PROMQL };
  errorLogs: { state: SourceState; rows: ErrorLogRow[]; query: string };
  backups: { state: SourceState; items: HealthItem[] };
  alerts: { state: SourceState; items: Alert[] };
  repoGate: RepoGate;
  /** The catalogs Trino serves (Trino and the chart own them) and the OS connection using each. */
  dataSources: { state: SourceState; rows: DataSourceRow[]; alerts: Alert[] };
  /** Tables created directly in Trino that no dataset registers (Trino owns them; the OS reports them). */
  unregisteredTables: { state: SourceState; alerts: Alert[] };
  notUpstream: NotUpstream[];
};

const NOT_UPSTREAM: NotUpstream[] = [
  { panel: 'Alert firing history', reason: 'No Alertmanager or vmalert is deployed; operational alerts are derived when the page is read, so only the alerts firing now are shown.' },
];

export class PlatformForbiddenError extends Error {
  readonly status = 403;
  constructor() {
    super('Platform monitoring is admin-only');
  }
}

export async function platformView(user: CurrentUser, nowMs = Date.now()): Promise<PlatformView> {
  const scope = await scopeForUser(user);
  if (scope.level !== 'admin') throw new PlatformForbiddenError();

  const probes = Promise.all(
    Object.entries(COMPONENT_HEALTH).map(async ([id, fn]): Promise<ComponentProbe> => {
      const r = await fn().catch((e: Error) => ({ ok: false as const, reason: 'unreachable' as const, detail: e.message, at: new Date().toISOString() }));
      return r.ok
        ? { id, status: r.value.status, version: r.value.version, detail: r.value.detail ?? '', at: r.at }
        : { id, status: 'down', version: null, detail: `${r.reason}: ${r.detail}`, at: r.at };
    }),
  );
  const [components, mem, disk, topMem, topCpu, logs, backups, overview] = await Promise.all([
    probes,
    promInstant(PROMQL.nodeMemory),
    promInstant(PROMQL.nodeDisk),
    promInstant(PROMQL.topPodMemory),
    promInstant(PROMQL.topPodCpu),
    logsQuery(ERROR_LOG_QUERY),
    collectBackups(new Date(nowMs)).then((items) => ({ ok: true as const, items }), (e: Error) => ({ ok: false as const, error: e.message })),
    buildOverview(user).then((ov) => ({ ok: true as const, alerts: ov.alerts }), (e: Error) => ({ ok: false as const, error: e.message })),
  ]);
  const unregistered = await readUnregistered(user);
  const repoGate: RepoGate = await domainsMissingOwnedFiles().then((missing) => ({ state: live, missing }), (e: Error) => ({ state: unavailable(`git store: ${e.message}`), missing: [] }));
  const catalogs = await readTrinoCatalogs((sql) => queryRun(sql, user.id, routeFor(user, 'monitoring')));
  let conns: Awaited<ReturnType<NonNullable<ReturnType<typeof monitoringSources>>['connectionCatalogs']>> | null = null;
  let connsError = 'the Connections reader is not registered';
  try {
    const src = monitoringSources();
    if (src) conns = await src.connectionCatalogs();
  } catch (e) {
    connsError = e instanceof Error ? e.message : String(e);
  }
  const ds = catalogs.ok ? dataSourceRows(catalogs.value, conns ?? []) : { rows: [], alerts: [] as Alert[] };
  const vmFail = [mem, disk, topMem, topCpu].find((r) => !r.ok);
  return {
    view: 'platform',
    generatedAt: new Date(nowMs).toISOString(),
    components: components.sort((a, b) => a.id.localeCompare(b.id)),
    pressure: {
      state: vmFail && !vmFail.ok ? unavailable(`VictoriaMetrics: ${vmFail.detail}`) : live,
      nodes: mem.ok && disk.ok ? nodePressure(mem.value, disk.value) : [],
      topMemory: topMem.ok ? podUse(topMem.value) : [],
      topCpu: topCpu.ok ? podUse(topCpu.value) : [],
      queries: PROMQL,
    },
    errorLogs: { state: logs.ok ? live : unavailable(`VictoriaLogs: ${logs.detail}`), rows: logs.ok ? errorLogRows(logs.value) : [], query: ERROR_LOG_QUERY },
    backups: { state: backups.ok ? live : unavailable(`backups: ${backups.error}`), items: backups.ok ? backups.items : [] },
    alerts: { state: overview.ok ? live : unavailable(`alerts: ${overview.error}`), items: overview.ok ? overview.alerts : [] },
    repoGate,
    dataSources: {
      state: !catalogs.ok ? unavailable(`Trino: ${catalogs.detail}`) : conns === null ? unavailable(`connections cannot be matched to catalogs: ${connsError}`) : live,
      ...ds,
    },
    unregisteredTables: unregistered,
    notUpstream: NOT_UPSTREAM,
  };
}

async function readUnregistered(user: CurrentUser): Promise<{ state: SourceState; alerts: Alert[] }> {
  const src = monitoringSources();
  if (!src) return { state: unavailable('the Data reader is not registered: registered tables are unknown'), alerts: [] };
  const physical = await readIcebergTables((sql) => queryRun(sql, user.id, routeFor(user, 'monitoring')));
  if (!physical.ok) return { state: unavailable(`Trino: ${physical.detail}`), alerts: [] };
  try {
    const reg = await src.registeredTables();
    return { state: live, alerts: unregisteredTableAlerts(physical.value, new Set(reg.fqns), { domainSchemas: reg.domainSchemas, personalSchemaPrefix: 'personal_' }) };
  } catch (e) {
    return { state: unavailable(`registered tables: ${e instanceof Error ? e.message : String(e)}`), alerts: [] };
  }
}
