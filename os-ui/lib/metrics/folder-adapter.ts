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
import type { Principal } from '../data/store.ts';
import { listMetrics } from './store.ts';
import {
  moveMetric,
  archiveMetric,
  unarchiveMetric,
  deleteMetric,
} from './lifecycle.ts';

/**
 * The Metrics tab's binding to the shared folder lifecycle. A metric is a MEASURE on a
 * governed dataset — it has no store row of its own — so its folder path + archive flag
 * ride the metric lifecycle OVERLAY (`lib/metrics/lifecycle.ts`), keyed by metric id
 * (`datasetId.measure`). Otherwise this is the same thin adapter as every other tab:
 * each op is edit-scoped (throws 403 when denied) so the cascade stays fail-closed.
 *
 * NOTE: metric DELETE is PHYSICAL (`deleteMetric` de-registers the Cube measure) — the
 * archive→delete discipline still holds (delete of a folder is archived-only), but a
 * deleted metric drops from `/api/cube/models` exactly as the tab's own delete does.
 */

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
