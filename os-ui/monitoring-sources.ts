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
import { listWarehouseConnections } from '@tabs/connections/lib/store';
import { footprint } from '@tabs/data/lib/physical-delete';
import { domainSchema } from '@tabs/data/lib/store-fqn';
import { latestDqRuns } from '@tabs/data/lib/dq-status-server';
import { projectSnapshot } from '@tabs/data/lib/dbt/snapshot';
import { datasetAssetKeys } from '@tabs/data/lib/dbt/asset-keys';
import { dataProjectGitEnabled } from '@tabs/data/lib/dbt/commit';
import { listFiles, getFile, ensureHydrated as ensureFilesHydrated } from '@tabs/files/lib/store';
import { listWorkflows, ensureHydrated as ensureKnowledgeHydrated } from '@tabs/knowledge/lib/store';

export const monitoringSourcesImpl: MonitoringSources = {
  files: (p) => monitoringFilesSource(p),
  knowledge: (p) => monitoringKnowledgeSource(p),
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
  async syncSchedules() {
    await ensureDataHydrated();
    const domains = await listRepos().then((x) => x.map((y) => y.name)).catch(() => [] as string[]);
    return listAllDatasets().filter((d) => d.sync?.enabled && d.domain).map((d) => ({ schedule: scheduleNameFor(d.domain, d.id, domains), domain: d.domain, owner: d.owner, datasetId: d.id }));
  },
  async connectionCatalogs() {
    return (await listWarehouseConnections()).flatMap((c) => (c.warehouse ? [{ catalog: c.warehouse.catalog, connectionId: c.id, name: c.name, domain: c.domain }] : []));
  },
  async registeredTables() {
    await ensureDataHydrated();
    const all = listAllDatasets({ includeArchived: true });
    const repos = await listRepos().then((x) => x.map((y) => y.name)).catch(() => [] as string[]);
    // The dbt models Dagster manages: their tables are the repository's, not shadow tables.
    let managedNames: string[] | null = [];
    if (dataProjectGitEnabled() && dagsterConfigured()) {
      const g = await assetGraph();
      managedNames = g.ok ? g.data.map((n) => n.key[n.key.length - 1]).filter(Boolean) : null;
    }
    return {
      managedNames,
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

export const monitoringKnowledgeSource: NonNullable<MonitoringSources['knowledge']> = async (p) => {
  await ensureKnowledgeHydrated();
  const g = listWorkflows(asPrincipal(p));
  return (['mine', 'domain', 'marketplace'] as const).flatMap((scope) =>
    g[scope].map((w) => ({ id: w.id, title: w.title, domain: w.domain, scope, status: w.status, updatedAt: w.updatedAt, publishedAt: w.publishedAt, certified: !!w.certifiedAt })),
  );
};

export function registerMonitoringPanelSources(): void {
  registerMonitoringSources(monitoringSourcesImpl);
}
