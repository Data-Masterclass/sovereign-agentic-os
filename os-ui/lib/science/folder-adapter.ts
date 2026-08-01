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
  listModelsForUser,
  moveModel,
  setModelArchived,
  deleteModel,
} from './model-service.ts';
import type { Actor, ServiceModel } from './types.ts';

/**
 * The Science tab's binding to the shared folder lifecycle. Thin — wraps the
 * model-service's per-item ops, each already edit-scoped + throwing 403 when denied,
 * so the core cascade stays fail-closed. Registered at import.
 *
 * SCOPE JUDGMENT CALL: a model-as-service is DOMAIN-SCOPED — even a `Personal`-tier
 * model is owner-only WITHIN its owning domain (there is no cross-tenant personal
 * lane like the Data tab's `personal_<uid>` schema). So EVERY model's folders live in
 * the owning DOMAIN's tree: the adapter returns models only for the `'domain'` scope
 * and NOTHING for `'personal'`, and the list UI renders only the domain root
 * (`FolderTree roots={['domain']}`). `moveModel` upserts its registry rows under
 * `scope:'domain'` to match. Keyed by the model id (`m.model` — the serving/deploy
 * key), split by scope, includeArchived:true so the restore/delete cascade can find
 * members the archive step already hid.
 */

function actor(user: AdapterPrincipal): Actor {
  // Map the platform Role onto the model-service Actor (human, never an agent), preserving
  // domain_admin so the shared edit-scope rule grants it in-domain manage rights; only the
  // base creator collapses to 'user'. Same mapping every science route uses.
  const role: Actor['role'] =
    user.role === 'admin' ? 'admin'
    : user.role === 'domain_admin' ? 'domain_admin'
    : user.role === 'builder' ? 'builder'
    : 'user';
  return { id: user.id, role, domains: user.domains, isAgent: false };
}

/** Models in a scope's lane. Models are DOMAIN-scoped, so `'personal'` holds none and
 *  `'domain'` holds every model the viewer may see (their own Personal-tier models +
 *  their domains' Domain + Marketplace). Includes archived. */
function itemsInScope(user: AdapterPrincipal, scope: AdapterScope): { id: string; folder: string }[] {
  if (scope === 'personal') return [];
  return listModelsForUser({ id: user.id, domains: user.domains }, { includeArchived: true }).map(
    (m: ServiceModel) => ({ id: m.model, folder: m.folder ?? '/' }),
  );
}

const scienceAdapter: ArtifactAdapter = {
  tab: 'science',
  itemsUnderFolder: (user, scope, path): AdapterItem[] =>
    itemsInScope(user, scope)
      .filter((m) => isUnderFolder(path, m.folder))
      .map((m) => ({ id: m.id, folder: m.folder })),
  moveItem: (id, user, path) => void moveModel(id, actor(user), path),
  archiveItem: (id, user) => void setModelArchived(id, actor(user), true),
  restoreItem: (id, user) => void setModelArchived(id, actor(user), false),
  deleteItem: (id, user) => void deleteModel(id, actor(user)),
};

registerArtifactAdapter(scienceAdapter);

export { scienceAdapter };
