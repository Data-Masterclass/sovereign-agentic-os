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
  listPersonalKnowledge,
  moveKnowledge,
  archivePersonalKnowledge,
  unarchivePersonalKnowledge,
  deletePersonalKnowledge,
} from '@tabs/knowledge/lib/personal-store';

/**
 * The Knowledge tab's binding to the shared folder lifecycle. Personal knowledge is
 * the only foldered lane in Knowledge (My knowledge); a Shared entry lives in the
 * `domain` lane. Thin — wraps the store's per-item ops, each already edit-scoped +
 * throwing 403 when denied, so the cascade stays fail-closed. Registered at import.
 */

function principal(user: AdapterPrincipal): Principal {
  return { id: user.id, role: user.role as Principal['role'], domains: user.domains };
}

/** Entries in a scope's lane: personal → My knowledge; domain → shared/marketplace.
 *  Includes archived. */
const ownDomain = (user: AdapterPrincipal) => (x: { domain?: string | null }): boolean => !x.domain || user.domains.includes(x.domain);

function itemsInScope(user: AdapterPrincipal, scope: AdapterScope): { id: string; folder: string }[] {
  const g = listPersonalKnowledge(principal(user), { includeArchived: true });
  // A folder cascade only ever touches items homed in the caller's own domains: a Company item from
  // another domain is VISIBLE in the list (core/kernel/company-scope) but never a member of this
  // domain's folder, whatever its path says.
  const lane = scope === 'personal' ? g.mine : [...g.domain, ...g.marketplace];
  return lane.filter(ownDomain(user)).map((e) => ({ id: e.id, folder: e.folder ?? '/' }));
}

const knowledgeAdapter: ArtifactAdapter = {
  tab: 'knowledge',
  itemsUnderFolder: (user, scope, path): AdapterItem[] =>
    itemsInScope(user, scope)
      .filter((e) => isUnderFolder(path, e.folder))
      .map((e) => ({ id: e.id, folder: e.folder })),
  moveItem: (id, user, path) => void moveKnowledge(id, principal(user), path),
  archiveItem: (id, user) => void archivePersonalKnowledge(id, principal(user)),
  restoreItem: (id, user) => void unarchivePersonalKnowledge(id, principal(user)),
  deleteItem: (id, user) => void deletePersonalKnowledge(id, principal(user)),
};

registerArtifactAdapter(knowledgeAdapter);

export { knowledgeAdapter };
