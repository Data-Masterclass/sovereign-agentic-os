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
import { isUnderFolder, normaliseFolderPath } from '../core/folders.ts';
import type { CurrentUser } from '../core/auth.ts';
import {
  listConnectionsSync,
  moveConnection,
  setConnectionArchivedSync,
  deleteConnectionSync,
} from './store.ts';

/**
 * The Connections tab's binding to the shared folder lifecycle. Thin — wraps the store's
 * per-item ops, each already edit-scoped + throwing 403 when denied, so the core cascade
 * stays fail-closed. Registered at import.
 *
 * SYNC over an ASYNC store (the wrinkle vs Data/Metrics): the connections store is
 * OpenSearch-mirror-backed, so its user-facing reads/writes are async — but the shared
 * `ArtifactAdapter` + folder lifecycle are strictly SYNCHRONOUS. So the store exposes SYNC
 * folder/lifecycle ops (`moveConnection`, `setConnectionArchivedSync`, `deleteConnectionSync`,
 * `listConnectionsSync`) that read the already-warm in-process cache (mirrors Bigbets, which
 * is also mirror-backed). Physical vault-secret purge stays on the async tab-delete path;
 * this cascade delete removes the registry record + OPA profile only (never a silent leftover).
 *
 * SCOPE SPLIT: a Personal connection lives in the OWNER's personal tree; a Shared/Certified
 * one in the owning DOMAIN's tree (mirrors `store.folderScopeOf`). We map each connection to
 * its lane and return NOTHING for the other scope, so a cascade never crosses tiers.
 */

/** The `AdapterPrincipal` (id/role/domains) as the minimal `CurrentUser` the store's
 *  edit-scope gate + visibility gate actually read. The unused CurrentUser fields
 *  (name/allDomains/activeDomain) are never touched by any function called here. */
function asUser(user: AdapterPrincipal): CurrentUser {
  return { id: user.id, role: user.role as CurrentUser['role'], domains: user.domains } as CurrentUser;
}

/** Connections in a scope's lane: personal → Personal-visibility; domain → Shared +
 *  Certified. Includes archived (the restore/delete cascade must find members the archive
 *  step already hid). */
function itemsInScope(user: AdapterPrincipal, scope: AdapterScope): { id: string; folder: string }[] {
  const wantPersonal = scope === 'personal';
  return listConnectionsSync(asUser(user))
    .filter((c) => (c.visibility === 'Personal') === wantPersonal)
    .map((c) => ({ id: c.id, folder: normaliseFolderPath(c.folder ?? '/') }));
}

const connectionsAdapter: ArtifactAdapter = {
  tab: 'connections',
  itemsUnderFolder: (user, scope, path): AdapterItem[] =>
    itemsInScope(user, scope)
      .filter((c) => isUnderFolder(path, c.folder))
      .map((c) => ({ id: c.id, folder: c.folder })),
  moveItem: (id, user, path) => void moveConnection(id, asUser(user), path),
  archiveItem: (id, user) => void setConnectionArchivedSync(id, asUser(user), true),
  restoreItem: (id, user) => void setConnectionArchivedSync(id, asUser(user), false),
  deleteItem: (id, user) => void deleteConnectionSync(id, asUser(user)),
};

registerArtifactAdapter(connectionsAdapter);

export { connectionsAdapter };
