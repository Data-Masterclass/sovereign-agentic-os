/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Agents tab's part of "delete domain" (agent systems and their schedule CronJobs)
 * USER STORY: As the admin deleting a domain I want every agent system of it gone — every owner's, archived
 *             ones too — through the tab's own delete, with nothing reported gone that is not.
 * ARCHITECTURE:
 *   - A {@link DomainDeleteComponent} (core/kernel/domain-delete.ts). Each item is removed by the
 *     store's own delete ACTING AS ITS OWNER (a personal item is owner-only by design; the admin's
 *     delete-domain run is the owner's act, audited as the admin's). A store report that names a
 *     leftover (`ok:false`) fails the step: the run stops and says what is left.
 */
import type { DomainDeleteComponent, PlanItem } from '@core/kernel/domain-delete';
import type { Principal } from '@tabs/agents/lib/store';
import { ensureHydrated, listSystemsForDomain, deleteSystem, __recordFor } from '@tabs/agents/lib/store';
import { purgeSystemResources } from '@tabs/agents/lib/physical-delete';
import { reconcileScheduleCron } from '@tabs/agents/lib/schedule-cron';

/** The domain's agent-system ids (the LiteLLM part needs them before the systems go). */
export async function agentSystemIdsForDomain(domainId: string): Promise<string[]> {
  await ensureHydrated();
  return listSystemsForDomain(domainId).map((s) => s.id);
}

export function agentsComponent(deps: { owner: (id: string) => Promise<Principal> }): DomainDeleteComponent {
  return {
    component: 'os.agents',
    async plan({ domainId }) {
      await ensureHydrated();
      const remove = listSystemsForDomain(domainId).map((s): PlanItem => ({ component: 'os.agents', kind: 'agent-system', id: s.id, label: `${s.id} ${s.name}`, owner: s.owner, ...(s.archived ? { detail: 'archived' } : {}) }));
      return { component: 'os.agents', remove, keep: [] };
    },
    async remove(item) {
      if (!__recordFor(item.id)) return 'already absent';
      const rec = deleteSystem(item.id, await deps.owner(item.owner!));
      const report = await purgeSystemResources(rec, {
        teardownCron: async (id) => { const r = await reconcileScheduleCron(id, { kind: 'manual' }); return { ok: r.ok, detail: r.detail }; },
      });
      const bad = report.physical.filter((p) => !p.ok);
      if (bad.length) throw new Error(`record deleted, but ${bad.map((b) => `${b.target}: ${b.reason ?? 'not removed'}`).join('; ')}`);
      return `deleteSystem; ${report.physical.map((p) => p.target).join(', ') || 'no schedule CronJob'}`;
    },
  };
}
