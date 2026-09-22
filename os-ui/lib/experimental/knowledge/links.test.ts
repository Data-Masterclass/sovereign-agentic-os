/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkflowLinks, filterVisibleLinks, EMPTY_LINKS } from './links.ts';

test('normalizeWorkflowLinks accepts a well-formed body and dedupes/trims', () => {
  const out = normalizeWorkflowLinks({ datasets: ['ds_1', ' ds_1 ', 'ds_2', ''], metrics: ['ds_1.revenue'] });
  assert.deepEqual(out, { datasets: ['ds_1', 'ds_2'], metrics: ['ds_1.revenue'] });
});

test('normalizeWorkflowLinks defaults a missing side to empty', () => {
  assert.deepEqual(normalizeWorkflowLinks({ datasets: ['ds_1'] }), { datasets: ['ds_1'], metrics: [] });
  assert.deepEqual(normalizeWorkflowLinks({}), EMPTY_LINKS);
});

test('normalizeWorkflowLinks rejects malformed shapes', () => {
  assert.equal(normalizeWorkflowLinks(null), null);
  assert.equal(normalizeWorkflowLinks('nope'), null);
  assert.equal(normalizeWorkflowLinks(['ds_1']), null);
  assert.equal(normalizeWorkflowLinks({ datasets: 'ds_1' }), null);
  assert.equal(normalizeWorkflowLinks({ datasets: [1, 2] }), null);
  assert.equal(normalizeWorkflowLinks({ metrics: [{ id: 'x' }] }), null);
});

test('filterVisibleLinks silently drops ids the caller cannot view', () => {
  const links = { datasets: ['ds_ok', 'ds_secret'], metrics: ['ds_ok.rev', 'ds_secret.margin'] };
  const out = filterVisibleLinks(links, (_kind, id) => !id.includes('secret'));
  assert.deepEqual(out, { datasets: ['ds_ok'], metrics: ['ds_ok.rev'] });
});

test('filterVisibleLinks keeps everything when all ids resolve', () => {
  const links = { datasets: ['a'], metrics: ['a.m'] };
  assert.deepEqual(filterVisibleLinks(links, () => true), links);
});
