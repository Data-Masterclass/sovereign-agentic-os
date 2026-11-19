/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import {
  registerArtifactAdapter,
  type ArtifactAdapter,
  type AdapterItem,
  type AdapterPrincipal,
  type AdapterScope,
} from '@core/kernel/artifact-adapter';
import { isUnderFolder } from '@core/kernel/folders';
import {
  type Principal,
  listFiles,
  moveFile,
  archiveFile,
  unarchiveFile,
} from '@tabs/files/lib/store';
import { deleteFilePermanently } from '@tabs/files/lib/physical-delete';

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
  // The SAME permanent delete as a single file: record (confirmed by the shared store — a refusal
  // throws and stops the cascade), search chunks and object-store bytes.
  deleteItem: async (id, user) => {
    const r = await deleteFilePermanently(id, principal(user));
    const left = [...(r.index.ok ? [] : [`search chunks (${r.index.reason})`]), ...r.physical.filter((p) => !p.ok).map((p) => `${p.target} (${p.reason})`)];
    if (left.length) console.warn(`[files] folder delete: ${id} deleted, but left behind: ${left.join('; ')}`);
  },
};

registerArtifactAdapter(filesAdapter);

export { filesAdapter };
