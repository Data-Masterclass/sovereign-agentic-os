/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Data-tab delete guard protects a sibling's WHOLE footprint, not its built layers
 * USER STORY: As an owner deleting a dataset I want no table another dataset (archived too) maps
 *             to dropped — even a layer its record does not list as built — because with
 *             purge-on-drop a drop deletes that dataset's files for good.
 * ARCHITECTURE:
 *   - Pure: the plan functions on records; the drop itself is proven in tests/domain-delete.
 *   - Negative twin: the old built-layers rule (`dropPlan`) would leave bronze unprotected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropPlan, sharedFootprintFqns } from '@tabs/data/lib/physical-delete';
import type { Dataset } from '@tabs/data/lib/dataset-schema';

const ds = (id: string, domain: string, built: { bronze: boolean; silver: boolean; gold: boolean }): Dataset & { archived?: boolean } =>
  ({
    id, name: 'service_centers', owner: 'aborek', domain, tier: 'asset',
    versions: { bronze: { built: built.bronze }, silver: { built: built.silver }, gold: { built: built.gold } },
  }) as unknown as Dataset;

test('an archived sibling whose record lists only silver+gold still protects its bronze lane table', () => {
  const target = ds('ds_k', 'kiekert', { bronze: true, silver: true, gold: true });
  const sibling = { ...ds('ds_q3', 'q3', { bronze: false, silver: true, gold: true }), archived: true };
  const prot = sharedFootprintFqns(target, [target, sibling]);
  for (const l of ['bronze', 'silver', 'gold']) assert.ok(prot.has(`iceberg.personal_aborek.${l}_service_centers`), l);
  // twin: the built-layers-only rule would drop the sibling's bronze
  const builtOnly = new Set(dropPlan(sibling).map((d) => d.fqn));
  assert.equal(builtOnly.has('iceberg.personal_aborek.bronze_service_centers'), false);
  const drops = dropPlan(target).filter((d) => !prot.has(d.fqn)).map((d) => d.fqn);
  assert.ok(!drops.includes('iceberg.personal_aborek.bronze_service_centers'));
});
