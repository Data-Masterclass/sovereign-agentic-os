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
import type { Principal } from './model.ts';
import {
  listBets,
  moveBet,
  archiveBet,
  unarchiveBet,
  deleteBet,
} from './store.ts';

/**
 * The Big Bets tab's binding to the shared folder lifecycle. Thin — wraps the
 * store's per-item ops, each already edit-scoped + throwing 403 when denied, so the
 * core cascade stays fail-closed. Registered at import.
 *
 * SCOPE SPLIT (the wrinkle vs Data/Metrics): `listBets` returns a FLAT array, not a
 * `{ mine, domain, marketplace }` grouping — a bet has no owner-private "personal"
 * tier (its domain peers can view a non-cross-domain bet), so EVERY bet lives in the
 * DOMAIN lane (mirrors `store.folderScopeOf` → always 'domain'). We therefore map
 * each bet to the 'domain' scope and return NOTHING for the 'personal' scope, so a
 * cascade in a personal folder never touches a domain bet (and vice-versa).
 */

function principal(user: AdapterPrincipal): Principal {
  return { id: user.id, role: user.role as Principal['role'], domains: user.domains };
}

/** Bets in a scope's lane. Bigbets have NO personal tier → the personal lane is
 *  always empty; the domain lane is every bet the caller may see. Includes archived
 *  (the restore/delete cascade must find members the archive step already hid). */
function itemsInScope(user: AdapterPrincipal, scope: AdapterScope): { id: string; folder: string }[] {
  if (scope === 'personal') return []; // no owner-private bet tier — nothing lives in a personal folder
  return listBets(principal(user), { includeArchived: true }).map((b) => ({ id: b.id, folder: b.folder }));
}

const bigbetsAdapter: ArtifactAdapter = {
  tab: 'bigbets',
  itemsUnderFolder: (user, scope, path): AdapterItem[] =>
    itemsInScope(user, scope)
      .filter((b) => isUnderFolder(path, b.folder))
      .map((b) => ({ id: b.id, folder: b.folder })),
  moveItem: (id, user, path) => void moveBet(id, principal(user), path),
  archiveItem: (id, user) => void archiveBet(id, principal(user)),
  restoreItem: (id, user) => void unarchiveBet(id, principal(user)),
  deleteItem: (id, user) => void deleteBet(id, principal(user)),
};

registerArtifactAdapter(bigbetsAdapter);

export { bigbetsAdapter };
