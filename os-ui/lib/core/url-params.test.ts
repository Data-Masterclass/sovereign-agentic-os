/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSearch } from './url-params.ts';

test('adds a param to an empty query', () => {
  assert.equal(computeSearch('', { system: 'sys_1' }), 'system=sys_1');
});

test('sets, overwrites and deletes across an existing query', () => {
  assert.equal(computeSearch('?mode=edit&build=code', { build: null }), 'mode=edit');
  assert.equal(computeSearch('mode=edit', { mode: 'monitor' }), 'mode=monitor');
});

test('null or empty values remove the param', () => {
  assert.equal(computeSearch('tool=forgejo&toolPath=a/b', { tool: null, toolPath: '' }), '');
});

test('values are URL-encoded', () => {
  const out = computeSearch('', { toolTitle: 'My App · repo' });
  assert.match(out, /toolTitle=My\+App/);
  assert.equal(new URLSearchParams(out).get('toolTitle'), 'My App · repo');
});

test('is a no-op-safe pure function (never throws)', () => {
  assert.doesNotThrow(() => computeSearch('a=b&c', { c: null, d: 'e' }));
});
