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
  listFiles,
  moveFile,
  archiveFile,
  unarchiveFile,
  deleteFile,
} from './store.ts';

/**
 * The Files tab's binding to the shared folder lifecycle (see
 * `lib/core/artifact-adapter.ts`). Thin — it wraps the store's existing per-item ops,
 * each of which already runs the file edit-scope gate + throws 403 when denied, so the
 * core cascade stays fail-closed. Registered at import (below); the app imports this
 * module at boot via `lib/folders/adapters.ts`.
 */

function principal(user: AdapterPrincipal): Principal {
  return { id: user.id, role: user.role as Principal['role'], domains: user.domains };
}

/** Files in a scope's lane: personal → private (dataset-tier) files; domain → the
 *  shared/marketplace (asset/product-tier) files. Includes archived (the cascade needs
 *  to find already-hidden members to restore/delete them). */
function itemsInScope(user: AdapterPrincipal, scope: AdapterScope): { id: string; folder: string }[] {
  const g = listFiles(principal(user), { includeArchived: true });
  return scope === 'personal' ? g.mine : [...g.domain, ...g.marketplace];
}

const filesAdapter: ArtifactAdapter = {
  tab: 'files',
  itemsUnderFolder: (user, scope, path): AdapterItem[] =>
    itemsInScope(user, scope)
      .filter((f) => isUnderFolder(path, f.folder))
      .map((f) => ({ id: f.id, folder: f.folder })),
  moveItem: (id, user, path) => void moveFile(id, principal(user), path),
  archiveItem: (id, user) => void archiveFile(id, principal(user)),
  restoreItem: (id, user) => void unarchiveFile(id, principal(user)),
  deleteItem: (id, user) => void deleteFile(id, principal(user)),
};

registerArtifactAdapter(filesAdapter);

export { filesAdapter };
