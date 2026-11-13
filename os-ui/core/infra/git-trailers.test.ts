/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    One object-attribution predicate, shared by every git read-back (X-R1, review H-2)
 * USER STORY: As a maintainer I want the whole-token `OS-Objects` match to live in ONE tested
 *             place, so that `core/infra/git-objects.ts` and a tab's own history module cannot
 *             drift — and so that a merge which rewrites one of them keeps the behaviour.
 * ARCHITECTURE: pure functions, no fixtures, no IO.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OBJECT_TRAILER,
  OBJECTS_TRAILER,
  objectListNames,
  renderObjectsTrailer,
  trailersNameObject,
} from '@core/infra/git-trailers';

test('the single-object trailer matches the bare id and the `<id> (<name>)` form', () => {
  assert.equal(trailersNameObject({ [OBJECT_TRAILER]: 'sys_a' }, 'sys_a'), true);
  assert.equal(trailersNameObject({ [OBJECT_TRAILER]: 'sys_a (Triage)' }, 'sys_a'), true);
  assert.equal(trailersNameObject({ [OBJECT_TRAILER]: 'sales' }, 'sys_a'), false);
});

test('the many-object trailer matches by WHOLE TOKEN — a prefix or an extension never matches', () => {
  const trailers = { [OBJECTS_TRAILER]: 'sys_a sys_ab sys_b' };
  assert.equal(trailersNameObject(trailers, 'sys_a'), true);
  assert.equal(trailersNameObject(trailers, 'sys_ab'), true);
  assert.equal(trailersNameObject(trailers, 'sys_'), false, 'a prefix does not match');
  assert.equal(trailersNameObject(trailers, 'sys_abc'), false, 'an extension does not match');
  assert.equal(trailersNameObject(trailers, 'ys_a'), false, 'nor an infix');
});

test('both trailers are consulted, and the single one wins early', () => {
  const trailers = { [OBJECT_TRAILER]: 'sales', [OBJECTS_TRAILER]: 'sys_a sys_b' };
  assert.equal(trailersNameObject(trailers, 'sales'), true, 'the subtree label still resolves');
  assert.equal(trailersNameObject(trailers, 'sys_b'), true, 'and so does a carried system');
  assert.equal(trailersNameObject(trailers, 'sys_c'), false);
});

test('an absent trailer, an empty list and an empty id are all simply false', () => {
  assert.equal(trailersNameObject({}, 'sys_a'), false);
  assert.equal(trailersNameObject({ [OBJECTS_TRAILER]: '' }, 'sys_a'), false);
  assert.equal(trailersNameObject({ [OBJECT_TRAILER]: 'sys_a' }, ''), false, 'an empty id matches nothing');
  assert.equal(objectListNames(undefined, 'sys_a'), false);
  assert.equal(objectListNames(null, 'sys_a'), false);
});

test('irregular spacing in the list is tolerated (git may reflow a trailer)', () => {
  assert.equal(objectListNames('  sys_a   sys_b ', 'sys_b'), true);
});

test('rendering is sorted, de-duplicated, and NAMES what it had to drop', () => {
  const { value, skipped } = renderObjectsTrailer(['sys_b', 'sys_a', 'sys_b', '']);
  assert.equal(value, 'sys_a sys_b', 'sorted and de-duplicated, so the commit is byte-stable');
  assert.deepEqual(skipped, [], 'an empty id is not a drop worth reporting');

  const bad = renderObjectsTrailer(['sys_ok', 'sys bad', 'sys\tworse']);
  assert.equal(bad.value, 'sys_ok', 'an id with whitespace cannot be written to a trailer');
  assert.deepEqual(bad.skipped, ['sys bad', 'sys\tworse'], 'and it is reported, never dropped in silence');
});

test('what is rendered is what is matched — the write and read halves agree', () => {
  const ids = ['sys_a', 'sys_ab', 'sys_zz'];
  const { value } = renderObjectsTrailer(ids);
  for (const id of ids) assert.equal(trailersNameObject({ [OBJECTS_TRAILER]: value }, id), true, id);
  assert.equal(trailersNameObject({ [OBJECTS_TRAILER]: value }, 'sys_z'), false);
});
