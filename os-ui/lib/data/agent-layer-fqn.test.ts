/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  createDataset,
  buildVersion,
  getDataset,
  builtLayerFqn,
  type Principal,
} from './store.ts';

/**
 * The agent DATA-grant layer choice takes effect through {@link builtLayerFqn}: the
 * discovery tool (`get_dataset` / `profile_dataset`) resolves the granted layer to a
 * physical medallion FQN, with a graceful fallback to the furthest built layer when the
 * requested one isn't built. These lock that resolution + fallback for the agent path.
 */

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };

beforeEach(() => __resetStore());

test('builtLayerFqn targets the requested built layer (the grant’s medallion choice)', () => {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql' });

  const silver = builtLayerFqn(getDataset(d.id, amir), amir, 'silver');
  assert.ok(silver);
  assert.equal(silver!.layer, 'silver');
  assert.match(silver!.fqn, /^iceberg\.personal_amir\.silver_orders$/);

  const bronze = builtLayerFqn(getDataset(d.id, amir), amir, 'bronze');
  assert.equal(bronze!.layer, 'bronze');
  assert.match(bronze!.fqn, /^iceberg\.personal_amir\.bronze_orders$/);
});

test('not-built fallback: a silver request on a bronze-only dataset resolves to bronze', () => {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });

  // The team was granted `silver`, but silver isn't built — fall back to the furthest
  // built layer (bronze) rather than crash / TABLE_NOT_FOUND.
  const resolved = builtLayerFqn(getDataset(d.id, amir), amir, 'silver');
  assert.ok(resolved, 'a built layer still resolves');
  assert.equal(resolved!.layer, 'bronze', 'fell back to the furthest built layer');
  assert.match(resolved!.fqn, /bronze_orders$/);
});

test('nothing built → null (get_dataset then reports layer-not-built, no doomed FQN)', () => {
  const d = createDataset(amir, { name: 'Draft' });
  assert.equal(builtLayerFqn(getDataset(d.id, amir), amir, 'gold'), null);
});
