/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Metrics binding to the shared folder lifecycle
 * USER STORY: As a creator I want to move, archive, restore and delete metrics with folder actions like
 *             any other artifact, so that folders behave the same in every tab.
 * ARCHITECTURE:
 *   - Registers `metricsAdapter` with `@core/kernel/artifact-adapter` on import; loaded by
 *     `core/folders/adapters.ts`.
 *   - A metric has no store row of its own, so folder path and archive flag live in the lifecycle
 *     overlay (`./lifecycle.ts`), keyed by `datasetId.measure`. Every op is edit-scoped and throws
 *     403 when denied, so a folder cascade fails closed.
 *   - Delete is physical (`deleteMetric`); folder delete still applies only to archived items.
 */
import {
  registerArtifactAdapter,
  type ArtifactAdapter,
  type AdapterItem,
  type AdapterPrincipal,
  type AdapterScope,
} from '@core/kernel/artifact-adapter';
import { isUnderFolder } from '@core/kernel/folders';
import type { Principal } from '@tabs/data/lib/store';
import { listMetrics } from '@tabs/metrics/lib/store';
import {
  moveMetric,
  archiveMetric,
  unarchiveMetric,
  deleteMetric,
} from '@tabs/metrics/lib/lifecycle';

function principal(user: AdapterPrincipal): Principal {
  return { id: user.id, role: user.role as Principal['role'], domains: user.domains };
}

/** Metrics in a scope's lane: personal → `mine`; domain → shared + marketplace.
 *  Includes archived. */
function itemsInScope(user: AdapterPrincipal, scope: AdapterScope): { id: string; folder: string }[] {
  const g = listMetrics(principal(user), { includeArchived: true });
  const lane = scope === 'personal' ? g.mine : [...g.domain, ...g.marketplace];
  return lane.map((m) => ({ id: m.id, folder: m.folder }));
}

const metricsAdapter: ArtifactAdapter = {
  tab: 'metrics',
  itemsUnderFolder: (user, scope, path): AdapterItem[] =>
    itemsInScope(user, scope)
      .filter((m) => isUnderFolder(path, m.folder))
      .map((m) => ({ id: m.id, folder: m.folder })),
  moveItem: (id, user, path) => void moveMetric(id, principal(user), path),
  archiveItem: (id, user) => void archiveMetric(id, principal(user)),
  restoreItem: (id, user) => void unarchiveMetric(id, principal(user)),
  deleteItem: (id, user) => void deleteMetric(id, principal(user)),
};

registerArtifactAdapter(metricsAdapter);

export { metricsAdapter };
