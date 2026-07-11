/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestTools, suggestToolNames } from './suggest-tools.ts';

const CATALOG = [
  'query_data', 'list_datasets', 'profile_dataset', 'query_metric', 'list_metrics',
  'search_knowledge', 'search_files', 'get_file', 'upload_file', 'list_connections',
];

test('an analyst role suggests the data tools', () => {
  const names = suggestToolNames('Analyzes sources and explains the data', CATALOG);
  assert.ok(names.includes('query_data'), 'query_data suggested');
  assert.ok(names.includes('list_datasets'), 'list_datasets suggested');
  assert.ok(names.includes('profile_dataset'), 'profile_dataset suggested');
});

test('a knowledge/rules role suggests search_knowledge', () => {
  const names = suggestToolNames('Answers questions from company policy and rules', CATALOG);
  assert.ok(names.includes('search_knowledge'), 'search_knowledge suggested');
});

test('a writer role suggests upload_file to save output', () => {
  const names = suggestToolNames('Drafts and produces a written report to deliver', CATALOG);
  assert.ok(names.includes('upload_file'), 'upload_file suggested');
});

test('results are de-duplicated and carry a plain-language reason', () => {
  const s = suggestTools('data data data analysis metric report', CATALOG);
  const names = s.map((x) => x.tool);
  assert.equal(new Set(names).size, names.length, 'no duplicate tools');
  for (const x of s) assert.ok(x.why.length > 0, `${x.tool} has a reason`);
});

test('suggestions are intersected with the available catalog (never grants above floor)', () => {
  // A creator whose catalog excludes query_data must not be offered it.
  const limited = CATALOG.filter((t) => t !== 'query_data');
  const names = suggestToolNames('Analyzes the data and queries it', limited);
  assert.ok(!names.includes('query_data'), 'unavailable tool is not suggested');
  assert.ok(names.includes('list_datasets'), 'still suggests an available data tool');
});

test('an agent with no keyword hit still gets a useful default (search_knowledge)', () => {
  const names = suggestToolNames('zzz qqq', CATALOG);
  assert.deepEqual(names, ['search_knowledge']);
});

test('the default floor is skipped when search_knowledge is not available', () => {
  const names = suggestToolNames('zzz qqq', ['upload_file']);
  assert.deepEqual(names, []);
});

test('suggestions follow a stable catalogue order (query_data before search_knowledge)', () => {
  const names = suggestToolNames('analyze the data and search the knowledge base', CATALOG);
  assert.ok(names.indexOf('query_data') < names.indexOf('search_knowledge'), 'stable order');
});
