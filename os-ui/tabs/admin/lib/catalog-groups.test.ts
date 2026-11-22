/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCatalog } from '@tabs/admin/lib/catalog-groups';

test('models in LiteLLM\'s database are removable; config-set models stay managed', () => {
  const split = splitCatalog([
    { model_name: 'sovereign-default', management: 'config' },
    { model_name: 'my-cloud-llm', management: 'database' },
    { model_name: 'legacy-no-flag' }, // absent → fail-safe managed
  ]);
  assert.deepEqual(split.adminAdded, ['my-cloud-llm']);
  assert.deepEqual(split.managed, ['legacy-no-flag', 'sovereign-default']);
});

test('an alias served by the config file AND the database is managed (the config part cannot be removed)', () => {
  const split = splitCatalog([{ model_name: 'both', management: 'mixed' }]);
  assert.deepEqual(split.adminAdded, []);
  assert.deepEqual(split.managed, ['both']);
});

test('each name once, sorted; nothing is invented from anywhere but LiteLLM\'s list', () => {
  const split = splitCatalog([{ model_name: 'b-live', management: 'database' }, { model_name: 'a-seed', management: 'config' }, { model_name: 'b-live', management: 'database' }]);
  assert.deepEqual(split.adminAdded, ['b-live']);
  assert.deepEqual(split.managed, ['a-seed']);
  assert.deepEqual(splitCatalog([]), { managed: [], adminAdded: [] });
});
