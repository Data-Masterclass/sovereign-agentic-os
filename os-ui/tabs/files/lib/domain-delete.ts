/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Files tab's part of "delete domain" (files: the record, its search chunks and its S3 object)
 * USER STORY: As the admin deleting a domain I want every file of it gone — every owner's, archived
 *             ones too — through the tab's own delete, with nothing reported gone that is not.
 * ARCHITECTURE:
 *   - A {@link DomainDeleteComponent} (core/kernel/domain-delete.ts). Each item is removed by the
 *     store's own delete ACTING AS ITS OWNER (a personal item is owner-only by design; the admin's
 *     delete-domain run is the owner's act, audited as the admin's). A store report that names a
 *     leftover (`ok:false`) fails the step: the run stops and says what is left.
 */
import type { DomainDeleteComponent, PlanItem } from '@core/kernel/domain-delete';
import type { Principal } from '@core/kernel/route-server';
import { ensureHydrated, listAllForAutoDocs } from '@tabs/files/lib/store';
import { deleteFilePermanently } from '@tabs/files/lib/physical-delete';

export function filesComponent(deps: { owner: (id: string) => Promise<Principal> }): DomainDeleteComponent {
  const mine = (domainId: string) => listAllForAutoDocs().filter((f) => f.asset.domain === domainId);
  return {
    component: 'os.files',
    async plan({ domainId }) {
      await ensureHydrated();
      const remove = mine(domainId).map((f): PlanItem => ({ component: 'os.files', kind: 'file', id: f.asset.id, label: `${f.asset.id} ${f.asset.name}`, owner: f.asset.owner, detail: 'record, search chunks, S3 object' }));
      return { component: 'os.files', remove, keep: [] };
    },
    async remove(item, { domainId }) {
      if (!mine(domainId).some((f) => f.asset.id === item.id)) return 'already absent';
      const r = await deleteFilePermanently(item.id, await deps.owner(item.owner!));
      const bad = r.physical.filter((p) => !p.ok);
      if (!r.index.ok) bad.push({ target: 'search chunks', ok: false, reason: r.index.reason });
      if (bad.length) throw new Error(`record deleted, but ${bad.map((b) => `${b.target}: ${b.reason ?? 'not removed'}`).join('; ')}`);
      return `deleteFilePermanently (${r.physical.map((p) => p.target).join(', ')})`;
    },
  };
}
