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
  listDatasets,
  moveDataset,
  archiveDataset,
  unarchiveDataset,
  deleteDataset,
} from './store.ts';

/**
 * The Data tab's binding to the shared folder lifecycle. Thin — wraps the store's
 * per-item ops, each already edit-scoped + throwing 403 when denied, so the core
 * cascade stays fail-closed. Registered at import.
 */

function principal(user: AdapterPrincipal): Principal {
  return { id: user.id, role: user.role as Principal['role'], domains: user.domains };
}

/** Datasets in a scope's lane: personal → private (dataset-tier); domain → the
 *  shared/marketplace (asset/product-tier). Includes archived. */
function itemsInScope(user: AdapterPrincipal, scope: AdapterScope): { id: string; folder: string }[] {
  const g = listDatasets(principal(user), { includeArchived: true });
  return scope === 'personal' ? g.mine : [...g.domain, ...g.marketplace];
}

const dataAdapter: ArtifactAdapter = {
  tab: 'data',
  itemsUnderFolder: (user, scope, path): AdapterItem[] =>
    itemsInScope(user, scope)
      .filter((d) => isUnderFolder(path, d.folder))
      .map((d) => ({ id: d.id, folder: d.folder })),
  moveItem: (id, user, path) => void moveDataset(id, principal(user), path),
  archiveItem: (id, user) => void archiveDataset(id, principal(user)),
  restoreItem: (id, user) => void unarchiveDataset(id, principal(user)),
  deleteItem: (id, user) => void deleteDataset(id, principal(user)),
};

registerArtifactAdapter(dataAdapter);

export { dataAdapter };
