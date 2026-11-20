/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Dashboards tab's part of "delete domain" (dashboards)
 * USER STORY: As the admin deleting a domain I want every dashboard of it gone — every owner's, archived
 *             ones too — through the tab's own delete, with nothing reported gone that is not.
 * ARCHITECTURE:
 *   - A {@link DomainDeleteComponent} (core/kernel/domain-delete.ts). Each item is removed by the
 *     store's own delete ACTING AS ITS OWNER (a personal item is owner-only by design; the admin's
 *     delete-domain run is the owner's act, audited as the admin's). A store report that names a
 *     leftover (`ok:false`) fails the step: the run stops and says what is left.
 */
import type { DomainDeleteComponent, PlanItem } from '@core/kernel/domain-delete';
import type { Principal } from '@core/kernel/route-server';
import { ensureHydrated, listDashboardsForDomain, deleteDashboard } from '@tabs/dashboards/lib/store';

export function dashboardsComponent(deps: { owner: (id: string) => Promise<Principal> }): DomainDeleteComponent {
  return {
    component: 'os.dashboards',
    async plan({ domainId }) {
      await ensureHydrated();
      const remove = listDashboardsForDomain(domainId).map((d): PlanItem => ({ component: 'os.dashboards', kind: 'dashboard', id: d.id, label: `${d.id} ${d.name}`, owner: d.owner }));
      return { component: 'os.dashboards', remove, keep: [] };
    },
    async remove(item, { domainId }) {
      if (!listDashboardsForDomain(domainId).some((d) => d.id === item.id)) return 'already absent';
      deleteDashboard(item.id, await deps.owner(item.owner!));
      return 'deleteDashboard (record, versions, git)';
    },
  };
}
