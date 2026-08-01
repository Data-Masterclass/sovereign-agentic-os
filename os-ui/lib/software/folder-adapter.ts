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
import type { CurrentUser } from '../core/auth.ts';
import type { Role } from '../core/session.ts';
import { moveApp, listAppsInScopeSync } from './apps.ts';
import { archiveApp, unarchiveApp, deleteApp } from './lifecycle.ts';

/**
 * The Software tab's binding to the shared folder lifecycle. Thin — wraps the store's
 * per-item ops, each already edit-scoped + throwing 403 when denied, so the core
 * cascade stays fail-closed. Registered at import (mirrors lib/data/folder-adapter.ts).
 *
 * The stable id key is the app `id` (`app_*`) — exactly what /api/apps/[id] routes on
 * and what moveApp/archiveApp/deleteApp resolve. The app's frozen `slug` (repo/image/
 * container/CI identity) is NEVER used here: a folder move is DISPLAY-only.
 *
 * ASYNC vs the sync cascade: the app store is async (in-process cache + durable mirror),
 * but the ArtifactAdapter contract is sync. `itemsUnderFolder` reads the already-hydrated
 * cache synchronously (listAppsInScopeSync); the move/archive/restore/delete ops are the
 * app's own async lifecycle fns, fired through `void` — each still runs its edit-scope
 * gate + write-through, and a NEEDED teardown (runner/Forgejo) is best-effort exactly as
 * the app's own lifecycle route treats it.
 *
 * NOTE: an app DELETE is LINEAGE-AWARE (deleteApp blocks while another app depends on
 * this one's MCP/connection/data) — the folder cascade reuses that gate unchanged.
 */

/** Map the folder cascade's principal onto a CurrentUser the app ops read (they use
 *  id/role/domains only). allDomains/activeDomain are derived so the shim is coherent. */
function asUser(user: AdapterPrincipal): CurrentUser {
  return {
    id: user.id,
    name: user.id,
    domains: user.domains,
    allDomains: user.domains,
    activeDomain: user.domains.length === 1 ? user.domains[0] : null,
    role: user.role as Role,
  };
}

const softwareAdapter: ArtifactAdapter = {
  tab: 'software',
  itemsUnderFolder: (user, scope: AdapterScope, path): AdapterItem[] =>
    listAppsInScopeSync(asUser(user), scope)
      .filter((a) => isUnderFolder(path, a.folder))
      .map((a) => ({ id: a.id, folder: a.folder })),
  moveItem: (id, user, path) => void moveApp(id, asUser(user), path),
  archiveItem: (id, user) => void archiveApp(id, asUser(user)),
  restoreItem: (id, user) => void unarchiveApp(id, asUser(user)),
  deleteItem: (id, user) => void deleteApp(id, asUser(user)),
};

registerArtifactAdapter(softwareAdapter);

export { softwareAdapter };
