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
import type { DomainDeleteComponent, KeptItem, PlanItem } from '@core/kernel/domain-delete';
import { ensureHydrated as ensureApprovalsHydrated, listApprovalsForDomain, purgeApprovalForDomainDelete } from '@core/policy/approvals';
import { ensureHydrated as ensureFoldersHydrated, listFoldersForDomain, purgeFolderForDomainDelete } from '@core/folders/folder-store';
import { lifecycleIndex, clearLivePin } from '@core/infra/lifecycle-pins';
import { parsePinKey } from '@core/kernel/object-lifecycle';
import { allArtifacts, deleteArtifact } from '@core/kernel/artifacts';
import { deleteDomainRepo, repoExists, resolveRepo } from '@core/infra/git-store';
import { reloadLocation, domainDefinitions, stopInstigator, type DagsterDeps, type DomainDefinitions } from '@core/infra/dagster';
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

/**
 * The domain repo and its Dagster definitions. Order inside the component: stop the domain's
 * RUNNING schedules and sensors (Dagster GraphQL), delete the repo, then VERIFY: reload the
 * location until GraphQL shows no job, schedule, sensor or asset group of the domain (repo-sync
 * prunes the removed domain's checkout on its next pass). A timeout fails the step.
 * `dagster: null` (a harness without Dagster) plans nothing for Dagster and BLOCKS a repo.
 */
export function gitRepoComponent(deps: { dagster?: DagsterDeps | null; verifyTimeoutMs?: number; pollMs?: number } = {}): DomainDeleteComponent {
  const dg = deps.dagster === undefined ? {} : deps.dagster;
  const timeout = deps.verifyTimeoutMs ?? 180_000;
  const poll = deps.pollMs ?? 5_000;
  const leftovers = (d: DomainDefinitions) => d.jobs.length + d.schedules.length + d.sensors.length + d.assetGroups.length;
  return {
    component: 'git',
    async plan({ domainId }) {
      const remove: PlanItem[] = [];
      const blocked: KeptItem[] = [];
      const hasRepo = repoExists(domainId);
      if (dg === null) {
        if (hasRepo) blocked.push({ component: 'git', kind: 'repo', id: domainId, label: resolveRepo(domainId).dir, reason: 'Dagster is not reachable in this process, so the repo cannot be removed safely' });
        return { component: 'git', remove, keep: [], blocked };
      }
      const defs = await domainDefinitions(domainId, dg);
      if (!defs.ok) throw new Error(`Dagster GraphQL: ${defs.error}`);
      for (const s of defs.data.schedules) if (s.status === 'RUNNING') remove.push({ component: 'git', kind: 'stop-schedule', id: JSON.stringify(s), label: `Dagster schedule ${s.name} (RUNNING)` });
      for (const s of defs.data.sensors) if (s.status === 'RUNNING') remove.push({ component: 'git', kind: 'stop-sensor', id: JSON.stringify(s), label: `Dagster sensor ${s.name} (RUNNING)` });
      if (hasRepo) remove.push({ component: 'git', kind: 'repo', id: domainId, label: resolveRepo(domainId).dir });
      if (hasRepo || leftovers(defs.data) > 0) {
        remove.push({ component: 'git', kind: 'dagster-definitions', id: domainId, label: `Dagster: ${defs.data.jobs.length} jobs, ${defs.data.schedules.length} schedules, ${defs.data.sensors.length} sensors, ${defs.data.assetGroups.length} asset group(s) of ${domainId}` });
      }
      return { component: 'git', remove, keep: [] };
    },
    async remove(item) {
      if (item.kind === 'stop-schedule' || item.kind === 'stop-sensor') {
        const s = JSON.parse(item.id) as { name: string; stateId: string | null; selectorId: string | null };
        const r = await stopInstigator(item.kind === 'stop-schedule' ? 'schedule' : 'sensor', s, dg ?? {});
        if (!r.ok) throw new Error(`Dagster could not stop ${s.name}: ${r.error}`);
        if (r.data.status !== 'STOPPED') throw new Error(`Dagster reports ${s.name} as ${r.data.status} after the stop`);
        return `stopped ${s.name}`;
      }
      if (item.kind === 'repo') {
        const removed = deleteDomainRepo(item.id);
        return `removed ${removed.join(', ') || '(already absent)'}`;
      }
      // dagster-definitions: reload until GraphQL shows nothing of the domain.
      const end = Date.now() + timeout;
      let last = '';
      while (Date.now() < end) {
        const rl = await reloadLocation(undefined, dg ?? {});
        if (!rl.ok) last = `reload failed: ${rl.error}`;
        const d = await domainDefinitions(item.id, dg ?? {});
        if (d.ok && leftovers(d.data) === 0) return `Dagster location reloaded; no job, schedule, sensor or asset of ${item.id} remains`;
        if (d.ok) last = `still loaded: jobs [${d.data.jobs.join(', ')}], schedules [${d.data.schedules.map((x) => x.name).join(', ')}], groups [${d.data.assetGroups.join(', ')}]`;
        else last = `GraphQL: ${d.error}`;
        await new Promise((r) => setTimeout(r, poll));
      }
      throw new Error(`Dagster still holds ${item.id} after ${Math.round(timeout / 1000)} s (${last}); repo-sync has not pruned its checkout`);
    },
  };
}
