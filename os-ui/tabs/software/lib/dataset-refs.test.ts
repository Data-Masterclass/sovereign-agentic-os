/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  referencedDatasetIds,
  ungrantedDatasetRefs,
  ungrantedDatasetWarning,
} from './dataset-refs.ts';

// referencedDatasetIds finds ids across the concrete reference shapes, once each.
test('referencedDatasetIds: finds query/get/const-literal ids, de-duplicated', () => {
  const files = [
    { path: 'src/epics/e/s/Page.tsx', content: "const r = await os.datasets.query('ds_09qqomar3y', { nl: 'x' });" },
    { path: 'src/epics/e/s/data.ts', content: "const CENTERS_DS = 'ds_zpco1s6n7y';\nos.datasets.get(CENTERS_DS);" },
    { path: 'src/dup.ts', content: "os.datasets.query('ds_09qqomar3y')" }, // same id again
  ];
  const ids = referencedDatasetIds(files);
  assert.deepEqual(ids.sort(), ['ds_09qqomar3y', 'ds_zpco1s6n7y']);
});

// It ignores lockfiles and non-source assets (no incidental substrings).
test('referencedDatasetIds: ignores lockfiles and non-scannable paths', () => {
  const files = [
    { path: 'package-lock.json', content: '"integrity": "ds_09qqomar3y-lookalike"' },
    { path: 'logo.png', content: 'ds_zpco1s6n7y' },
  ];
  assert.deepEqual(referencedDatasetIds(files), []);
});

// A short `ds_x`-style token is NOT mistaken for a real id.
test('referencedDatasetIds: does not match short non-id tokens', () => {
  const files = [{ path: 'a.ts', content: 'const ds_x = 1; // not an id' }];
  assert.deepEqual(referencedDatasetIds(files), []);
});

// ungrantedDatasetRefs: catches an ungranted id and PASSES a granted one.
test('ungrantedDatasetRefs: flags an ungranted id, allows a granted id', () => {
  const files = [
    { path: 'src/a.tsx', content: "os.datasets.query('ds_granted01', {})" },
    { path: 'src/b.tsx', content: "os.datasets.query('ds_ungrant9x', {})" },
  ];
  const out = ungrantedDatasetRefs(files, ['ds_granted01']);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'ds_ungrant9x');
  assert.deepEqual(out[0].files, ['src/b.tsx']);
});

test('ungrantedDatasetRefs: empty when every referenced dataset is granted', () => {
  const files = [{ path: 'src/a.tsx', content: "os.datasets.query('ds_granted01', {})" }];
  assert.deepEqual(ungrantedDatasetRefs(files, ['ds_granted01']), []);
});

// CASE 1 — EXISTS but ungranted: the warning names it + says "grant".
test('ungrantedDatasetWarning: EXISTING dataset ⇒ named + grant advice', () => {
  const refs = ungrantedDatasetRefs(
    [{ path: 'src/b.tsx', content: "os.datasets.query('ds_09qqomar3y', {})" }],
    [],
  );
  const named = ungrantedDatasetWarning(refs, { names: { ds_09qqomar3y: 'Service Centers' } });
  assert.match(named, /«Service Centers» \(ds_09qqomar3y\)/);
  assert.match(named, /not granted/i);
  assert.match(named, /Grant/);
  assert.doesNotMatch(named, /no longer exist/i);
});

// CASE 2 — DELETED/nonexistent: the warning says "no longer exist" + rebuild/restore,
// and must NOT tell the user to grant it.
test('ungrantedDatasetWarning: DELETED dataset ⇒ rebuild/restore, NOT grant', () => {
  const refs = ungrantedDatasetRefs(
    [{ path: 'src/b.tsx', content: "os.datasets.query('ds_09qqomar3y', {})" }],
    [],
  );
  const gone = ungrantedDatasetWarning(refs, { deletedIds: ['ds_09qqomar3y'] });
  assert.match(gone, /ds_09qqomar3y/);
  assert.match(gone, /no longer exist|deleted/i);
  assert.match(gone, /rebuild|restore/i);
  assert.doesNotMatch(gone, /Grant each in Context/);
});

// A mixed batch reports BOTH sections distinctly.
test('ungrantedDatasetWarning: mixed exists + deleted ⇒ both sections', () => {
  const refs = ungrantedDatasetRefs(
    [
      { path: 'a.tsx', content: "os.datasets.query('ds_exists01', {})" },
      { path: 'b.tsx', content: "os.datasets.query('ds_deleted9', {})" },
    ],
    [],
  );
  const msg = ungrantedDatasetWarning(refs, { names: { ds_exists01: 'Live One' }, deletedIds: ['ds_deleted9'] });
  assert.match(msg, /«Live One» \(ds_exists01\)/);
  assert.match(msg, /Grant each in Context/);
  assert.match(msg, /ds_deleted9/);
  assert.match(msg, /no longer exist/i);

  // No violations ⇒ no message.
  assert.equal(ungrantedDatasetWarning([]), '');
});
