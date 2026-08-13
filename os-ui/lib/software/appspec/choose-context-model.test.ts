/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHOOSE_CONTEXT_TYPES,
  CHOOSE_CONTEXT_META,
  isInFolderCreateType,
  grantedSummary,
} from './choose-context-model.ts';

test('exactly the SIX Choose-Context types, in order', () => {
  assert.deepEqual(CHOOSE_CONTEXT_TYPES, ['data', 'metrics', 'files', 'knowledge', 'agents', 'connections']);
});

test('every type has a full descriptor with non-empty copy', () => {
  for (const t of CHOOSE_CONTEXT_TYPES) {
    const m = CHOOSE_CONTEXT_META[t];
    assert.equal(m.type, t);
    assert.ok(m.label.length > 0, `${t} label`);
    assert.ok(m.blurb.length > 0, `${t} blurb`);
    assert.ok(m.createLabel.length > 0, `${t} createLabel`);
  }
});

test('in-folder create types are exactly data/files/knowledge', () => {
  const inFolder = CHOOSE_CONTEXT_TYPES.filter(isInFolderCreateType);
  assert.deepEqual(inFolder, ['data', 'files', 'knowledge']);
});

test('agents + connections deep-link to their own tab', () => {
  assert.equal(CHOOSE_CONTEXT_META.agents.createMode, 'deep-link');
  assert.equal(CHOOSE_CONTEXT_META.agents.createTab, 'agents');
  assert.equal(CHOOSE_CONTEXT_META.connections.createMode, 'deep-link');
  assert.equal(CHOOSE_CONTEXT_META.connections.createTab, 'connections');
  // both carry a note explaining WHY the creator lives elsewhere
  assert.ok(CHOOSE_CONTEXT_META.agents.createNote);
  assert.ok(CHOOSE_CONTEXT_META.connections.createNote);
});

test('metrics create is derived (defined on a dataset), not a standalone create', () => {
  assert.equal(CHOOSE_CONTEXT_META.metrics.createMode, 'derived');
});

test('grantedSummary reads clearly for zero and N', () => {
  assert.match(grantedSummary(0), /Nothing granted/);
  assert.equal(grantedSummary(3), '3 already available to this app');
});
