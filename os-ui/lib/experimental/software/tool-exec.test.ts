/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolOperation, fillPathParams, seedToolResult, DEMO_SEED_NOTE } from './tool-exec.ts';
import { defaultOpenApi } from './metadata.ts';

/**
 * App tool-call honesty: when the runner is not live the result must be
 * LABELLED demo seed (source + visible note), never presented as the app's
 * answer; and a live proxy must resolve the tool to its real REST operation
 * from the app's committed OpenAPI.
 */

const files = [{ path: 'openapi.yaml', content: defaultOpenApi('demo-app') }];

test('resolveToolOperation maps operationIds from the committed OpenAPI to REST ops', () => {
  assert.deepEqual(resolveToolOperation(files, 'list_records'), { method: 'GET', path: '/records' });
  assert.deepEqual(resolveToolOperation(files, 'get_record'), { method: 'GET', path: '/records/{id}' });
  assert.deepEqual(resolveToolOperation(files, 'add_record'), { method: 'POST', path: '/records' });
  assert.equal(resolveToolOperation(files, 'nonexistent_tool'), null, 'unknown tool → no op (demo fallback)');
  assert.equal(resolveToolOperation([], 'list_records'), null, 'no spec → no op');
});

test('fillPathParams substitutes template params from the call args', () => {
  assert.equal(fillPathParams('/records/{id}', { id: 'r1' }), '/records/r1');
  assert.equal(fillPathParams('/records/{id}', {}), '/records/');
  assert.equal(fillPathParams('/records', { id: 'r1' }), '/records');
});

test('seedToolResult is ALWAYS labelled demo-seed with a visible note (any app, any tool)', () => {
  for (const tool of ['list_records', 'get_record', 'add_record', 'export_records', 'list_renewals', 'anything_else']) {
    const r = seedToolResult(tool, { id: 'r1' });
    assert.equal(r.source, 'demo-seed', `${tool} is labelled`);
    assert.equal(r.note, DEMO_SEED_NOTE, `${tool} carries the honest note`);
  }
  // Shapes stay useful for the demo flow.
  assert.ok(Array.isArray(seedToolResult('list_records').items));
  assert.ok(seedToolResult('get_record', { id: 'r1' }).item);
  assert.ok(seedToolResult('add_record', { name: 'X' }).added);
});
