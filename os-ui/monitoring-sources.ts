/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Agents and Data tabs' scoped readers, handed to the Monitoring panels
 * USER STORY: As a user I want Monitoring to list exactly the agent systems and datasets the
 *             Agents and Data tabs show me — the same scoped lists, not a copy of their rules.
 * ARCHITECTURE:
 *   - Lives beside `instrumentation.ts` (like `opa-state-sources.ts`): the one place allowed to
 *     know every tab. `instrumentation.ts` registers it at boot into the port in
 *     tabs/monitoring/lib/panels/sources.ts.
 *   - Each reader is the owning tab's own function: `agentHealthRows`, `listDatasets`,
 *     `latestDqRuns`, `projectSnapshot` + `datasetAssetKeys`.
 */
import 'server-only';
import { registerMonitoringSources, type MonitoringSources } from '@tabs/monitoring/lib/panels/sources';
import { agentHealthRows, ensureHydrated as ensureAgentsHydrated } from '@tabs/agents/lib/store';
import { listAllDatasets, listDatasets, ensureHydrated as ensureDataHydrated } from '@tabs/data/lib/store';
import { listRepos } from '@core/infra/git-store';
import { scheduleNameFor, assetGraph, dagsterConfigured } from '@core/infra/dagster';
import { listWarehouseConnections, listLostCredentialConnections } from '@tabs/connections/lib/store';
import { managedTablesOf } from '@tabs/monitoring/lib/unregistered-tables-core';
import { footprint } from '@tabs/data/lib/physical-delete';
import { domainSchema } from '@tabs/data/lib/store-fqn';
import { latestDqRuns } from '@tabs/data/lib/dq-status-server';
import { projectSnapshot } from '@tabs/data/lib/dbt/snapshot';
import { datasetAssetKeys } from '@tabs/data/lib/dbt/asset-keys';
import { dataProjectGitEnabled } from '@tabs/data/lib/dbt/commit';
import { listFiles, getFile, ensureHydrated as ensureFilesHydrated } from '@tabs/files/lib/store';
import { listMetrics, ensureHydrated as ensureMetricsHydrated } from '@tabs/metrics/lib/store';
import { listAlertRules, alertStoreHydrationState, ensureHydrated as ensureAlertsHydrated } from '@tabs/metrics/lib/alert-store';
import { listDashboards, getDashboard, hydrationState as dashboardsHydrationState, ensureHydrated as ensureDashboardsHydrated } from '@tabs/dashboards/lib/store';
import { missingPanelMembers, panelRequestedMembers } from '@tabs/dashboards/lib/model';
import { panelViewsFor, type RegistryViewDims } from '@tabs/dashboards/lib/panel-views';
import { listGovernedDatasets } from '@tabs/data/lib/store';
import { viewName, registryDimensionMembers } from '@tabs/data/lib/metrics';
import { listSources, ensureSourcesHydrated as ensureDriveSourcesHydrated, sourcesHydrationState } from '@tabs/files/lib/connectors';
import { getConnectionById } from '@tabs/connections/lib/store';
import { listAppsForUser, serveModeOf } from '@tabs/software/lib/apps';
import { listReviewCards } from '@tabs/software/lib/review';
import { deployStatusOf } from '@tabs/software/lib/deploy-status';
import { runnerName } from '@tabs/software/lib/native-deploy';
import { listWorkflows, knowledgeHydrationComplete, ensureHydrated as ensureKnowledgeHydrated } from '@tabs/knowledge/lib/store';

