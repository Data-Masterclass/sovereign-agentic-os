/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Knowledge tab's part of "delete domain" (workflows and their search chunks, personal notes, the operating manual)
 * USER STORY: As the admin deleting a domain I want every workflow, note and manual chunk of it gone — every owner's, archived
 *             ones too — through the tab's own delete, with nothing reported gone that is not.
 * ARCHITECTURE:
 *   - A {@link DomainDeleteComponent} (core/kernel/domain-delete.ts). Each item is removed by the
 *     store's own delete ACTING AS ITS OWNER (a personal item is owner-only by design; the admin's
 *     delete-domain run is the owner's act, audited as the admin's). A store report that names a
 *     leftover (`ok:false`) fails the step: the run stops and says what is left.
 */
import type { DomainDeleteComponent, PlanItem } from '@core/kernel/domain-delete';
import type { Principal } from '@tabs/knowledge/lib/store';
import { ensureHydrated, listAllForIndex, archiveWorkflow, deleteWorkflow, hasDomainKnowledge, purgeDomainKnowledgeForDomainDelete } from '@tabs/knowledge/lib/store';
import { ensureHydrated as ensurePersonalHydrated, listPersonalKnowledgeForDomain, deletePersonalKnowledge, personalKnowledgeExists } from '@tabs/knowledge/lib/personal-store';
import { purgeKnowledgeUnits } from '@tabs/knowledge/lib/index-pipeline';

async function chunks(scope: string): Promise<void> {
  if (!(await purgeKnowledgeUnits(scope))) throw new Error(`the knowledge index did not confirm the delete of the chunks of ${scope}`);
}

export function knowledgeComponent(deps: { owner: (id: string) => Promise<Principal> }): DomainDeleteComponent {
  return {
    component: 'os.knowledge',
    async plan({ domainId }) {
      await ensureHydrated();
      await ensurePersonalHydrated();
      const remove: PlanItem[] = [];
      for (const { record } of listAllForIndex().filter((w) => w.record.domain === domainId)) {
        remove.push({ component: 'os.knowledge', kind: 'workflow', id: record.id, label: `${record.id} ${record.title ?? ''}`.trim(), owner: record.owner, detail: 'record, versions, search chunks' });
      }
      for (const n of listPersonalKnowledgeForDomain(domainId)) remove.push({ component: 'os.knowledge', kind: 'note', id: n.id, label: n.id, owner: n.owner });
      if (hasDomainKnowledge(domainId)) remove.push({ component: 'os.knowledge', kind: 'manual', id: domainId, label: `operating manual of ${domainId}`, detail: 'manual, versions, search chunks' });
      return { component: 'os.knowledge', remove, keep: [] };
    },
    async remove(item) {
      if (item.kind === 'manual') {
        purgeDomainKnowledgeForDomainDelete(item.id);
        await chunks(`domain:${item.id}`);
        return 'manual + versions forgotten; chunks deleted';
      }
      if (item.kind === 'note') {
        if (!personalKnowledgeExists(item.id)) { await chunks(item.id); return 'already absent; chunks deleted'; }
        deletePersonalKnowledge(item.id, await deps.owner(item.owner!));
        await chunks(item.id);
        return 'deletePersonalKnowledge; chunks deleted';
      }
      const w = listAllForIndex().find((x) => x.record.id === item.id);
      if (w) {
        const owner = await deps.owner(item.owner!);
        // A live workflow must be archived before it can be deleted (the store's own rule).
        if (w.record.status === 'live' && !w.record.archived) archiveWorkflow(item.id, owner);
        deleteWorkflow(item.id, owner);
      }
      await chunks(item.id);
      return `${w ? 'deleteWorkflow' : 'already absent'}; chunks deleted`;
    },
  };
}
