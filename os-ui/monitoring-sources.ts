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
import { listDatasets, ensureHydrated as ensureDataHydrated } from '@tabs/data/lib/store';
import { latestDqRuns } from '@tabs/data/lib/dq-status-server';
import { projectSnapshot } from '@tabs/data/lib/dbt/snapshot';
import { datasetAssetKeys } from '@tabs/data/lib/dbt/asset-keys';
import { dataProjectGitEnabled } from '@tabs/data/lib/dbt/commit';
import { listFiles, getFile, ensureHydrated as ensureFilesHydrated } from '@tabs/files/lib/store';
import { listAppsForUser, serveModeOf } from '@tabs/software/lib/apps';
import { listReviewCards } from '@tabs/software/lib/review';
import { deployStatusOf } from '@tabs/software/lib/deploy-status';
import { runnerName } from '@tabs/software/lib/native-deploy';
import { listMetrics, ensureHydrated as ensureMetricsHydrated } from '@tabs/metrics/lib/store';
import { listAlertRules, ensureHydrated as ensureAlertsHydrated } from '@tabs/metrics/lib/alert-store';
import { listDashboards, getDashboard, ensureHydrated as ensureDashboardsHydrated } from '@tabs/dashboards/lib/store';
import { missingPanelMembers, panelRequestedMembers } from '@tabs/dashboards/lib/model';
import { panelViewsFor, type RegistryViewDims } from '@tabs/dashboards/lib/panel-views';
import { listGovernedDatasets } from '@tabs/data/lib/store';
import { viewName, registryDimensionMembers } from '@tabs/data/lib/metrics';
import { listWorkflows, ensureHydrated as ensureKnowledgeHydrated } from '@tabs/knowledge/lib/store';

export const monitoringSourcesImpl: MonitoringSources = {
  files: (p) => monitoringFilesSource(p),
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
        r ? { source: r.source === 'dagster' || r.source === 'os' ? r.source : null, ranAt: r.ranAt, results: r.results.map((x) => ({ id: x.id, label: x.label, status: x.status, violations: x.violations })) } : null,
      ]),
    );
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
  const wide = p.role === 'admin';
  const builder = p.role === 'builder' || p.role === 'domain_admin';
  return listAlertRules()
    .filter((r) => wide || r.owner === p.id || (builder && p.domains.includes(r.domain)))
    .map((r) => ({ id: r.id, member: r.member, comparator: r.comparator, threshold: r.threshold, owner: r.owner, domain: r.domain, lastEvaluated: r.lastEvaluated, lastBreached: r.lastBreached, lastValue: r.lastValue }));
};

export const monitoringDashboardsSource: NonNullable<MonitoringSources['dashboards']> = async (p) => {
  await ensureDashboardsHydrated();
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
