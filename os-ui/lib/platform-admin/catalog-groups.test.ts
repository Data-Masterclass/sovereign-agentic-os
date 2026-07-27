/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCatalog } from './catalog-groups.ts';

const EP = { baseUrl: 'https://x/v1', modelName: 'up', keyRef: { name: 'n', key: 'k' }, fingerprint: 'f' };

test('live db-registered models are administrator-added; config-seeded stay managed', () => {
  const split = splitCatalog(
    [
      { model_name: 'sovereign-default', dbModel: false },
      { model_name: 'my-cloud-llm', dbModel: true },
      { model_name: 'legacy-no-flag' }, // absent flag → fail-safe managed
    ],
    [],
  );
  assert.deepEqual(split.adminAdded, ['my-cloud-llm']);
  assert.deepEqual(split.managed, ['legacy-no-flag', 'sovereign-default']);
});

test('governance-only models (gateway offline): endpoint presence decides', () => {
  const split = splitCatalog(
    [],
    [
      { id: 'sovereign-default' }, // chart seed — no endpoint
      { id: 'my-cloud-llm', endpoint: EP }, // wizard-registered
    ],
  );
  assert.deepEqual(split.adminAdded, ['my-cloud-llm']);
  assert.deepEqual(split.managed, ['sovereign-default']);
});

test('the live gateway is authoritative over the governed mark', () => {
  // A live row saying "seeded" wins even if the catalog record carries an endpoint
  // (an alias collision with deployment config must never become removable).
  const split = splitCatalog(
    [{ model_name: 'clash', dbModel: false }],
    [{ id: 'clash', endpoint: EP }],
  );
  assert.deepEqual(split.adminAdded, []);
  assert.deepEqual(split.managed, ['clash']);
});

test('union of live + governed names, each exactly once, sorted', () => {
  const split = splitCatalog(
    [{ model_name: 'b-live', dbModel: true }, { model_name: 'a-seed', dbModel: false }],
    [{ id: 'b-live', endpoint: EP }, { id: 'c-catalog-only', endpoint: EP }],
  );
  assert.deepEqual(split.adminAdded, ['b-live', 'c-catalog-only']);
  assert.deepEqual(split.managed, ['a-seed']);
});
