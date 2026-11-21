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

export const monitoringSourcesImpl: MonitoringSources = {
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

export function registerMonitoringPanelSources(): void {
  registerMonitoringSources(monitoringSourcesImpl);
}