export const monitoringSourcesImpl: MonitoringSources = {
  files: (p) => monitoringFilesSource(p),
  driveSources: (p) => monitoringDriveSource(p),
  software: (p) => monitoringSoftwareSource(p),
  knowledge: (p) => monitoringKnowledgeSource(p),
  metrics: (p) => monitoringMetricsSource(p),
  alertRules: (p) => monitoringAlertRulesSource(p),
  dashboards: (p) => monitoringDashboardsSource(p),
  async agentSystems(p) {
    await ensureAgentsHydrated();
    return agentHealthRows({ id: p.id, domains: p.domains, role: p.role as never }).map((r) => ({ id: r.id, name: r.name, scope: r.scope }));
  },
  async datasets(p) {
    await ensureDataHydrated();
    const g = listDatasets({ id: p.id, domains: p.domains, role: p.role as never });
    return [
      ...g.mine.map((d) => ({ id: d.id, name: d.name, domain: d.domain, scope: 'mine' as const })),
      ...g.domain.map((d) => ({ id: d.id, name: d.name, domain: d.domain, scope: 'domain' as const })),
      ...g.marketplace.map((d) => ({ id: d.id, name: d.name, domain: d.domain, scope: 'marketplace' as const })),
    ];
  },
  async latestTests(ds) {
    const m = await latestDqRuns(ds);
    return new Map(
      [...m].map(([id, r]) => [
        id,
        r ? { source: r.source === 'dagster' || r.source === 'os' ? r.source : null, ranAt: r.source === 'unavailable' ? null : r.ranAt, ...(r.unavailable ? { unavailable: r.unavailable } : {}), results: r.results.map((x) => ({ id: x.id, label: x.label, status: x.status, violations: x.violations, ...(x.severity ? { severity: x.severity } : {}), ...(x.at ? { at: x.at } : {}) })) } : null,
      ]),
    );
  },
  async syncSchedules() {
    await ensureDataHydrated();
    const domains = await listRepos().then((x) => x.map((y) => y.name)).catch(() => [] as string[]);
    return listAllDatasets().filter((d) => d.sync?.enabled && d.domain).map((d) => ({ schedule: scheduleNameFor(d.domain, d.id, domains), domain: d.domain, owner: d.owner, datasetId: d.id }));
  },
  async connectionCatalogs() {
    return (await listWarehouseConnections()).flatMap((c) => (c.warehouse ? [{ catalog: c.warehouse.catalog, connectionId: c.id, name: c.name, domain: c.domain }] : []));
  },
  lostCredentials: () => listLostCredentialConnections(),
  async registeredTables() {
    await ensureDataHydrated();
    const all = listAllDatasets({ includeArchived: true });
    const repos = await listRepos().then((x) => x.map((y) => y.name)).catch(() => [] as string[]);
    // The dbt models Dagster manages: their tables are the repository's, not shadow tables.
    let managedTables: string[] | null = [];
    if (dataProjectGitEnabled() && dagsterConfigured()) {
      const g = await assetGraph();
      managedTables = g.ok ? [...managedTablesOf(g.data.map((n) => n.key), domainSchema)] : null;
    }
    return {
      managedTables,
      // `iceberg.<schema>.<table>` -> `<schema>.<table>`
      fqns: all.flatMap((d) => footprint(d).map((c) => `${c.schema}.${c.table}`)),
      domainSchemas: [...new Set([...all.map((d) => d.domain), ...repos].filter(Boolean).map((d) => domainSchema(d)))],
    };
  },
  async assetKeys(ds) {
    const out = new Map<string, { tested: string[] | null; models: string[][] }>();
    if (!dataProjectGitEnabled()) return out;
    for (const domain of new Set(ds.map((d) => d.domain).filter(Boolean))) {
      const snap = await projectSnapshot(domain);
      for (const d of ds) {
        if (d.domain !== domain) continue;
        const k = datasetAssetKeys(snap, d.id);
        out.set(d.id, { tested: k.tested, models: k.models.map((m) => m.key) });
      }
    }
    return out;
  },
};

const asPrincipal = (p: { id: string; domains: string[]; role: string }) => ({ id: p.id, domains: p.domains, role: p.role as never });

export const monitoringFilesSource: NonNullable<MonitoringSources['files']> = async (p) => {
  await ensureFilesHydrated();
  const user = asPrincipal(p);
  const g = listFiles(user);
  const out: Awaited<ReturnType<NonNullable<MonitoringSources['files']>>> = [];
  for (const [scope, list] of [['mine', g.mine], ['domain', g.domain], ['marketplace', g.marketplace]] as const) {
    for (const f of list) {
      const a = getFile(f.id, user).asset;
      out.push({
        id: f.id, name: f.name, domain: f.domain, scope, kind: f.kind, bytes: f.bytes,
        mode: a.indexing.mode,
        extraction: a.indexing.extraction ? { status: a.indexing.extraction.status, code: a.indexing.extraction.code, reason: a.indexing.extraction.reason, at: a.indexing.extraction.at } : null,
        outcome: a.indexing.outcome ? { status: a.indexing.outcome.status, chunks: a.indexing.outcome.chunks, reason: a.indexing.outcome.reason, at: a.indexing.outcome.at } : null,
      });
    }
  }
  return out;
};

