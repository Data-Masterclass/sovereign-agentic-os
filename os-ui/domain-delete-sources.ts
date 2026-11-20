/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The ordered list of every component "delete domain" removes from
 * USER STORY: As the admin deleting a domain I want one list, in one order, of everything a
 *             domain owns across the OS and its components — the same list for the Admin page
 *             and the MCP tool, and the same list the real-container test runs.
 * ARCHITECTURE:
 *   - Lives beside `instrumentation.ts` (like `opa-state-sources.ts`): the one place allowed to
 *     know both the kernel and every tab. `instrumentation.ts` registers it at boot; the route,
 *     the MCP tool (through `domainDeleteWiring()`) and the integration test all read this list.
 *   - ORDER MATTERS and is the contract: LiteLLM before agents (it needs their ids); apps, agents,
 *     knowledge, dashboards, files, connections, metrics before the tables; Trino tables BEFORE the
 *     dataset records (a record is the map to its tables, so a stopped run can resume); then the
 *     kernel's records, the repo (+ Dagster reload), OPA, members, and the domain record LAST.
 *   - Each owner acts through their LIVE principal (`principalById`); a missing or disabled owner
 *     fails the step rather than being skipped.
 *   - Trino goes through the governed query-tool (`queryRun` / `executeRun`) by default; the test
 *     passes a direct Trino port to the same component.
 */
import 'server-only';
import { registerDomainDeleteWiring, type DomainDeleteComponent } from '@core/kernel/domain-delete';
import { principalById, type CurrentUser } from '@core/kernel/auth';
import { executeRoute, executeRun, queryRun } from '@core/infra/governed';
import { approvalsComponent, foldersComponent, lifecyclePinsComponent, artifactsComponent, gitRepoComponent } from '@core/kernel/domain-delete-components';
import { icebergComponent, datasetsComponent, dqResultsComponent, datasetMeasuresForDomain, type TrinoPort } from '@tabs/data/lib/domain-delete';
import { metricsComponent } from '@tabs/metrics/lib/domain-delete';
import { dashboardsComponent } from '@tabs/dashboards/lib/domain-delete';
import { knowledgeComponent } from '@tabs/knowledge/lib/domain-delete';
import { filesComponent } from '@tabs/files/lib/domain-delete';
import { connectionsComponent } from '@tabs/connections/lib/domain-delete';
import { agentsComponent, agentSystemIdsForDomain } from '@tabs/agents/lib/domain-delete';
import { appsComponent } from '@tabs/software/lib/domain-delete';
import { opaComponent, litellmComponent, membersComponent, domainRecordComponent, soleMembers, veleroBackupCheck, assertDeletableDomain } from '@tabs/admin/lib/domain-delete';
import { recompile } from '@/app/api/platform-admin/_compile';
import { config } from '@core/kernel/config';
import { queryToolCapabilities } from '@core/adapters/query-tool/health';
import { audit } from '@tabs/admin/lib/audit';
import { currentTenantId } from '@tabs/admin/lib/tenant';

export async function ownerPrincipal(id: string): Promise<{ id: string; name: string; role: CurrentUser['role']; domains: string[] }> {
  const p = await principalById(id);
  if (!p) throw Object.assign(new Error(`owner ${id} does not exist or is disabled, so their item cannot be removed as them`), { status: 409 });
  return p;
}
async function ownerUser(id: string): Promise<CurrentUser> {
  const p = await ownerPrincipal(id);
  return { ...p, allDomains: p.domains, activeDomain: null };
}

/** The production Trino door: the governed query-tool, as the given identity. */
export const governedTrino: TrinoPort = {
  async query(sql, id) {
    return (await queryRun(sql, id.principal, executeRoute(id, 'domain-delete'))).rows;
  },
  async execute(sql, id) {
    await executeRun(sql, id, executeRoute(id, 'domain-delete'), undefined, 60_000, 'domain-delete');
  },
};

export function domainDeleteComponents(opts: { trino?: TrinoPort; recompile?: () => Promise<void>; git?: Parameters<typeof gitRepoComponent>[0] } = {}): DomainDeleteComponent[] {
  const owner = ownerPrincipal;
  return [
    litellmComponent({ agentSystemIds: agentSystemIdsForDomain }),
    appsComponent({ owner: ownerUser }),
    agentsComponent({ owner }),
    knowledgeComponent({ owner }),
    dashboardsComponent({ owner }),
    filesComponent({ owner }),
    connectionsComponent({ owner: ownerUser }),
    metricsComponent({ owner, datasets: datasetMeasuresForDomain }),
    icebergComponent({ trino: opts.trino ?? governedTrino, owner, soleMembers, purgeEnabled: () => config.domainDeletePurgeEnabled }),
    dqResultsComponent(),
    datasetsComponent({ owner }),
    approvalsComponent(),
    foldersComponent(),
    lifecyclePinsComponent(),
    artifactsComponent({ owner: ownerUser }),
    gitRepoComponent(opts.git),
    opaComponent(),
    membersComponent(),
    domainRecordComponent({ recompile: opts.recompile ?? (async () => { const r = await recompile(); if (r.publish.status !== 'published') throw new Error(`policy recompile did not publish: ${r.publish.detail}`); }) }),
  ];
}

/** A run needs the query-tool build that knows the governed delete (0.6.3+: DROP SCHEMA, the
 *  purge catalog). Refused while an older one is deployed — never failing halfway instead. */
export async function queryToolPreflight(): Promise<string | null> {
  const caps = await queryToolCapabilities();
  if (!caps.ok) return `the query-tool could not be checked (${caps.detail})`;
  return caps.value.includes('domain-delete') ? null : 'the deployed query-tool is older than 0.6.3 (no domain-delete capability): roll it out before running a delete';
}

export function registerDomainDeleteSources(): void {
  registerDomainDeleteWiring({
    components: () => domainDeleteComponents(),
    backup: veleroBackupCheck(),
    validateTarget: assertDeletableDomain,
    preflight: queryToolPreflight,
    audit: (actor) => (e) => { audit({ tenant: currentTenantId(), actor: actor.id, role: actor.role, guarded: true, ...e }); },
  });
}
