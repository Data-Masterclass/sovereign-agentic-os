/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toolsForGrant,
  allToolsForKind,
  capabilityWrites,
  presetForCapability,
  strongestPreset,
} from './capability-tools.ts';

test('Read grants provision only read + discovery tools', () => {
  assert.deepEqual(toolsForGrant('data', 'Read'), ['query_data', 'list_datasets', 'get_dataset', 'profile_dataset']);
  assert.deepEqual(toolsForGrant('files', 'Read'), ['list_files', 'search_files', 'get_file']);
  // no write tool leaks into a Read grant
  assert.ok(!toolsForGrant('knowledge', 'Read').includes('author_knowledge'));
});

test('Write grants add the create/write tools on top of read', () => {
  for (const cap of ['Write-approval', 'Write-bounded'] as const) {
    const data = toolsForGrant('data', cap);
    assert.ok(data.includes('query_data') && data.includes('create_dataset') && data.includes('ingest_dataset'));
    assert.ok(toolsForGrant('knowledge', cap).includes('author_knowledge'));
    assert.ok(toolsForGrant('files', cap).includes('upload_file'));
    assert.ok(toolsForGrant('connections', cap).includes('create_connection'));
  }
});

test('Off / Blocked provision nothing', () => {
  assert.deepEqual(toolsForGrant('data', 'Off'), []);
  assert.deepEqual(toolsForGrant('files', 'Blocked'), []);
});

test('promotion / lifecycle tools are never auto-provisioned', () => {
  const all = (['data', 'knowledge', 'connections'] as const).flatMap((k) => toolsForGrant(k, 'Write-bounded'));
  for (const forbidden of ['request_promotion', 'approve_promotion', 'publish_knowledge', 'retire_knowledge', 'promote_connection']) {
    assert.ok(!all.includes(forbidden), `${forbidden} must not be auto-granted`);
  }
});

test('capabilityWrites: only the two write levels', () => {
  assert.equal(capabilityWrites('Read'), false);
  assert.equal(capabilityWrites('Write-approval'), true);
  assert.equal(capabilityWrites('Write-bounded'), true);
  assert.equal(capabilityWrites('Off'), false);
});

test('presetForCapability maps to the run-time posture', () => {
  assert.equal(presetForCapability('Read'), 'read-only');
  assert.equal(presetForCapability('Write-approval'), 'read-propose');
  assert.equal(presetForCapability('Write-bounded'), 'full-in-scope');
});

test('strongestPreset picks the most permissive; empty ⇒ read-only', () => {
  assert.equal(strongestPreset([]), 'read-only');
  assert.equal(strongestPreset(['read-only', 'read-propose']), 'read-propose');
  assert.equal(strongestPreset(['read-propose', 'full-in-scope', 'read-only']), 'full-in-scope');
});

test('allToolsForKind covers read ∪ write for pruning', () => {
  const data = allToolsForKind('data');
  assert.ok(data.includes('query_data') && data.includes('create_dataset'));
  assert.equal(new Set(data).size, data.length); // deduped
});
