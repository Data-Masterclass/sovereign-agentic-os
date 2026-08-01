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
import type { Role } from '../core/session.ts';
import {
  ensureHydrated as ensurePillarsHydrated,
  listPillarsSync,
  movePillarSync,
  archivePillarSync,
  unarchivePillarSync,
  deletePillarSync,
  folderScopeOfPillar,
} from './pillars.ts';

/**
 * The Strategy (Pillars) tab's binding to the shared folder lifecycle. Thin — wraps
 * the pillar store's per-item SYNC ops, each already edit-scoped (`canEditPillar`,
 * roleAtLeast) + throwing 403 when denied, so the core cascade stays fail-closed.
 * Registered at import (`tab: 'pillars'`).
 *
 * ASYNC-STORE / SYNC-ADAPTER NOTE: the pillar store is ASYNC (getCache/listPillars
 * await the durable mirror) but the `ArtifactAdapter` contract is SYNCHRONOUS — the
 * cascade calls each op without awaiting and relies on a governance throw surfacing.
 * So this adapter reads/writes the store's ALREADY-HYDRATED in-memory cache through
 * the store's SYNC helpers (`listPillarsSync` + `*Sync` mutators). The folder API
 * route hydrates the pillar store (`ensureHydrated`) BEFORE the cascade runs, so the
 * cache is populated by the time the adapter reads it. A minimal, honest seam that
 * keeps the fail-closed 403 semantics rather than fire-and-forgetting the async ops.
 *
 * HYDRATION CAVEAT (documented, not hidden): unlike Data/Metrics/Dashboards — whose
 * stores are synchronously-readable with a lazy seed — the pillar cache is populated
 * only by the ASYNC `getCache()`. The generic `/api/folders/[id]` cascade route
 * hydrates the FOLDERS store, not the pillar store, so on a cold process the very
 * first folder-cascade could read an un-hydrated (empty) pillar cache. That is
 * fail-closed (the cascade under-reaches — it never touches a pillar it shouldn't),
 * and we mitigate it by kicking off the pillar hydration at import (below), so a
 * long-lived pod has the cache warm well before any user-driven folder cascade. The
 * DIRECT move/rename routes (`/api/strategy/pillars/[id]/…`) await `getCache()` and
 * are always fully correct. Shared plumbing is intentionally left untouched.
 *
 * SCOPE MAPPING (PillarScope → FolderScope): folders are personal|domain only, but a
 * pillar carries a THREE-tier scope. personal (My) → 'personal'; domain AND tenant
 * (Company) → 'domain' — a tenant pillar is org-wide, so it lives in the domain tree
 * keyed to the literal 'tenant' domain value it carries. Split by scope so a cascade
 * never crosses tiers.
 */

function principal(user: AdapterPrincipal): { id: string; role: Role; domains: string[] } {
  return { id: user.id, role: user.role as Role, domains: user.domains };
}

/** Pillars in a scope's lane: personal → the personal (My) tier; domain → the domain
 *  + tenant (Company) tiers (per the mapping). Includes archived (the cascade needs to
 *  find members the archive step already hid). */
function itemsInScope(scope: AdapterScope): { id: string; folder: string }[] {
  return listPillarsSync()
    .filter((p) => folderScopeOfPillar(p) === scope)
    .map((p) => ({ id: p.id, folder: p.folder ?? '/' }));
}

const pillarsAdapter: ArtifactAdapter = {
  tab: 'pillars',
  itemsUnderFolder: (_user, scope, path): AdapterItem[] =>
    itemsInScope(scope)
      .filter((p) => isUnderFolder(path, p.folder))
      .map((p) => ({ id: p.id, folder: p.folder })),
  moveItem: (id, user, path) => movePillarSync(id, principal(user), path),
  archiveItem: (id, user) => archivePillarSync(id, principal(user)),
  restoreItem: (id, user) => unarchivePillarSync(id, principal(user)),
  deleteItem: (id, user) => deletePillarSync(id, principal(user)),
};

registerArtifactAdapter(pillarsAdapter);

// Warm the pillar cache at import so a folder cascade on a long-lived pod reads a
// hydrated store (see HYDRATION CAVEAT above). Best-effort: a mirror-down boot leaves
// the store in-memory-only, exactly as `getCache` already tolerates.
void ensurePillarsHydrated().catch(() => { /* best-effort warm; store stays in-memory */ });

export { pillarsAdapter };