/** Connection health as the Connections store records it; anything else (gone, never tested) is `unknown`. */
export async function driveConnectionHealth(connectionId: string): Promise<'healthy' | 'needs-reconnect' | 'unknown'> {
  const c = await getConnectionById(connectionId);
  return c?.health === 'healthy' ? 'healthy' : c?.health === 'needs-reconnect' ? 'needs-reconnect' : 'unknown';
}

/** Every connected drive with its connection's health. The panel scopes it (the Files rule) — this reader
 *  never returns a list it could not load: an unloaded store throws, and the panel says "unavailable". */
export const monitoringDriveSource: NonNullable<MonitoringSources['driveSources']> = async () => {
  await ensureDriveSourcesHydrated();
  if (sourcesHydrationState() !== 'hydrated') throw new Error('the connected-drive store could not be loaded from OpenSearch');
  const out: Awaited<ReturnType<NonNullable<MonitoringSources['driveSources']>>> = [];
  for (const s of listSources()) {
    out.push({
      id: s.id, provider: s.provider, label: s.label, domain: s.domain, owner: s.owner, mode: s.mode,
      connectionId: s.connectionId,
      connectionHealth: s.connectionId ? await driveConnectionHealth(s.connectionId).catch(() => 'unknown' as const) : 'unknown',
      imported: Object.values(s.imported ?? {}).filter((e) => e.hash !== '').length,
      initialDone: s.initialDone, createdAt: s.createdAt, paused: s.paused ?? null, runs: s.runs ?? [],
    });
  }
  return out;
};

/** The viewer's apps (the Software tab's own list) with each app's newest review card and its scan as recorded. */
export const monitoringSoftwareSource: NonNullable<MonitoringSources['software']> = async (p) => {
  const apps = await listAppsForUser(asPrincipal(p) as never);
  const newest = new Map<string, Awaited<ReturnType<typeof listReviewCards>>[number]>();
  for (const c of await listReviewCards()) if (!newest.has(c.appId)) newest.set(c.appId, c); // already newest first
  const sev = (list: { severity: string }[], k: 'critical' | 'high' | 'medium' | 'low' | 'info') => list.filter((f) => f.severity === k).length;
  return apps.map((a) => {
    const mode = serveModeOf(a);
    const card = newest.get(a.id);
    return {
      id: a.id, slug: a.slug, name: a.name, domain: a.domain,
      scope: a.visibility === 'Personal' ? ('mine' as const) : a.visibility === 'Shared' ? ('domain' as const) : ('marketplace' as const),
      serveMode: mode,
      runner: mode === 'image' ? runnerName(a.slug) : null,
      status: (({ label, servedUrl }) => ({ label, servedUrl }))(deployStatusOf({ slug: a.slug, serveMode: mode, spec: a.spec, deploy: a.deploy })),
      // `App.checks` is the engine-neutral per-sha check record (PR #297); an app without the field has none.
      checks: (() => { const c = (a as unknown as { checks?: unknown }).checks; return Array.isArray(c) ? (c as NonNullable<import('@tabs/monitoring/lib/panels/sources').SoftwareRow['checks']>) : null; })(),
      review: card
        ? {
            requestedAt: card.requestedAt, decision: card.decision, decidedAt: card.decidedAt ?? null,
            scan: {
              mode: card.scan.mode, engine: card.scan.engine ?? null, passed: card.scan.passed, unavailable: card.scan.unavailable === true,
              reason: card.scan.reason ?? null, notRun: card.scan.notRun ?? [], truncated: card.scan.truncated === true, scannedAt: card.scan.scannedAt,
              byCategory: { ...card.scan.summary },
              bySeverity: { critical: sev(card.scan.findings, 'critical'), high: sev(card.scan.findings, 'high'), medium: sev(card.scan.findings, 'medium'), low: sev(card.scan.findings, 'low'), info: sev(card.scan.findings, 'info') },
            },
          }
        : null,
    };
  });
};

