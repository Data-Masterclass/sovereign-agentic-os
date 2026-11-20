/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Connections tab's part of "delete domain" (connections: catalog, exposures, secrets)
 * USER STORY: As the admin deleting a domain I want every connection of it gone — every owner's, archived
 *             ones too — through the tab's own delete, with nothing reported gone that is not.
 * ARCHITECTURE:
 *   - A {@link DomainDeleteComponent} (core/kernel/domain-delete.ts). Each item is removed by the
 *     store's own delete ACTING AS ITS OWNER (a personal item is owner-only by design; the admin's
 *     delete-domain run is the owner's act, audited as the admin's). A store report that names a
 *     leftover (`ok:false`) fails the step: the run stops and says what is left.
 */
import type { DomainDeleteComponent, PlanItem } from '@core/kernel/domain-delete';
import type { CurrentUser } from '@core/kernel/auth';
import { ensureConnectionsHydrated, listConnectionsForDomain, deleteConnection } from '@tabs/connections/lib/store';

export function connectionsComponent(deps: { owner: (id: string) => Promise<CurrentUser> }): DomainDeleteComponent {
  return {
    component: 'os.connections',
    async plan({ domainId }) {
      await ensureConnectionsHydrated();
      const remove = listConnectionsForDomain(domainId).map((c): PlanItem => ({ component: 'os.connections', kind: 'connection', id: c.id, label: `${c.id} ${c.name}`, owner: c.owner }));
      return { component: 'os.connections', remove, keep: [] };
    },
    async remove(item, { domainId }) {
      if (!listConnectionsForDomain(domainId).some((c) => c.id === item.id)) return 'already absent';
      const r = await deleteConnection(item.id, await deps.owner(item.owner!));
      const bad = r.physical.filter((p) => !p.ok);
      if (bad.length) throw new Error(`record deleted, but ${bad.map((b) => JSON.stringify(b)).join('; ')}`);
      return 'deleteConnection (catalog, exposures, secrets)';
    },
  };
}
