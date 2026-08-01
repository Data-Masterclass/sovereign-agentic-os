/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import {
  registerArtifactAdapter,
  type ArtifactAdapter,
  type AdapterItem,
  type AdapterPrincipal,
  type AdapterScope,
} from '../core/artifact-adapter.ts';
import { isUnderFolder } from '../core/folders.ts';
import {
  type Principal,
  listWorkflows,
  moveWorkflow,
  archiveWorkflow,
  unarchiveWorkflow,
  deleteWorkflow,
} from './store.ts';

/**
 * The Business Processes (Workflows) tab's binding to the shared folder lifecycle.
 * A workflow is foldered in its tier's tree: a Personal draft in the `personal` lane
 * (My), a Shared/Certified process in the `domain` lane (Domain / Company). Thin —
 * wraps the store's per-item ops, each already edit-scoped + throwing 403 when denied,
 * so the cascade stays fail-closed. Registered at import.
 *
 * NB the file is `workflow-folder-adapter.ts` (not `folder-adapter.ts`) because
 * `lib/knowledge/folder-adapter.ts` already binds the Knowledge (personal-knowledge)
 * tab; workflows are a separate store + tab namespace.
 */

function principal(user: AdapterPrincipal): Principal {
  return { id: user.id, role: user.role as Principal['role'], domains: user.domains };
}

/** Workflows in a scope's lane: personal → My (drafts); domain → the shared/certified
 *  (Domain + Company) lanes. Includes archived. */
function itemsInScope(user: AdapterPrincipal, scope: AdapterScope): { id: string; folder: string }[] {
  const g = listWorkflows(principal(user), { includeArchived: true });
  const lane = scope === 'personal' ? g.mine : [...g.domain, ...g.marketplace];
  return lane.map((w) => ({ id: w.id, folder: w.folder ?? '/' }));
}

const workflowAdapter: ArtifactAdapter = {
  tab: 'workflows',
  itemsUnderFolder: (user, scope, path): AdapterItem[] =>
    itemsInScope(user, scope)
      .filter((w) => isUnderFolder(path, w.folder))
      .map((w) => ({ id: w.id, folder: w.folder })),
  moveItem: (id, user, path) => void moveWorkflow(id, principal(user), path),
  archiveItem: (id, user) => void archiveWorkflow(id, principal(user)),
  restoreItem: (id, user) => void unarchiveWorkflow(id, principal(user)),
  deleteItem: (id, user) => void deleteWorkflow(id, principal(user)),
};

registerArtifactAdapter(workflowAdapter);

export { workflowAdapter };
