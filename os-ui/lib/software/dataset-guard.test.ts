/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * dataset-guard (0.6.114) — the EXISTS-vs-DELETED classifier must peek the real DATASET
 * store, not the artifacts registry (which never holds `ds_…` ids). Before the fix, a LIVE
 * dataset referenced-but-ungranted was falsely warned "NO LONGER EXIST (likely deleted)".
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createDataset, type Principal } from '../data/store.ts';
import { ungrantedDatasetWarningForApp } from './dataset-guard.ts';
import type { App } from './apps.ts';
import type { ScaffoldFile } from './model.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };

beforeEach(() => __resetStore());

/** A minimal App the guard reads — it only touches `grants.data`. */
function appGranting(dataIds: string[]): App {
  return { grants: { data: dataIds.map((id) => ({ id })) } } as unknown as App;
}

test('a LIVE, ungranted dataset resolves to its NAME — not the "deleted" warning', () => {
  const live = createDataset(amir, { name: 'Service Centers' }).id;
  const files: ScaffoldFile[] = [
    { path: 'src/epics/e/s/data.ts', content: `os.datasets.get('${live}');` },
  ];
  // App grants nothing, so the live id IS ungranted → warning should NAME it, EXISTS branch.
  const warning = ungrantedDatasetWarningForApp(appGranting([]), files);
  return warning.then((w) => {
    assert.match(w, /Service Centers/, 'the live dataset resolves to its display name');
    assert.match(w, /is NOT granted/, 'classified as EXISTS-but-ungranted (grant it)');
    assert.doesNotMatch(w, /NO LONGER EXIST/, 'a live dataset is NEVER flagged deleted');
  });
});

test('a truly-absent dataset id IS flagged "NO LONGER EXIST (likely deleted)"', async () => {
  const files: ScaffoldFile[] = [
    { path: 'src/epics/e/s/data.ts', content: "os.datasets.get('ds_gonef0rever');" },
  ];
  const w = await ungrantedDatasetWarningForApp(appGranting([]), files);
  assert.match(w, /NO LONGER EXIST/, 'a genuinely absent id is the deleted branch');
  assert.match(w, /ds_gonef0rever/, 'names the missing id');
});
