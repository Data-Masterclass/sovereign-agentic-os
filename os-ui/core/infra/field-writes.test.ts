/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Unit tests for the shared "send only what changed" store write
 * USER STORY: As a maintainer I want the one mechanism every store relies on to be pinned on its
 *             own: what counts as changed, what a merge keeps, and that the worker never upserts.
 * ARCHITECTURE:
 *   - Pure functions are tested directly; the mirror-facing ones against the shared fake cluster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osMirror } from '@core/infra/os-mirror';
import { changedPatch, mergeChanged, newSeenFields, noteSeen, fingerprint, writeChanged, writeNew } from '@core/infra/field-writes';
import { fakeCluster, settle } from '@core/infra/two-process-fixture';
import { markRunWorkerProcess, __clearRunWorkerProcess } from '@core/kernel/process-role';

test('changedPatch sends only the fields that differ from what this process last saw', () => {
  const seen = newSeenFields();
  noteSeen(seen, 'r1', { id: 'r1', name: 'A', tags: ['x'], note: 'n' });
  const patch = changedPatch(seen, 'r1', { id: 'r1', name: 'B', tags: ['x'] });
  assert.deepEqual(patch, { set: { name: 'B' }, unset: ['note'] });
});

test('changedPatch with no memory of the record sends every present field', () => {
  assert.deepEqual(changedPatch(newSeenFields(), 'r1', { id: 'r1', name: 'A' }), { set: { id: 'r1', name: 'A' }, unset: [] });
});

test('mergeChanged keeps ours for what we changed and the newest copy for the rest', () => {
  const base = new Map(Object.entries({ name: 'A', description: '', checks: [] }).map(([k, v]) => [k, fingerprint(v)]));
  const ours = { name: 'A', description: 'documented', checks: [] };
  const newest = { name: 'A (renamed)', description: '', checks: [{ id: 'c1' }] };
  assert.deepEqual(mergeChanged(base, ours, newest), { name: 'A (renamed)', description: 'documented', checks: [{ id: 'c1' }] });
});

test('in the run worker a partial write never re-creates a missing record; elsewhere it upserts', async () => {
  const os = fakeCluster();
  const mirror = osMirror({ index: 'os-field-writes-test' });
  mirror.__reset();
  try {
    const seen = newSeenFields();
    writeNew(mirror, seen, 'r1', { id: 'r1', name: 'A' });
    await settle();
    await fetch(`${(await import('@core/adapters/opensearch/client')).opensearchBaseUrl()}/os-field-writes-test/_doc/r1`, { method: 'DELETE' });

    markRunWorkerProcess();
    writeChanged(mirror, seen, 'r1', { id: 'r1', name: 'B' });
    await settle();
    assert.equal(os.doc('os-field-writes-test', 'r1'), undefined, 'the worker did not re-create the record');

    __clearRunWorkerProcess();
    writeChanged(mirror, seen, 'r1', { id: 'r1', name: 'C' });
    await settle();
    assert.deepEqual(os.doc('os-field-writes-test', 'r1'), { id: 'r1', name: 'C' }, 'os-ui upserts the whole record');
  } finally {
    __clearRunWorkerProcess();
    os.restore();
    mirror.__reset();
  }
});
