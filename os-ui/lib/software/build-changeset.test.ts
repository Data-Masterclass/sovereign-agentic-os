/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffTrees, summarizeChanges } from './build-changeset.ts';

test('diffTrees detects added, modified, removed and ignores unchanged', () => {
  const before = [
    { path: 'a.ts', content: 'one' },
    { path: 'b.ts', content: 'keep' },
    { path: 'gone.ts', content: 'bye' },
  ];
  const after = [
    { path: 'a.ts', content: 'two' }, // modified
    { path: 'b.ts', content: 'keep' }, // unchanged → omitted
    { path: 'new.ts', content: 'hi' }, // added
  ];
  const changes = diffTrees(before, after);
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
  assert.equal(changes.length, 3);
  assert.equal(byPath['a.ts'].kind, 'modified');
  assert.equal(byPath['a.ts'].before, 'one');
  assert.equal(byPath['a.ts'].after, 'two');
  assert.equal(byPath['new.ts'].kind, 'added');
  assert.equal(byPath['new.ts'].before, '');
  assert.equal(byPath['gone.ts'].kind, 'removed');
  assert.equal(byPath['gone.ts'].after, '');
  assert.ok(!('b.ts' in byPath), 'unchanged file omitted');
});

test('diffTrees is stable-sorted by path', () => {
  const changes = diffTrees([], [
    { path: 'z.ts', content: '1' },
    { path: 'a.ts', content: '1' },
    { path: 'm.ts', content: '1' },
  ]);
  assert.deepEqual(changes.map((c) => c.path), ['a.ts', 'm.ts', 'z.ts']);
});

test('diffTrees tolerates null/empty trees', () => {
  assert.deepEqual(diffTrees(null, null), []);
  assert.equal(diffTrees(null, [{ path: 'x', content: 'y' }])[0].kind, 'added');
  assert.equal(diffTrees([{ path: 'x', content: 'y' }], null)[0].kind, 'removed');
});

test('summarizeChanges reads naturally', () => {
  assert.equal(summarizeChanges([]), 'No files changed.');
  assert.equal(
    summarizeChanges([
      { path: 'a', kind: 'added', before: '', after: '1' },
      { path: 'b', kind: 'modified', before: '1', after: '2' },
    ]),
    '2 files changed: 1 added, 1 modified',
  );
  assert.equal(
    summarizeChanges([{ path: 'a', kind: 'removed', before: '1', after: '' }]),
    '1 file changed: 1 removed',
  );
});
