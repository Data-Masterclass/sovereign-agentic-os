/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The kernel-owned parts of "delete domain": approvals, folders, lifecycle pins,
 *             generic artifacts, and the domain git repo (then a Dagster code-location reload)
 * USER STORY: As the admin deleting a domain I want the records the kernel keeps for it — its
 *             approvals, folders, Draft/Testing/Live pins, app-data artifacts and its repo — gone,
 *             and Dagster to stop loading the repo.
 * ARCHITECTURE:
 *   - Same {@link DomainDeleteComponent} contract as the tabs' parts; each removes through its
 *     store's own delete (the confirmed mirror delete where the store had none, added next to the
 *     store so the store owns its persistence).
 *   - The repo is deleted from `reposDir` by `deleteDomainRepo` (git-store), then Dagster's GraphQL
 *     `reloadRepositoryLocation` makes the code location drop the domain's definitions. A failed
 *     reload fails the step (re-run to retry); the repo deletion itself is idempotent.
 *   - Pins are cleared without a repo commit: the repo is removed by the next component.
 */
import type { DomainDeleteComponent, PlanItem } from '@core/kernel/domain-delete';
import { ensureHydrated as ensureApprovalsHydrated, listApprovalsForDomain, purgeApprovalForDomainDelete } from '@core/policy/approvals';
import { ensureHydrated as ensureFoldersHydrated, listFoldersForDomain, purgeFolderForDomainDelete } from '@core/folders/folder-store';
import { lifecycleIndex, clearLivePin } from '@core/infra/lifecycle-pins';
import { parsePinKey } from '@core/kernel/object-lifecycle';
import { allArtifacts, deleteArtifact } from '@core/kernel/artifacts';
import { deleteDomainRepo, repoExists, resolveRepo } from '@core/infra/git-store';
import { reloadLocation } from '@core/infra/dagster';
import type { CurrentUser } from '@core/kernel/auth';

/** Resolve an owner's live principal as a full session user (stores that take `CurrentUser`). */
export type OwnerUser = (ownerId: string) => Promise<CurrentUser>;

export function approvalsComponent(): DomainDeleteComponent {
  return {
    component: 'os.approvals',
    async plan({ domainId }) {
      await ensureApprovalsHydrated();
      const remove = listApprovalsForDomain(domainId).map((a): PlanItem => ({ component: 'os.approvals', kind: 'approval', id: a.id, label: `${a.id} ${a.kind} (${a.status})` }));
      return { component: 'os.approvals', remove, keep: [] };
    },
    async remove(item) {
      return `os-approvals ${await purgeApprovalForDomainDelete(item.id)}`;
    },
  };
}

export function foldersComponent(): DomainDeleteComponent {
  return {
    component: 'os.folders',
    async plan({ domainId }) {
      await ensureFoldersHydrated();
      const remove = listFoldersForDomain(domainId).map((f): PlanItem => ({ component: 'os.folders', kind: 'folder', id: f.id, label: `${f.tab}:${f.path}`, owner: f.owner }));
      return { component: 'os.folders', remove, keep: [] };
    },
    async remove(item) {
      return `os-folders ${await purgeFolderForDomainDelete(item.id)}`;
    },
  };
}

export function lifecyclePinsComponent(): DomainDeleteComponent {
  return {
    component: 'os.lifecycle-pins',
    async plan({ domainId }) {
      const index = await lifecycleIndex();
      const remove: PlanItem[] = [];
      for (const [key, pin] of Object.entries(index.pins)) {
        if (pin.domain === domainId && parsePinKey(key)) remove.push({ component: 'os.lifecycle-pins', kind: 'pin', id: key, label: `pin ${key}` });
      }
      return { component: 'os.lifecycle-pins', remove, keep: [] };
    },
    async remove(item, { domainId, actor }) {
      const k = parsePinKey(item.id)!;
      const r = await clearLivePin(k.kind, k.id, { id: actor.id }, domainId, { commit: false });
      return r.removed ? 'pin cleared' : 'already absent';
    },
  };
}

export function artifactsComponent(deps: { owner: OwnerUser }): DomainDeleteComponent {
  return {
    component: 'os.artifacts',
    async plan({ domainId }) {
      const remove = (await allArtifacts()).filter((a) => a.domain === domainId).map((a): PlanItem => ({ component: 'os.artifacts', kind: a.type ?? 'artifact', id: a.id, label: `${a.id} ${a.name ?? ''}`.trim(), owner: a.owner }));
      return { component: 'os.artifacts', remove, keep: [] };
    },
    async remove(item) {
      await deleteArtifact(item.id, await deps.owner(item.owner!));
      return 'deleteArtifact (record, versions)';
    },
  };
}

export function gitRepoComponent(deps: { reload?: () => ReturnType<typeof reloadLocation> } = {}): DomainDeleteComponent {
  const reload = deps.reload ?? (() => reloadLocation());
  return {
    component: 'git',
    async plan({ domainId }) {
      if (!repoExists(domainId)) return { component: 'git', remove: [], keep: [] };
      return { component: 'git', remove: [{ component: 'git', kind: 'repo', id: domainId, label: resolveRepo(domainId).dir }], keep: [] };
    },
    async remove(item) {
      const removed = deleteDomainRepo(item.id);
      const r = await reload();
      if (!r.ok) throw new Error(`repo removed (${removed.join(', ') || 'already absent'}), but the Dagster reload failed: ${r.error}`);
      return `removed ${removed.join(', ') || '(already absent)'}; Dagster location ${r.data.name} reloaded`;
    },
  };
}