export const monitoringKnowledgeSource: NonNullable<MonitoringSources['knowledge']> = async (p) => {
  await ensureKnowledgeHydrated();
  if (!knowledgeHydrationComplete()) throw new Error('the workflows are not loaded — the store could not be read completely from OpenSearch');
  const g = listWorkflows(asPrincipal(p));
  return (['mine', 'domain', 'marketplace'] as const).flatMap((scope) =>
    g[scope].map((w) => ({ id: w.id, title: w.title, domain: w.domain, scope, status: w.status, updatedAt: w.updatedAt, publishedAt: w.publishedAt, certified: !!w.certifiedAt })),
  );
};

export const monitoringMetricsSource: NonNullable<MonitoringSources['metrics']> = async (p) => {
  await ensureMetricsHydrated();
  const g = listMetrics(asPrincipal(p));
  return (['mine', 'domain', 'marketplace'] as const).flatMap((scope) =>
    g[scope].map((m) => ({ id: m.id, name: m.name, member: m.member, datasetId: m.datasetId, datasetName: m.datasetName, domain: m.domain ?? '', scope, ...(m.error ? { error: m.error } : {}) })),
  );
};

/** The alert rules the viewer may see: creator own · builder / domain admin own + their domains · admin all. */
export const monitoringAlertRulesSource: NonNullable<MonitoringSources['alertRules']> = async (p) => {
  await ensureAlertsHydrated();
  if (alertStoreHydrationState() !== 'hydrated') throw new Error('the alert rules are not loaded — the store could not be read from OpenSearch');
  const wide = p.role === 'admin';
  const builder = p.role === 'builder' || p.role === 'domain_admin';
  return listAlertRules()
    .filter((r) => wide || r.owner === p.id || (builder && p.domains.includes(r.domain)))
    .map((r) => ({ id: r.id, member: r.member, comparator: r.comparator, threshold: r.threshold, owner: r.owner, domain: r.domain, lastEvaluated: r.lastEvaluated, lastBreached: r.lastBreached, lastValue: r.lastValue }));
};

export const monitoringDashboardsSource: NonNullable<MonitoringSources['dashboards']> = async (p) => {
  await ensureDashboardsHydrated();
  if (dashboardsHydrationState() !== 'hydrated') throw new Error('the dashboards are not loaded — the store could not be read from OpenSearch');
  await ensureMetricsHydrated();
  const user = asPrincipal(p);
  const g = listDashboards(user);
  const members = (() => {
    const m = listMetrics(user);
    return [...m.mine, ...m.domain, ...m.marketplace].map((x) => x.member);
  })();
  const registryDims: RegistryViewDims = new Map(listGovernedDatasets().map((d) => [viewName(d), registryDimensionMembers(d)]));
  const views = panelViewsFor(members, registryDims);
  const out: Awaited<ReturnType<NonNullable<MonitoringSources['dashboards']>>> = [];
  for (const [scope, list] of [['mine', g.mine], ['domain', g.domain], ['marketplace', g.marketplace]] as const) {
    for (const d of list) {
      const spec = getDashboard(d.id, user).spec;
      const v = views.find((x) => x.view === spec.view);
      const served = v ? { measures: v.measures, dimensions: v.dimensions, timeDimensions: v.timeDimensions } : { measures: [], dimensions: [], timeDimensions: [] };
      out.push({
        id: d.id, name: spec.name, domain: spec.domain ?? '', scope, view: spec.view, viewServed: !!v,
        panels: spec.charts.map((c) => ({ name: c.name, members: panelRequestedMembers(c), missing: missingPanelMembers(c, served) })),
      });
    }
  }
  return out;
};

export function registerMonitoringPanelSources(): void {
  registerMonitoringSources(monitoringSourcesImpl);
}
