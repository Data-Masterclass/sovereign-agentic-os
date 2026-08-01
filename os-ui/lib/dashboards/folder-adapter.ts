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
  listDashboards,
  moveDashboard,
  setDashboardArchived,
  deleteDashboard,
} from './store.ts';

/**
 * The Dashboards tab's binding to the shared folder lifecycle. Thin — wraps the store's
 * per-item ops, each already edit-scoped + throwing 403 when denied, so the core
 * cascade stays fail-closed. Registered at import.
 */

function principal(user: AdapterPrincipal): Principal {
  return { id: user.id, role: user.role as Principal['role'], domains: user.domains };
}

/** Dashboards in a scope's lane: personal → `mine`; domain → shared + marketplace.
 *  Includes archived. */
function itemsInScope(user: AdapterPrincipal, scope: AdapterScope): { id: string; folder: string }[] {
  const g = listDashboards(principal(user), { includeArchived: true });
  const lane = scope === 'personal' ? g.mine : [...g.domain, ...g.marketplace];
  return lane.map((d) => ({ id: d.id, folder: d.folder }));
}

const dashboardsAdapter: ArtifactAdapter = {
  tab: 'dashboards',
  itemsUnderFolder: (user, scope, path): AdapterItem[] =>
    itemsInScope(user, scope)
      .filter((d) => isUnderFolder(path, d.folder))
      .map((d) => ({ id: d.id, folder: d.folder })),
  moveItem: (id, user, path) => void moveDashboard(id, principal(user), path),
  archiveItem: (id, user) => void setDashboardArchived(id, principal(user), true),
  restoreItem: (id, user) => void setDashboardArchived(id, principal(user), false),
  deleteItem: (id, user) => void deleteDashboard(id, principal(user)),
};

registerArtifactAdapter(dashboardsAdapter);

export { dashboardsAdapter };
