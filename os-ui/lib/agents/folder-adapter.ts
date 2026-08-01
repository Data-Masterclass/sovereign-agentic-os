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
  listSystems,
  moveAgentSystem,
  archiveSystem,
  unarchiveSystem,
  deleteSystem,
} from './store.ts';

/**
 * The Agents tab's binding to the shared folder lifecycle. Thin — wraps the store's
 * per-item ops, each already edit-scoped + throwing 403 when denied, so the core
 * cascade stays fail-closed. Registered at import (mirrors lib/data/folder-adapter.ts).
 *
 * NOTE: an agent-system DELETE is PHYSICAL in the store (drops the in-process record +
 * mirror doc + version log). The API route additionally purges the Forgejo repo + any
 * schedule CronJob; the folder cascade reuses the store's `deleteSystem` (record-level),
 * which is all the archived-only folder-delete discipline needs.
 */

function principal(user: AdapterPrincipal): Principal {
  return { id: user.id, role: user.role as Principal['role'], domains: user.domains };
}

/** Systems in a scope's lane: personal → `mine` (Personal-visibility); domain → the
 *  Shared + Marketplace lanes (both live in the owning DOMAIN's folder tree). Includes
 *  archived (the restore/delete cascade must still find hidden members). */
function itemsInScope(user: AdapterPrincipal, scope: AdapterScope): { id: string; folder: string }[] {
  const g = listSystems(principal(user), { includeArchived: true });
  const lane = scope === 'personal' ? g.mine : [...g.domain, ...g.marketplace];
  return lane.map((s) => ({ id: s.id, folder: s.folder }));
}

const agentsAdapter: ArtifactAdapter = {
  tab: 'agents',
  itemsUnderFolder: (user, scope, path): AdapterItem[] =>
    itemsInScope(user, scope)
      .filter((s) => isUnderFolder(path, s.folder))
      .map((s) => ({ id: s.id, folder: s.folder })),
  moveItem: (id, user, path) => void moveAgentSystem(id, principal(user), path),
  archiveItem: (id, user) => void archiveSystem(id, principal(user)),
  restoreItem: (id, user) => void unarchiveSystem(id, principal(user)),
  deleteItem: (id, user) => void deleteSystem(id, principal(user)),
};

registerArtifactAdapter(agentsAdapter);

export { agentsAdapter };
